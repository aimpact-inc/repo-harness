import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';

import { copyPackageRuntimeFixture, writeShellExecutableFixture } from '../helpers/repo-fixture';
import { startFakeHcRelease, writeFakeHc } from '../helpers/fake-hc';
import { HC_MIN_VERSION } from '../../src/core/terminal/herdr-pin';
import { installStateFixturePath, recordPluginSelection, seedGlobalPackageFixture } from '../helpers/install-ownership';
import { buildManagedHooks } from '../../src/cli/installer/managed-entries';
import { beginInstallHostTransaction, commitInstallHostTransaction, readInstallState, retiredAgentRecordCheck, versions, rollbackInstallHostTransaction } from '../../src/cli/installer/install-profile';
import { planInstallStateMigration } from '../../src/cli/installer/install-state-migration';
import { runUserUninstall } from '../../src/cli/installer/uninstall';
import {
  assertCandidateReconciliationReceipt,
  assertInstalledAdapterProjection,
  candidatePackageIdentity,
  encodeCandidateRequest,
  installedAdapterProjectionDigest,
  managedProjectionDigest,
  parseCandidateReceipt,
  publishCandidateReconciliationCapability,
  routeRegistryDigest,
  type CandidatePackageIdentity,
  type CandidateReconciliationRequest,
  type CandidateReconciliationReceipt,
} from '../../src/cli/commands/candidate-reconciliation';
import { sha256Hex, sha256Prefixed } from '../../src/core/evidence/sha256';
import { EMPTY_LEDGER, HostConfigError } from '../../src/core/host-config/types';
import { globalRuntimeScope, runtimeTransactionRoot } from '../../src/effects/locking/runtime-transaction-lock';
import { openHostConfigGate, planPathRevertEntry } from '../../src/effects/host-config/gate';
import { pathRecordKey, readPathRecords } from '../../src/effects/host-config/path-records';
import { hostConfigPaths, projectedLedgerPaths, readLedger, vaultPath, writeLedger } from '../../src/effects/host-config/store';
import { observeEntryIdentity } from '../../src/effects/host-config/whole-path';
import { acquireExclusiveDirectoryLock } from '../../src/effects/locking/exclusive-directory-lock';

const ROOT = join(import.meta.dir, '..', '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

// The update runs the Herdr skill step, which spawns `hc` from PATH; a fake hc first on PATH keeps the developer's hc out of every test.
const fakeHcBin = realpathSync(mkdtempSync(join(tmpdir(), 'repo-harness-candidate-runtime-hc-')));
const pathBeforeFakeHc = process.env.PATH;
const previousBunInstall = process.env.BUN_INSTALL;
const previousHome = process.env.HOME;
beforeAll(() => {
  process.env.HOME = fakeHcBin;
  writeFakeHc(fakeHcBin);
  process.env.PATH = `${fakeHcBin}:${pathBeforeFakeHc ?? ''}`;
  process.env.BUN_INSTALL = join(fakeHcBin, '.bun');
  seedGlobalPackageFixture();
});
afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  process.env.PATH = pathBeforeFakeHc;
  if (previousBunInstall === undefined) delete process.env.BUN_INSTALL;
  else process.env.BUN_INSTALL = previousBunInstall;
  rmSync(fakeHcBin, { recursive: true, force: true });
});

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function copyRuntimeFixture(
  destination: string,
  version: string,
  stopTimeout: 30 | 150,
  legacyParent = false,
): string {
  copyPackageRuntimeFixture(ROOT, destination);
  const manifestPath = join(destination, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { version?: string };
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const managedEntriesPath = join(destination, 'src', 'cli', 'installer', 'managed-entries.ts');
  const managedEntries = readFileSync(managedEntriesPath, 'utf-8');
  const authority = "timeout: 30";
  if (!managedEntries.includes(authority)) throw new Error('fixture requires the managed Stop timeout authority');
  if (stopTimeout === 150) {
    writeFileSync(managedEntriesPath, managedEntries.replace(
      authority,
      "timeout: route.event === 'Stop' ? 150 : 30",
    ));
  }
  if (legacyParent) {
    const globalRuntimePath = join(destination, 'src', 'cli', 'commands', 'global-runtime.ts');
    const globalRuntime = readFileSync(globalRuntimePath, 'utf-8');
    const frozenLegacy = globalRuntime.replace(
      "if (updateMode && install.status === 'ok' && opts.installSpec && opts.candidateHandoff) {",
      'if (false) {',
    );
    if (frozenLegacy === globalRuntime) throw new Error('fixture requires the candidate handoff branch');
    writeFileSync(globalRuntimePath, frozenLegacy);
  }
  symlinkSync(join(ROOT, 'node_modules'), join(destination, 'node_modules'), 'dir');
  return destination;
}

function writeCandidateSwitchingBun(
  temporaryRoot: string,
  path: string,
  logPath: string,
  globalPackagePath: string,
  candidateRoot: string,
  replacedPredecessorAsset?: string,
  runFleet = false,
): void {
  const canonicalCandidateRoot = realpathSync(candidateRoot);
  const candidateVersion = JSON.parse(readFileSync(join(candidateRoot, 'package.json'), 'utf-8')).version;
  // Bun replaces package files in place; the predecessor then sees assets it cannot parse.
  const replaceAsset = replacedPredecessorAsset ? `printf '{}' > "${replacedPredecessorAsset}"; ` : '';
  writeShellExecutableFixture(temporaryRoot, path, [
    '#!/bin/bash',
    `printf '%s\\n' "$*" >> "${logPath}"`,
    'if [[ "${1:-}" == "--version" ]]; then echo 1.4.0; exit 0; fi',
    `if [[ "\${1:-}" == "pm" && "\${2:-}" == "view" ]]; then printf '%s\\n' '${JSON.stringify(candidateVersion)}'; exit 0; fi`,
    `if [[ "\${1:-}" == add && "\${2:-}" == -g && "\${3:-}" == archctx@* ]]; then mkdir -p "$BUN_INSTALL/bin" "$BUN_INSTALL/install/global/node_modules"; ln -sfn "${candidateRoot}/node_modules/archctx" "$BUN_INSTALL/install/global/node_modules/archctx"; ln -s "$BUN_INSTALL/install/global/node_modules/archctx/bin/archctx.mjs" "$BUN_INSTALL/bin/archctx"; exit 0; fi`,
    `if [[ "$1" == "add" && "$2" == "-g" ]]; then ${replaceAsset}rm -rf "${globalPackagePath}"; ln -s "${candidateRoot}" "${globalPackagePath}"; exit 0; fi`,
    `if [[ "$1" == "${canonicalCandidateRoot}/src/cli/index.ts" || "$1" == "${globalPackagePath}/src/cli/index.ts" ]]; then exec "${process.execPath}" "$@"; fi`,
    ...(runFleet ? [`if [[ "$1" == - ]]; then exec "${process.execPath}" "$@"; fi`] : []),
    'exit 0',
    '',
  ].join('\n'));
}

// Restore the renderer check from v0.21.2 in one CLI copy. The provider is real.
function requireLegacyRenderer(packageRoot: string): void {
  const path = join(packageRoot, 'src', 'core', 'architecture', 'projection.ts');
  const source = readFileSync(path, 'utf-8');
  const anchor = "  const pkg = record(input.package, 'archctx capabilities.package');";
  if (!source.includes(anchor)) throw new Error('fixture requires assertArchctxVersion');
  writeFileSync(path, source.replace(anchor, `${anchor}
  const renderers = record(input.renderers, 'archctx capabilities.renderers');
  if (renderers.architectureDocs !== 'archcontext.docs-renderer/v4') throw new Error('archctx architecture docs renderer mismatch');`));
}

function writeCoreOnlyInstallState(home: string): void {
  mkdirSync(join(home, '.repo-harness'), { recursive: true });
  writeFileSync(installStateFixturePath({ HOME: home }), `${JSON.stringify({
    protocol: 5,
    selection: [],
    ...versions([]),
    transaction_id: 'fixture-install',
    applied_at: '2026-09-04T00:00:00.000Z',
    previous: null,
  }, null, 2)}\n`);
}

const candidateRoots: string[] = [];
afterAll(() => { for (const root of candidateRoots) rmSync(root, { recursive: true, force: true }); });

// Agent trace writes change the live checkout. Each test owns immutable candidate code.
function fixtureCandidate(ownerRoot?: string): CandidatePackageIdentity {
  const root = ownerRoot ?? mkdtempSync(join(tmpdir(), 'repo-harness-candidate-identity-'));
  if (!ownerRoot) candidateRoots.push(root);
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;
  return candidatePackageIdentity(copyRuntimeFixture(join(root, 'candidate'), version, 30));
}

function candidateReceipt(identity: CandidatePackageIdentity, adapterDigest: string): CandidateReconciliationReceipt {
  return {
    protocol: 3,
    transaction_id: 'transaction-fixture',
    candidate_package_root: identity.root,
    candidate_version: identity.version,
    candidate_package_digest: identity.package_digest,
    route_registry_digest: routeRegistryDigest(),
    selected_target: 'codex',
    adapter_projection_digests: { codex: adapterDigest },
    ownership_manifest_digest: 'sha256:ledger-fixture',
    reconciliation_scope: 'complete',
    verified_at: '2026-09-04T00:00:00.000Z',
  };
}

function invokeCandidateChild(
  request: CandidateReconciliationRequest,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [
    join(request.candidate.root, 'src', 'cli', 'index.ts'),
    '__reconcile-installed-runtime',
    '--request',
    encodeCandidateRequest(request),
  ], {
    cwd: request.cwd,
    encoding: 'utf-8',
    env: {
      ...env,
      REPO_HARNESS_RUNTIME_RECONCILIATION_PARENT: '1',
      REPO_HARNESS_RUNTIME_RECONCILIATION_TOKEN: request.parent_token,
    },
  });
}

const GLOBAL_RUNTIME_LOCK = '.repo-harness/transactions/global-runtime.lock';

interface ParentLock {
  readonly lockPath: string;
  readonly ownerToken: string;
  release(): void;
}

// A 0.24.1 parent publishes { pid, created_at, token } with no start_time (#973).
function holdLegacyParentLock(home: string, pid: number): ParentLock {
  const lockPath = join(realpathSync(home), GLOBAL_RUNTIME_LOCK);
  const ownerToken = `${pid}-${Date.now()}-${randomUUID()}`;
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(lockPath, `${ownerToken}.json`),
    `${JSON.stringify({ pid, created_at: Date.now(), token: ownerToken })}\n`,
    { mode: 0o600 },
  );
  return { lockPath, ownerToken, release: () => rmSync(lockPath, { recursive: true, force: true }) };
}

function runCandidateChild(
  request: CandidateReconciliationRequest,
  env: NodeJS.ProcessEnv,
  holdParentLock: (home: string) => ParentLock = home => acquireExclusiveDirectoryLock(home, GLOBAL_RUNTIME_LOCK),
): ReturnType<typeof spawnSync> {
  const home = realpathSync(env.HOME!);
  seedGlobalPackageFixture(env, { sourceRoot: request.candidate.root });
  const lock = holdParentLock(home);
  try {
    publishCandidateReconciliationCapability({
      transactionId: request.transaction_id,
      transactionBackupRoot: request.transaction_backup_root,
      parentToken: request.parent_token,
      parentPid: process.pid,
      lockPath: lock.lockPath,
      lockOwnerToken: lock.ownerToken,
    });
    return invokeCandidateChild(request, env);
  } finally {
    lock.release();
  }
}

describe('candidate-bound global runtime reconciliation', () => {
  test.each(['BUN_INSTALL', 'HOME'] as const)('accepts adapter projections from an explicit %s environment', (source) => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-candidate-env-'));
    const env = { ...process.env, HOME: join(root, 'home'), BUN_INSTALL: source === 'BUN_INSTALL' ? join(root, 'bun') : undefined };
    try {
      seedGlobalPackageFixture(env, { mutable: true });
      if (source === 'HOME') delete env.BUN_INSTALL;
      const identity = fixtureCandidate(root);
      const digests = {} as Record<'claude' | 'codex', string>;
      for (const host of ['claude', 'codex'] as const) {
        const hooks = buildManagedHooks(host, env);
        const directory = join(env.HOME, `.${host}`);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, host === 'codex' ? 'hooks.json' : 'settings.json'), JSON.stringify({ hooks }));
        digests[host] = managedProjectionDigest(hooks);
      }
      expect(assertInstalledAdapterProjection('both', env)).toEqual(digests);
      expect(() => assertCandidateReconciliationReceipt({
        ...candidateReceipt(identity, digests.codex),
        selected_target: 'both',
        adapter_projection_digests: digests,
      }, {
        transaction_id: 'transaction-fixture',
        candidate: identity,
        target: 'both',
        require_complete: true,
      }, env)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a predecessor Stop timeout projection even when the route count is unchanged', () => {
    const identity = fixtureCandidate();
    const candidate = buildManagedHooks('codex');
    const predecessor = structuredClone(candidate);
    const stop = predecessor.Stop?.find((entry) => entry.hooks[0]?.command.includes(' Stop --route default'));
    if (!stop) throw new Error('fixture requires Stop.default');
    stop.hooks[0]!.timeout = 150;

    expect(candidate.Stop?.[0]?.hooks[0]?.timeout).toBe(30);
    expect(managedProjectionDigest(predecessor)).not.toBe(managedProjectionDigest(candidate));
    expect(() => assertCandidateReconciliationReceipt(candidateReceipt(identity, managedProjectionDigest(predecessor)), {
      transaction_id: 'transaction-fixture',
      candidate: identity,
      target: 'codex',
      require_complete: true,
    })).toThrow('adapter projection mismatch for codex');
  });

  test('accepts the candidate projection and binds its package identity to the transaction receipt', () => {
    const identity = fixtureCandidate();
    const candidate = buildManagedHooks('codex');
    expect(() => assertCandidateReconciliationReceipt(candidateReceipt(identity, managedProjectionDigest(candidate)), {
      transaction_id: 'transaction-fixture',
      candidate: identity,
      target: 'codex',
      require_complete: true,
    })).not.toThrow();
  });

  test('candidate authority replaces a predecessor Stop timeout and preserves an unmanaged hook', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-candidate-runtime-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const candidate = fixtureCandidate(root);
    const token = 'a'.repeat(64);
    const env = {
      ...process.env,
      HOME: home,
      BUN_INSTALL: join(home, '.bun'),
      REPO_HARNESS_RUNTIME_RECONCILIATION_PARENT: '1',
      REPO_HARNESS_RUNTIME_RECONCILIATION_TOKEN: token,
    };
    try {
      mkdirSync(cwd, { recursive: true });
      // The candidate reads the recorded selection; a partial reconciliation commits no new install transaction.
      writeCoreOnlyInstallState(home);
      const transaction = beginInstallHostTransaction([], env);
      expect(existsSync(transaction.backup_root)).toBe(true);
      const predecessor = structuredClone(buildManagedHooks('codex'));
      const stop = predecessor.Stop?.find((entry) => entry.hooks[0]?.command.includes(' Stop --route default'));
      if (!stop) throw new Error('fixture requires Stop.default');
      stop.hooks[0]!.timeout = 150;
      const hookPath = join(home, '.codex', 'hooks.json');
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(hookPath, JSON.stringify({
        hooks: predecessor,
        custom: { untouched: true },
      }, null, 2));

      const request: CandidateReconciliationRequest = {
        protocol: 3,
        transaction_id: sha256Prefixed(transaction.backup_root),
        transaction_backup_root: transaction.backup_root,
        parent_token: token,
        candidate,
        cwd,
        target: 'codex',
        sync_skill: false,
        host_adapters: true,
        external_skills: false,
        obsidian_skills: false,
        codegraph: false,
      };
      const result = runCandidateChild(request, env);
      expect(result.status).toBe(0);
      const receipt = JSON.parse((result.stdout ?? '').toString()) as CandidateReconciliationReceipt;

      const installed = JSON.parse(readFileSync(hookPath, 'utf-8')) as { hooks: Record<string, Array<{ hooks: Array<{ timeout: number; command: string }> }>>; custom: unknown };
      const installedStop = installed.hooks.Stop?.[0]?.hooks[0]?.timeout;
      expect(installedStop).toBe(30);
      expect(installed.custom).toEqual({ untouched: true });
      expect(receipt.reconciliation_scope).toBe('partial');
      expect<string | null | undefined>(receipt.adapter_projection_digests.codex).toBe(installedAdapterProjectionDigest(hookPath));
      expect(installed.hooks.Stop[0].hooks[0].command).toContain(`'${join(candidate.root, 'dist/hook-entry.js')}' Stop --route default`);
      expect(readInstallState(env)).toMatchObject({ transaction_id: 'fixture-install', selection: [], plugins: [] });
      rollbackInstallHostTransaction(transaction);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('candidate mutation rejects a forged transaction directory and consumes its parent capability once', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-candidate-capability-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const candidate = fixtureCandidate(root);
    const token = 'c'.repeat(64);
    const env = { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun') };
    try {
      mkdirSync(cwd, { recursive: true });
      writeCoreOnlyInstallState(home);
      const transaction = beginInstallHostTransaction([], env);
      const predecessor = structuredClone(buildManagedHooks('codex'));
      const stop = predecessor.Stop?.find((entry) => entry.hooks[0]?.command.includes(' Stop --route default'));
      if (!stop) throw new Error('fixture requires Stop.default');
      stop.hooks[0]!.timeout = 150;
      const hookPath = join(home, '.codex', 'hooks.json');
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(hookPath, JSON.stringify({ hooks: predecessor }, null, 2));
      const requestBase = {
        protocol: 3 as const,
        parent_token: token,
        candidate,
        cwd,
        target: 'codex' as const,
        sync_skill: false,
        host_adapters: true,
        external_skills: false,
        obsidian_skills: false,
        codegraph: false,
      };
      const forgedBackup = join(home, '.repo-harness', 'transactions', 'install-forged');
      mkdirSync(forgedBackup);
      const forged: CandidateReconciliationRequest = {
        ...requestBase,
        transaction_id: sha256Prefixed(forgedBackup),
        transaction_backup_root: forgedBackup,
      };
      expect(invokeCandidateChild(forged, env).status).toBe(1);
      expect(JSON.parse(readFileSync(hookPath, 'utf-8')).hooks.Stop[0].hooks[0].timeout).toBe(150);

      const invalidLockRequest: CandidateReconciliationRequest = {
        ...requestBase,
        transaction_id: sha256Prefixed(transaction.backup_root),
        transaction_backup_root: transaction.backup_root,
      };
      const lock = acquireExclusiveDirectoryLock(realpathSync(home), '.repo-harness/transactions/global-runtime.lock');
      try {
        publishCandidateReconciliationCapability({
          transactionId: invalidLockRequest.transaction_id,
          transactionBackupRoot: invalidLockRequest.transaction_backup_root,
          parentToken: token,
          parentPid: process.pid,
          lockPath: lock.lockPath,
          lockOwnerToken: lock.ownerToken.replace(/^[1-9]\d*/, String(process.pid + 1)),
        });
        expect(invokeCandidateChild(invalidLockRequest, env).status).toBe(1);
      } finally {
        lock.release();
      }
      expect(JSON.parse(readFileSync(hookPath, 'utf-8')).hooks.Stop[0].hooks[0].timeout).toBe(150);
      rollbackInstallHostTransaction(transaction);

      const activeTransaction = beginInstallHostTransaction([], env);
      const request: CandidateReconciliationRequest = {
        ...requestBase,
        transaction_id: sha256Prefixed(activeTransaction.backup_root),
        transaction_backup_root: activeTransaction.backup_root,
      };
      expect(runCandidateChild(request, env).status).toBe(0);
      expect(JSON.parse(readFileSync(hookPath, 'utf-8')).hooks.Stop[0].hooks[0].timeout).toBe(30);
      expect(invokeCandidateChild(request, env).status).toBe(1);
      rollbackInstallHostTransaction(activeTransaction);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the candidate refuses a selection that its own requests do not carry before any write, and applies a carried one', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-candidate-override-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const candidate = fixtureCandidate(root);
    const env = { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun') };
    try {
      mkdirSync(cwd, { recursive: true });
      writeCoreOnlyInstallState(home);
      const settings = join(home, '.claude', 'settings.json');
      const original = '{"statusLine":{"type":"command","command":"user-line"}}\n';
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(settings, original);
      const run = (selector: string) => {
        const transaction = beginInstallHostTransaction([], env);
        const result = runCandidateChild({
          protocol: 3, parent_token: 'd'.repeat(64), candidate, cwd, target: 'claude', sync_skill: false, host_adapters: true,
          external_skills: false, obsidian_skills: false, codegraph: false,
          transaction_id: sha256Prefixed(transaction.backup_root), transaction_backup_root: transaction.backup_root,
          overrides: [{ path: realpathSync(settings), selector }],
        }, env);
        rollbackInstallHostTransaction(transaction);
        return result;
      };
      const refused = run('nope');
      expect(refused.status).toBe(1);
      expect(String(refused.stderr)).toContain('--override');
      expect(readFileSync(settings, 'utf-8')).toBe(original);
      expect(existsSync(join(home, '.repo-harness', 'config', 'ledger.json'))).toBe(false);
      const carried = run('statusLine');
      expect(carried.status, String(carried.stderr)).toBe(0);
      expect(parseCandidateReceipt(String(carried.stdout)).overrides).toEqual([{ path: realpathSync(settings), selector: 'statusLine' }]);
      expect(JSON.parse(readFileSync(settings, 'utf-8')).statusLine.command).toEndWith(' statusline');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('#973: a 0.24.1 parent lock record without start_time authorizes the candidate; a pid or token mismatch does not', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-candidate-legacy-lock-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const candidate = fixtureCandidate(root);
    const token = 'd'.repeat(64);
    const env = { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun') };
    try {
      mkdirSync(cwd, { recursive: true });
      writeCoreOnlyInstallState(home);
      const predecessor = structuredClone(buildManagedHooks('codex'));
      const stop = predecessor.Stop?.find((entry) => entry.hooks[0]?.command.includes(' Stop --route default'));
      if (!stop) throw new Error('fixture requires Stop.default');
      stop.hooks[0]!.timeout = 150;
      const hookPath = join(home, '.codex', 'hooks.json');
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(hookPath, JSON.stringify({ hooks: predecessor }, null, 2));
      const requestFor = (backupRoot: string): CandidateReconciliationRequest => ({
        protocol: 3,
        parent_token: token,
        transaction_id: sha256Prefixed(backupRoot),
        transaction_backup_root: backupRoot,
        candidate,
        cwd,
        target: 'codex',
        sync_skill: false,
        host_adapters: true,
        external_skills: false,
        obsidian_skills: false,
        codegraph: false,
      });
      const publish = (request: CandidateReconciliationRequest, lock: ParentLock, lockOwnerToken: string): void => {
        publishCandidateReconciliationCapability({
          transactionId: request.transaction_id,
          transactionBackupRoot: request.transaction_backup_root,
          parentToken: token,
          parentPid: process.pid,
          lockPath: lock.lockPath,
          lockOwnerToken,
        });
      };

      const refusals = [
        { lockPid: process.pid + 1, capabilityToken: (lock: ParentLock) => lock.ownerToken },
        { lockPid: process.pid, capabilityToken: () => `${process.pid}-${Date.now()}-${randomUUID()}` },
      ];
      for (const refusal of refusals) {
        const transaction = beginInstallHostTransaction([], env);
        const request = requestFor(transaction.backup_root);
        const lock = holdLegacyParentLock(home, refusal.lockPid);
        try {
          publish(request, lock, refusal.capabilityToken(lock));
          const result = invokeCandidateChild(request, env);
          expect(result.status).toBe(1);
          expect(String(result.stderr)).toContain('parent does not own the active global runtime lock');
        } finally {
          lock.release();
        }
        rollbackInstallHostTransaction(transaction);
      }
      expect(JSON.parse(readFileSync(hookPath, 'utf-8')).hooks.Stop[0].hooks[0].timeout).toBe(150);

      const transaction = beginInstallHostTransaction([], env);
      const request = requestFor(transaction.backup_root);
      const result = runCandidateChild(request, env, canonicalHome => holdLegacyParentLock(canonicalHome, process.pid));
      expect(String(result.stderr)).not.toContain('parent does not own the active global runtime lock');
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(hookPath, 'utf-8')).hooks.Stop[0].hooks[0].timeout).toBe(30);
      rollbackInstallHostTransaction(transaction);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('candidate reconciliation refreshes a complete ownership ledger after exact host projection verification', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-candidate-ledger-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const candidate = fixtureCandidate(root);
    const token = 'b'.repeat(64);
    const env = {
      ...process.env,
      HOME: home,
      BUN_INSTALL: join(home, '.bun'),
      REPO_HARNESS_RUNTIME_RECONCILIATION_PARENT: '1',
      REPO_HARNESS_RUNTIME_RECONCILIATION_TOKEN: token,
    };
    try {
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
      writeExecutable(join(home, '.bun', 'bin', 'rh'), '#!/bin/sh\nexit 0\n');
      writeCoreOnlyInstallState(home);
      const transaction = beginInstallHostTransaction([], env);
      const request: CandidateReconciliationRequest = {
        protocol: 3,
        transaction_id: sha256Prefixed(transaction.backup_root),
        transaction_backup_root: transaction.backup_root,
        parent_token: token,
        candidate,
        cwd,
        target: 'codex',
        sync_skill: true,
        host_adapters: true,
        external_skills: false,
        obsidian_skills: false,
        codegraph: false,
      };
      const result = runCandidateChild(request, env);
      expect(result.status).toBe(0);
      const receipt = JSON.parse((result.stdout ?? '').toString()) as CandidateReconciliationReceipt;

      const installed = readInstallState(env);
      expect(receipt.reconciliation_scope).toBe('complete');
      // The receipt binds the ledger's path records, in key order.
      const records = Object.entries(readPathRecords(env)).sort(([left], [right]) => (left < right ? -1 : 1));
      expect(receipt.ownership_manifest_digest).toBe(`sha256:${createHash('sha256').update(JSON.stringify(records)).digest('hex')}`);
      expect(installed?.plugins).toEqual([]);
      // The hook file is in the host-config ledger, not in the manifest.
      expect(openHostConfigGate({ env }).recorded(join(home, '.codex', 'hooks.json')).length).toBeGreaterThan(0);
      rollbackInstallHostTransaction(transaction);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test.each([['claude', 'md'], ['codex', 'toml']] as const)('candidate retires %s ledger claims and preserves recovery across update and uninstall', (host, ext) => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-candidate-fleet-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const candidate = fixtureCandidate(root);
    const env = { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun') };
    try {
      mkdirSync(cwd, { recursive: true });
      mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
      writeExecutable(join(home, '.bun', 'bin', 'rh'), '#!/bin/sh\nexit 0\n');
      writeCoreOnlyInstallState(home);

      const path = (name: string, inHost = host) => join(home, `.${inHost}`, 'agents', `${name}.${inHost === host ? ext : host === 'claude' ? 'toml' : 'md'}`);
      const removed = path('fast-worker');
      const edited = path('deep-worker');
      const restored = path('root-cause-prover');
      const backed = path('gatekeeper');
      const other = host === 'claude' ? 'codex' : 'claude';
      const kept = path('fast-worker', other);
      const recreated = path('deep-worker', other);
      const linked = path('root-cause-prover', other);
      const absent = path('gatekeeper', other);
      const outside = join(home, 'my-agent');
      const original = Buffer.from([0x75, 0x00, 0xff, 0x0a]);
      const custom = Buffer.from('User edits\r\n');
      const installed = Buffer.from('Previously installed fleet persona\n');
      const gate = openHostConfigGate({ env });
      for (const file of [restored, backed, absent]) {
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, original);
      }
      gate.writePaths([removed, edited, restored, backed, kept, recreated, linked, absent].map(file => ({
        path: file, owner: 'core', entry: { type: 'file', bytes: installed }, replace: [restored, backed, absent].includes(file),
      })));
      writeFileSync(edited, custom);
      writeFileSync(backed, custom);
      writeFileSync(kept, custom);
      gate.keepUserPaths('core', [kept], [kept]);
      const copy = join(root, 'previously saved copy');
      writeFileSync(copy, installed);
      rmSync(recreated);
      writeFileSync(recreated, readFileSync(copy));
      writeFileSync(outside, installed);
      rmSync(linked);
      symlinkSync(outside, linked);
      rmSync(absent);
      const paths = hostConfigPaths(env);
      const ledger = readLedger(paths);
      const backedRecord = ledger.paths[pathRecordKey(env, backed)]!;
      const vault = vaultPath(paths, backedRecord.backup!);
      const linkedRecovery = host === 'codex';
      if (linkedRecovery) {
        // An older fleet could record a replacement of the target of a user link.
        const key = pathRecordKey(env, linked);
        writeLedger(paths, { ...ledger, paths: { ...ledger.paths, [key]: {
          ...backedRecord, host: other, link_target: outside, identity: observeEntryIdentity(outside)!,
        } } });
      }

      const update = (commit: boolean) => {
        const transaction = beginInstallHostTransaction([hostConfigPaths(env).ledger, installStateFixturePath(env)], env);
        const result = runCandidateChild({
          protocol: 3, parent_token: 'b'.repeat(64), candidate, cwd, target: 'codex', sync_skill: true,
          host_adapters: true, external_skills: false, obsidian_skills: false, codegraph: false,
          transaction_id: sha256Prefixed(transaction.backup_root), transaction_backup_root: transaction.backup_root,
        }, env);
        expect(result.status, String(result.stderr)).toBe(0);
        expect(parseCandidateReceipt(String(result.stdout)).reconciliation_scope).toBe('complete');
        if (commit) commitInstallHostTransaction(transaction);
        else rollbackInstallHostTransaction(transaction);
        return String(result.stderr);
      };

      // A failed parent transaction can reinstate its current owned entries, without touching preserved files.
      const notices = update(false);
      expect(readFileSync(removed)).toEqual(installed);
      expect(readFileSync(restored)).toEqual(installed);
      update(true);
      expect(notices).toContain(`${edited}: changed since rh wrote it; preserved. Ownership record released.`);
      expect(notices).toContain(`${backed}: changed since rh wrote it; preserved; the file before rh is in ${vault}`);
      expect(notices).toContain(`${absent}: this retired agent is absent; its recovery record stays; the file before rh is in ${vault}`);
      expect(existsSync(removed)).toBe(false);
      expect(readFileSync(restored)).toEqual(original);
      const preserved = () => [edited, backed, kept, recreated, outside, vault].map(file => readFileSync(file));
      expect(preserved()).toEqual([custom, custom, custom, installed, installed, original]);
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      const retired = [removed, edited, restored, backed, kept, recreated, linked, absent];
      const remaining = () => {
        const records = readPathRecords(env);
        return retired.filter(file => Object.hasOwn(records, pathRecordKey(env, file)))
          .map(file => [file, records[pathRecordKey(env, file)]!.kind]);
      };
      const recovery = linkedRecovery ? [backed, linked, absent] : [backed, absent];
      const expected = recovery.map(file => [file, 'replaced']);
      expect(remaining()).toEqual(expected);

      expect(update(true)).toContain(vault);
      expect(existsSync(removed)).toBe(false);
      const uninstall = runUserUninstall({ env, target: 'both' });
      for (const file of recovery) {
        expect(uninstall.items).toContainEqual({ path: pathRecordKey(env, file), action: 'unresolved', reason: expect.stringContaining(vault) });
      }
      expect(preserved()).toEqual([custom, custom, custom, installed, installed, original]);
      expect(remaining()).toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test.each(['current', 'previous'] as const)('candidate checks retired protocol 3 paths in the %s manifest and migrates a mixed fleet receipt', (snapshot) => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-legacy-fleet-'));
    const home = join(root, 'home');
    const cwd = join(root, 'repo');
    const candidate = fixtureCandidate(root);
    const env = { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun') };
    try {
      mkdirSync(cwd, { recursive: true });
      const agents = join(home, '.codex', 'agents');
      mkdirSync(agents, { recursive: true });
      mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
      writeExecutable(join(home, '.bun', 'bin', 'rh'), '#!/bin/sh\nexit 0\n');
      writeCoreOnlyInstallState(home);
      const statePath = installStateFixturePath(env);
      const managed = join(agents, 'fast-worker.toml');
      const retiredUser = join(agents, 'deep-worker.toml');
      const explorer = join(agents, 'explorer.toml');
      const previousBytes = Buffer.from('Legacy managed bytes\r\n');
      const retiredUserBytes = Buffer.from([0x75, 0x00, 0xff, 0x0a]);
      const explorerBytes = Buffer.from(`${readFileSync(join(ROOT, '.codex/agents/explorer.toml'), 'utf8')}\n# user instructions\n`);
      writeFileSync(managed, previousBytes);
      writeFileSync(retiredUser, retiredUserBytes);
      writeFileSync(explorer, explorerBytes);
      const managedIdentity = observeEntryIdentity(managed);
      const legacyManifest = [{ path: managed, authority: 'repo-harness-install-transaction', owner: 'core', type: 'managed-file',
        removal: 'managed-surfaces-only', managed_marker: 'transaction-created-file', content_hash: sha256Prefixed(previousBytes), symlink_target: null }];
      const fields = { ...versions([]), selection: [], applied_at: '2026-09-04T00:00:00.000Z' };
      writeFileSync(statePath, JSON.stringify({ protocol: 3, ...fields, transaction_id: 'legacy-current',
        ownership_manifest: snapshot === 'current' ? legacyManifest : [], previous: snapshot === 'previous'
          ? { protocol: 3, ...fields, transaction_id: 'legacy-previous', ownership_manifest: legacyManifest } : null }));
      const fleetReceipt = join(home, '.repo-harness', 'agent-fleet-user-managed.json');
      const receiptEntry = { path: retiredUser, sha256: sha256Prefixed(retiredUserBytes) };
      const writeReceipt = (files: readonly { path: string; sha256: string }[]) => {
        writeFileSync(fleetReceipt, JSON.stringify({ protocol: 1, authority: 'user-managed-agent-fleet', files }));
      };
      for (const files of [
        [{ ...receiptEntry, sha256: 'invalid' }],
        [receiptEntry, receiptEntry],
        [{ ...receiptEntry, path: join(home, 'other', 'deep-worker.toml') }],
      ]) {
        writeReceipt(files);
        expect(() => planInstallStateMigration(env)).toThrow('the agent fleet receipt is malformed');
      }
      writeReceipt([receiptEntry, { path: explorer, sha256: sha256Prefixed(explorerBytes) }]);

      for (let run = 0; run < 2; run += 1) {
        const transaction = beginInstallHostTransaction([hostConfigPaths(env).ledger, statePath], env);
        const result = runCandidateChild({
          protocol: 3, parent_token: 'b'.repeat(64), candidate, cwd, target: 'codex', sync_skill: true,
          host_adapters: true, external_skills: false, obsidian_skills: false, codegraph: false,
          transaction_id: sha256Prefixed(transaction.backup_root), transaction_backup_root: transaction.backup_root,
        }, env);
        expect(result.status, String(result.stderr)).toBe(0);
        expect(parseCandidateReceipt(String(result.stdout)).reconciliation_scope).toBe('complete');
        commitInstallHostTransaction(transaction);
        expect(readInstallState(env)?.protocol).toBe(5);
        expect(existsSync(fleetReceipt)).toBe(false);
        expect(readFileSync(retiredUser)).toEqual(retiredUserBytes);
        expect(readFileSync(explorer)).toEqual(explorerBytes);
        expect([readFileSync(managed), observeEntryIdentity(managed)]).toEqual([previousBytes, managedIdentity]);
        if (snapshot === 'current' && run === 0) {
          expect(String(result.stderr)).toContain(`${managed}: rh recorded no identity for it`);
          expect(String(result.stderr)).toContain('Ownership record released.');
        }
        const records = readPathRecords(env);
        expect(records[pathRecordKey(env, explorer)]?.kind).toBe('user_managed');
        expect(records).not.toHaveProperty(pathRecordKey(env, managed));
        expect(records).not.toHaveProperty(pathRecordKey(env, retiredUser));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test.each([2, 3, 4])('candidate preserves identical-byte retired files and the vault from a protocol %i ledger', (protocol) => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-retired-legacy-ledger-'));
    const home = join(root, 'home');
    const candidate = fixtureCandidate(root);
    const env = { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun') };
    try {
      writeCoreOnlyInstallState(home);
      const agents = join(home, '.codex', 'agents');
      const created = join(agents, 'fast-worker.toml');
      const replaced = join(agents, 'deep-worker.toml');
      const userCopy = Buffer.from('User copy of the old fleet bytes\n');
      const original = Buffer.from('Original user agent\r\n');
      mkdirSync(agents, { recursive: true });
      writeFileSync(replaced, original);
      openHostConfigGate({ env }).writePaths([created, replaced].map(path => ({
        path, owner: 'core', replace: path === replaced, entry: { type: 'file', bytes: userCopy },
      })));
      const paths = hostConfigPaths(env);
      const ledger = readLedger(paths);
      const records = Object.fromEntries(Object.entries(ledger.paths).map(([key, { identity: _identity, ...record }]) => [key, record]));
      const { retired, recovery, tools, ...legacy } = ledger;
      const { backup } = records[replaced]!;
      const vault = vaultPath(paths, backup!);
      writeFileSync(paths.ledger, JSON.stringify({ ...legacy, protocol, paths: records,
        ...(protocol >= 3 ? { retired, recovery } : {}), ...(protocol === 4 ? { tools } : {}) }));
      for (const path of [created, replaced]) {
        rmSync(path);
        writeFileSync(path, userCopy);
      }
      const copyIdentities = [created, replaced].map(observeEntryIdentity);
      const projected = projectedLedgerPaths(paths, retiredAgentRecordCheck(env));
      expect([projected[created]?.identity, projected[replaced]?.identity]).toEqual([undefined, undefined]);
      const preview = runUserUninstall({ env, target: 'both', dryRun: true });
      expect(preview.items.filter(item => [created, replaced].includes(item.path))).toEqual([
        expect.objectContaining({ path: created, action: 'unresolved', reason: expect.stringContaining('rh recorded no identity') }),
        expect.objectContaining({ path: replaced, action: 'unresolved', reason: expect.stringContaining(vault) }),
      ]);

      const transaction = beginInstallHostTransaction([paths.ledger], env);
      const result = runCandidateChild({
        protocol: 3, parent_token: 'b'.repeat(64), candidate, cwd: root, target: 'codex', sync_skill: false,
        host_adapters: true, external_skills: false, obsidian_skills: false, codegraph: false,
        transaction_id: sha256Prefixed(transaction.backup_root), transaction_backup_root: transaction.backup_root,
      }, env);
      expect(result.status, String(result.stderr)).toBe(0);
      commitInstallHostTransaction(transaction);
      expect(String(result.stderr)).toContain(`${created}: rh recorded no identity for it`);
      expect(String(result.stderr)).toContain(`${replaced}: rh recorded no identity for it`);
      expect(String(result.stderr)).toContain(vault);
      expect([created, replaced].map(path => readFileSync(path))).toEqual([userCopy, userCopy]);
      expect([created, replaced].map(observeEntryIdentity)).toEqual(copyIdentities);
      const remaining = readPathRecords(env);
      expect(Object.hasOwn(remaining, created)).toBe(false);
      expect(remaining[replaced]).toEqual(records[replaced]);
      expect(readFileSync(vault)).toEqual(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('gc before a host-root switch back leaves retired user copies unproved and adopts active fleet identity', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'repo-harness-retired-root-switch-')));
    const home = join(root, 'home');
    const candidate = fixtureCandidate(root);
    const env = { HOME: home, BUN_INSTALL: join(home, '.bun'), PATH: `${fakeHcBin}:/usr/bin:/bin`, REPO_HARNESS_BUN_EXECUTABLE: process.execPath };
    try {
      writeCoreOnlyInstallState(home);
      const host = join(home, '.codex');
      const firstRoot = join(root, 'first-codex');
      const secondRoot = join(root, 'second-codex');
      for (const directory of [firstRoot, secondRoot]) mkdirSync(join(directory, 'agents'), { recursive: true });
      symlinkSync(firstRoot, host, 'dir');
      const targets = [join(host, 'agents', 'fast-worker.toml'), join(host, 'agents', 'deep-worker.toml')];
      const created = pathRecordKey(env, targets[0]!);
      const replaced = pathRecordKey(env, targets[1]!);
      const explorer = join(home, '.claude', 'agents', 'explorer.md');
      const explorerKey = pathRecordKey(env, explorer);
      const managed = Buffer.from('Old managed fleet bytes\n');
      const original = Buffer.from('Original user bytes\r\n');
      writeFileSync(replaced, original);
      const gate = openHostConfigGate({ env });
      gate.writePaths(targets.map((path, index) => ({ path, owner: 'core', replace: index === 1, entry: { type: 'file', bytes: managed } })));
      gate.writePaths([{ path: explorer, owner: 'core', entry: { type: 'file', bytes: readFileSync(join(ROOT, 'agents/fleet/explorer.md')) } }]);
      const paths = hostConfigPaths(env);
      const ledger = readLedger(paths);
      const legacyPaths = Object.fromEntries(Object.entries(ledger.paths).map(([key, { identity: _identity, ...record }]) => [key, record]));
      const vault = vaultPath(paths, legacyPaths[replaced]!.backup!);
      writeFileSync(paths.ledger, JSON.stringify({ ...ledger, protocol: 4, paths: legacyPaths }));
      for (const path of [created, replaced]) {
        rmSync(path);
        writeFileSync(path, managed);
      }
      const copies = [created, replaced].map(observeEntryIdentity);
      rmSync(host);
      symlinkSync(secondRoot, host, 'dir');
      const gc = spawnSync(process.execPath, [CLI, 'config', 'gc', '--json'], { cwd: root, env, encoding: 'utf8' });
      expect(gc.status, gc.stderr + gc.stdout).toBe(0);
      const migrated = readLedger(paths).paths;
      expect([migrated[created], migrated[replaced], migrated[explorerKey]?.identity]).toEqual([
        legacyPaths[created], legacyPaths[replaced], observeEntryIdentity(explorer)!,
      ]);

      rmSync(host);
      symlinkSync(firstRoot, host, 'dir');
      const transaction = beginInstallHostTransaction([paths.ledger], env);
      const result = runCandidateChild({
        protocol: 3, parent_token: 'b'.repeat(64), candidate, cwd: root, target: 'codex', sync_skill: false,
        host_adapters: true, external_skills: false, obsidian_skills: false, codegraph: false,
        transaction_id: sha256Prefixed(transaction.backup_root), transaction_backup_root: transaction.backup_root,
      }, env);
      expect(result.status, String(result.stderr)).toBe(0);
      commitInstallHostTransaction(transaction);
      expect([created, replaced].map(path => readFileSync(path))).toEqual([managed, managed]);
      expect([created, replaced].map(observeEntryIdentity)).toEqual(copies);
      const remaining = readPathRecords(env);
      expect(Object.hasOwn(remaining, created)).toBe(false);
      expect(remaining[replaced]).toEqual(legacyPaths[replaced]);
      expect(readFileSync(vault)).toEqual(original);
      expect(String(result.stderr)).toContain(vault);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('parent rollback preserves the identities that candidate rollback recorded for retired paths', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'repo-harness-retired-double-rollback-')));
    const home = join(root, 'home');
    const env = { HOME: home, BUN_INSTALL: join(home, '.bun'), PATH: `${fakeHcBin}:/usr/bin:/bin`, REPO_HARNESS_BUN_EXECUTABLE: process.execPath };
    try {
      writeCoreOnlyInstallState(home);
      const created = join(home, '.codex', 'agents', 'fast-worker.toml');
      const replaced = join(home, '.codex', 'agents', 'deep-worker.toml');
      const managed = Buffer.from('Installed persona\n');
      const original = Buffer.from('Earlier user persona\r\n');
      mkdirSync(join(replaced, '..'), { recursive: true });
      writeFileSync(replaced, original);
      const gate = openHostConfigGate({ env });
      gate.writePaths([created, replaced].map(path => ({ path, owner: 'core', replace: path === replaced, entry: { type: 'file', bytes: managed } })));
      const paths = hostConfigPaths(env);
      const before = readLedger(paths).paths;
      const vault = vaultPath(paths, before[replaced]!.backup!);
      const candidateRoot = fixtureCandidate(root).root;
      const source = join(candidateRoot, 'src/cli/candidate-runtime-reconciliation.ts');
      const unmodified = readFileSync(source, 'utf8');
      const anchor = '    const adapterDigests = request.host_adapters';
      expect(unmodified).toContain(anchor);
      writeFileSync(source, unmodified.replace(anchor, `    throw new Error('fixture failed after fleet retirement');\n${anchor}`));
      const run = (transaction: ReturnType<typeof beginInstallHostTransaction>) => runCandidateChild({
        protocol: 3, parent_token: 'b'.repeat(64), candidate: candidatePackageIdentity(candidateRoot), cwd: root,
        target: 'codex', sync_skill: false, host_adapters: true, external_skills: false, obsidian_skills: false, codegraph: false,
        transaction_id: sha256Prefixed(transaction.backup_root), transaction_backup_root: transaction.backup_root,
      }, env);
      const transaction = beginInstallHostTransaction([paths.ledger], env);
      const failed = run(transaction);
      expect(failed.status, String(failed.stderr)).toBe(1);
      expect(String(failed.stderr)).toContain('fixture failed after fleet retirement');
      expect(String(failed.stderr)).toContain('restored the original from the vault');
      expect(readFileSync(created)).toEqual(managed);
      expect(readFileSync(replaced)).toEqual(managed);
      const compensated = readLedger(paths).paths;
      for (const path of [created, replaced]) {
        expect(compensated[path]?.identity).toBe(observeEntryIdentity(path)!);
        expect(compensated[path]?.identity).not.toBe(before[path]?.identity);
      }
      rollbackInstallHostTransaction(transaction);
      for (const path of [created, replaced]) {
        expect(readLedger(paths).paths[path]).toEqual(compensated[path]!);
        expect(observeEntryIdentity(path)).toBe(compensated[path]!.identity!);
      }
      expect(readFileSync(vault)).toEqual(original);

      writeFileSync(source, unmodified);
      const retry = beginInstallHostTransaction([paths.ledger], env);
      const success = run(retry);
      expect(success.status, String(success.stderr)).toBe(0);
      commitInstallHostTransaction(retry);
      expect(existsSync(created)).toBe(false);
      expect(readFileSync(replaced)).toEqual(original);
      expect(Object.hasOwn(readLedger(paths).paths, replaced)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('uninstall previews a standalone fleet receipt with current install state', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'repo-harness-retired-receipt-preview-')));
    const home = join(root, 'home');
    const env = { HOME: home, BUN_INSTALL: join(home, '.bun'), PATH: '/usr/bin:/bin' };
    try {
      writeCoreOnlyInstallState(home);
      const agent = join(home, '.codex', 'agents', 'fast-worker.toml');
      const managed = Buffer.from('Fleet bytes the user adopted\n');
      const original = Buffer.from('Earlier user bytes\r\n');
      mkdirSync(join(agent, '..'), { recursive: true });
      writeFileSync(agent, original);
      openHostConfigGate({ env }).writePaths([{ path: agent, owner: 'core', replace: true, entry: { type: 'file', bytes: managed } }]);
      const paths = hostConfigPaths(env);
      const before = readLedger(paths).paths[agent]!;
      const vault = vaultPath(paths, before.backup!);
      const receipt = join(home, '.repo-harness', 'agent-fleet-user-managed.json');
      writeFileSync(receipt, JSON.stringify({ protocol: 1, authority: 'user-managed-agent-fleet', files: [{ path: agent, sha256: sha256Prefixed(managed) }] }));
      const preview = runUserUninstall({ env, target: 'both', dryRun: true });
      const kept = { path: agent, action: 'unresolved' as const, reason: expect.stringContaining(vault) };
      expect(preview.items).toContainEqual(kept);
      expect(existsSync(receipt)).toBe(true);
      expect(readLedger(paths).paths[agent]).toEqual(before);
      const result = runUserUninstall({ env, target: 'both' });
      expect(result.items).toContainEqual(kept);
      expect(existsSync(receipt)).toBe(false);
      expect(readLedger(paths).paths[agent]).toMatchObject({ kind: 'replaced', backup: before.backup });
      expect(readLedger(paths).paths[agent]?.identity).toBeUndefined();
      expect([readFileSync(agent), readFileSync(vault)]).toEqual([managed, original]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const retirementCheckpoints = [
    { step: 'preimage copy', side: 'forward', file: 'managed', ledger: 'original' },
    { step: 'staged vault copy', side: 'forward', file: 'managed', ledger: 'original', replacedOnly: true },
    { step: 'forward journal', side: 'forward', file: 'managed', ledger: 'original' },
    { step: 'unlink or vault publish', side: 'forward', file: 'forward', ledger: 'original' },
    { step: 'forward ledger', side: 'forward', file: 'forward', ledger: 'released' },
    { step: 'staged preimage', side: 'rollback', file: 'forward', ledger: 'released' },
    { step: 'rollback journal', side: 'rollback', file: 'forward', ledger: 'released' },
    { step: 'preimage publish', side: 'rollback', file: 'managed', ledger: 'released' },
    { step: 'rollback ledger', side: 'rollback', file: 'managed', ledger: 'restored' },
    { step: 'recovery ledger', side: 'recover', file: 'managed', ledger: 'restored' },
    { step: 'journal removal', side: 'recover', file: 'managed', ledger: 'restored' },
    { step: 'same-byte user copy after restore', side: 'forward', file: 'forward', ledger: 'original', replacedOnly: true },
  ] as const;

  test.each(retirementCheckpoints.flatMap(row => (['created', 'replaced'] as const)
    .filter(kind => !('replacedOnly' in row) || kind === 'replaced').map(kind => ({ ...row, kind }))))(
    'retirement replay keeps $kind file and vault state after $step', ({ step, side, file, ledger: expectedLedger, kind }) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'repo-harness-retirement-replay-')));
      const home = join(root, 'home');
      const candidate = fixtureCandidate(root);
      const env = { HOME: home, BUN_INSTALL: join(home, '.bun'), PATH: '/usr/bin:/bin' };
      try {
        writeCoreOnlyInstallState(home);
        const agent = join(home, '.codex', 'agents', 'fast-worker.toml');
        mkdirSync(join(agent, '..'), { recursive: true });
        const managed = Buffer.from('Managed agent bytes\n');
        const original = Buffer.from('Original user bytes\r\n');
        if (kind === 'replaced') writeFileSync(agent, original);
        openHostConfigGate({ env }).writePaths([{ path: agent, owner: 'core', replace: kind === 'replaced', entry: { type: 'file', bytes: managed } }]);
        const paths = hostConfigPaths(env);
        const before = readLedger(paths).paths[agent]!;
        const vault = before.backup ? vaultPath(paths, before.backup) : null;
        const marker = join(paths.root, 'retired-path-writes', sha256Hex(agent));
        const source = join(candidate.root, 'src/effects/host-config/gate.ts');
        let instrumented = readFileSync(source, 'utf8');
        const after = (line: string, code: string) => {
          expect(instrumented).toContain(line);
          instrumented = instrumented.replace(line, () => line + '\n' + code);
        };
        const stop = (name: string) => `checkpoint(${JSON.stringify(name)});`;
        after('    syncDirectoryDurably(options.transaction);', stop('preimage copy'));
        after('    if (staged) syncRetirementFile(staged);',
          '    if (staged) checkpoint(intent(identity).rollbackIdentity ? "staged preimage" : "staged vault copy");');
        after('    persistRetiredPathWrite(retiredPathWritePath(paths, key), write);',
          '    checkpoint(write.rollbackIdentity ? "rollback journal" : "forward journal");');
        after('    syncDirectoryDurably(dirname(key));',
          '    checkpoint(write.rollbackIdentity ? "preimage publish" : "unlink or vault publish");');
        after('      ledger = commit(ledger);\n      writeLedger(paths, ledger);', stop('forward ledger'));
        after('  else writeLedger(paths, restored);', stop('rollback ledger'));
        after('      writeLedger(paths, next);', stop('recovery ledger'));
        after('  syncDirectoryDurably(dirname(marker));', stop('journal removal'));
        writeFileSync(source, instrumented + `
function checkpoint(step: string) {
  if (process.env.TEST_RETIREMENT_STOP === step) process.kill(process.pid, 'SIGKILL');
}
`);
        const script = `
          import { beginInstallHostTransaction, commitInstallHostTransaction, retireAgentFleet, rollbackInstallHostTransaction } from './src/cli/installer/install-profile';
          import { migrateInstallState } from './src/cli/installer/install-state-migration';
          import { hostConfigPaths } from './src/effects/host-config/store';
          import { globalRuntimeScope, withRuntimeTransactionLock } from './src/effects/locking/runtime-transaction-lock';
          const env = process.env;
          withRuntimeTransactionLock(globalRuntimeScope(env), () => {
            migrateInstallState(env);
            const side = process.argv.at(-1);
            if (side === 'recover') return;
            const transaction = beginInstallHostTransaction([hostConfigPaths(env).ledger], env);
            retireAgentFleet(env, transaction.backup_root);
            if (side === 'rollback') rollbackInstallHostTransaction(transaction);
            else commitInstallHostTransaction(transaction);
          });
        `;
        const run = (direction: string, checkpoint = '') => spawnSync(process.execPath, ['-e', script, direction], {
          cwd: candidate.root, env: { ...env, TEST_RETIREMENT_STOP: checkpoint }, encoding: 'utf8',
        });
        const assertStopped = (result: ReturnType<typeof run>) => expect(result.signal, String(result.stderr)).toBe('SIGKILL');
        if (side === 'recover') assertStopped(run('rollback', 'preimage publish'));
        const userCopy = step === 'same-byte user copy after restore';
        assertStopped(run(side, userCopy ? 'unlink or vault publish' : step));
        const expectedBytes = file === 'managed' ? managed : kind === 'replaced' ? original : null;
        const onDisk = () => existsSync(agent) ? readFileSync(agent) : null;
        expect(onDisk()).toEqual(expectedBytes);
        const interrupted = readLedger(paths);
        if (expectedLedger === 'released') expect(Object.hasOwn(interrupted.paths, agent)).toBe(false);
        else if (expectedLedger === 'original') expect(interrupted.paths[agent]).toEqual(before);
        else expect(interrupted.paths[agent]?.identity).toBe(observeEntryIdentity(agent)!);
        if (vault) expect(readFileSync(vault)).toEqual(original);
        if (userCopy) {
          rmSync(agent);
          writeFileSync(agent, original);
        }
        if (step === 'unlink or vault publish' && kind === 'created') {
          const saved = readFileSync(marker);
          writeFileSync(marker, '{');
          let failure: unknown;
          try { planPathRevertEntry(paths, agent, before, true); } catch (error) { failure = error; }
          expect(failure).toBeInstanceOf(HostConfigError);
          expect(failure).toMatchObject({ code: 'host_config_invalid_state', message: expect.stringContaining(marker) });
          writeFileSync(marker, saved);
        }
        const identity = observeEntryIdentity(agent);
        const recovered = run('recover');
        expect(recovered.status, String(recovered.stderr)).toBe(0);
        expect(onDisk()).toEqual(expectedBytes);
        expect(observeEntryIdentity(agent)).toBe(identity);
        const final = readLedger(paths);
        if (userCopy) expect(final.paths[agent]).toEqual(before);
        else if (file === 'forward') expect(Object.hasOwn(final.paths, agent)).toBe(false);
        else expect(final.paths[agent]).toEqual({ ...before, identity: identity! });
        if (vault) {
          expect(readFileSync(vault)).toEqual(original);
          if (file === 'forward' && !userCopy) expect(final.retired).toContainEqual(expect.objectContaining({ sha256: before.backup }));
          else expect(final.paths[agent]?.backup).toBe(before.backup);
        }
        expect(existsSync(marker)).toBe(false);
        if (step === 'preimage publish') {
          const retried = run('forward');
          expect(retried.status, String(retried.stderr)).toBe(0);
          expect(onDisk()).toEqual(kind === 'replaced' ? original : null);
          expect(Object.hasOwn(readLedger(paths).paths, agent)).toBe(false);
          if (vault) expect(readFileSync(vault)).toEqual(original);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);

  test('B parent builder=30 hands one update to distinct C candidate builder=150', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-candidate-version-bound-'));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    const bin = join(root, 'bin');
    const parentRoot = join(root, 'parent-b');
    const candidateRoot = join(root, 'candidate-c');
    const bunLog = join(root, 'bun.log');
    try {
      mkdirSync(repo, { recursive: true });
      mkdirSync(bin, { recursive: true });
      copyRuntimeFixture(parentRoot, '0.17.0', 30);
      copyRuntimeFixture(candidateRoot, '0.18.0', 150);
      const globalPackagePath = join(home, '.bun', 'install', 'global', 'node_modules', 'repo-harness');
      mkdirSync(join(home, '.bun', 'install', 'global', 'node_modules'), { recursive: true });
      symlinkSync(parentRoot, globalPackagePath, 'dir');
      writeCoreOnlyInstallState(home);
      const predecessor = structuredClone(buildManagedHooks('codex'));
      const stop = predecessor.Stop?.find((entry) => entry.hooks[0]?.command.includes(' Stop --route default'));
      if (!stop) throw new Error('fixture requires Stop.default');
      stop.hooks[0]!.timeout = 30;
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'hooks.json'), `${JSON.stringify({
        hooks: predecessor,
        custom: { preserved: true },
      }, null, 2)}\n`);
      writeCandidateSwitchingBun(root, join(bin, 'bun'), bunLog, globalPackagePath, candidateRoot);

      const result = spawnSync(process.execPath, [
        join(parentRoot, 'src', 'cli', 'index.ts'),
        'update',
        '--target', 'codex',
        '--no-sync-skill',
        '--no-external-skills',
        '--no-codegraph',
        '--json',
      ], {
        cwd: repo,
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: home,
          BUN_INSTALL: join(home, '.bun'),
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          REPO_HARNESS_BUN_EXECUTABLE: join(bin, 'bun'),
        },
      });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      const runtime = JSON.parse(result.stdout) as { steps: Array<{ step: string; status: string; detail?: string }> };
      expect(runtime.steps.find((step) => step.step === 'reconcile installed candidate runtime')).toMatchObject({
        status: 'ok',
        detail: expect.stringContaining('candidate=0.18.0'),
      });
      const installed = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf-8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>>;
        custom: unknown;
      };
      expect(installed.hooks.Stop?.[0]?.hooks[0]?.timeout).toBe(150);
      expect(installed.custom).toEqual({ preserved: true });
      expect(realpathSync(globalPackagePath)).toBe(realpathSync(candidateRoot));
      expect(readFileSync(bunLog, 'utf-8')).toContain(`${candidateRoot}/src/cli/index.ts __reconcile-installed-runtime --request`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  for (const scenario of ['parent-renderer', 'candidate-renderer', 'wrong-version', 'candidate-daemon'] as const) {
    test(`#699 ${scenario}: update binds verification to the installed candidate`, () => {
      const root = mkdtempSync(join(tmpdir(), 'repo-harness-update-699-'));
      const home = join(root, 'home');
      const repo = join(root, 'repo');
      const bin = join(root, 'bin');
      const parentRoot = join(root, 'parent');
      const candidateRoot = join(root, 'candidate');
      const bunLog = join(root, 'bun.log');
      try {
        mkdirSync(repo, { recursive: true });
        mkdirSync(bin, { recursive: true });
        copyRuntimeFixture(parentRoot, '0.21.2', 30);
        copyRuntimeFixture(candidateRoot, '0.22.1', 150);
        if (scenario === 'parent-renderer') requireLegacyRenderer(parentRoot);
        if (scenario === 'candidate-renderer') requireLegacyRenderer(candidateRoot);
        if (scenario === 'candidate-daemon') {
          // Inject a daemon status failure without starting or changing any shared daemon.
          const providerPath = join(candidateRoot, 'src', 'effects', 'architecture', 'archctx-provider.ts');
          const provider = readFileSync(providerPath, 'utf-8');
          const anchor = 'export function verifyArchctxDaemonRuntime(repoRoot: string, options: ArchctxProviderOptions = {}, packageRoot?: string): void {';
          if (!provider.includes(anchor)) throw new Error('fixture requires the daemon inspector');
          writeFileSync(providerPath, provider.replace(anchor, `${anchor}
  throw new Error('User authorization required: daemon fixture needs maintenance');`));
        }
        const globalRoot = join(home, '.bun', 'install', 'global');
        const globalPackage = join(globalRoot, 'node_modules', 'repo-harness');
        mkdirSync(join(globalRoot, 'node_modules'), { recursive: true });
        symlinkSync(parentRoot, globalPackage, 'dir');
        // The renderer and daemon checks belong to the architecture plugin.
        recordPluginSelection({ HOME: home });
        const globalManifest = join(globalRoot, 'package.json');
        const oldManifest = JSON.stringify({ dependencies: { 'repo-harness': '^0.21.2' } });
        writeFileSync(globalManifest, oldManifest);
        const cliBin = join(home, '.bun', 'bin', 'rh');
        mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
        const oldBin = '#!/bin/sh\necho 0.21.2\n';
        writeExecutable(cliBin, oldBin);
        const hookPath = join(home, '.codex', 'hooks.json');
        mkdirSync(join(home, '.codex'), { recursive: true });
        const oldHooks = JSON.stringify({ hooks: {}, custom: 'preserve' });
        writeFileSync(hookPath, oldHooks);
        const statePath = join(home, '.repo-harness', 'install-state.json');
        const oldState = readFileSync(statePath, 'utf-8');
        writeCandidateSwitchingBun(root, join(bin, 'bun'), bunLog, globalPackage, candidateRoot);
        // Model the package manager's manifest and bin writes as well as its package link.
        const bunSource = readFileSync(join(bin, 'bun.fixture-body'), 'utf-8');
        writeShellExecutableFixture(root, join(bin, 'bun'), bunSource.replace(
          'if [[ "$1" == "add" && "$2" == "-g" ]]; then ',
          `if [[ "$1" == "add" && "$2" == "-g" ]]; then printf '%s' '{"dependencies":{"repo-harness":"^0.22.1"}}' > "${globalManifest}"; printf '#!/bin/sh\\necho 0.22.1\\n' > "${cliBin}"; `,
        ));
        const env = {
          ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun'),
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          REPO_HARNESS_BUN_EXECUTABLE: join(bin, 'bun'),
        };
        const args = ['update', '--target', 'codex', '--no-sync-skill', '--no-external-skills', '--no-codegraph', '--json'];
        const result = spawnSync(process.execPath, [join(parentRoot, 'src', 'cli', 'index.ts'), ...args,
          '--version', scenario === 'wrong-version' ? '0.22.2' : '0.22.1'], { cwd: repo, encoding: 'utf-8', env });
        const runtime = JSON.parse(result.stdout);
        const handoff = runtime.steps.find((step: { step: string }) => step.step === 'reconcile installed candidate runtime');
        const log = readFileSync(bunLog, 'utf-8');
        if (scenario === 'parent-renderer' || scenario === 'candidate-daemon') {
          expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
          expect(handoff.status).toBe('ok');
          expect(handoff.detail).toContain('candidate=0.22.1');
          expect(runtime.steps.some((step: { step: string }) => step.step === 'verify managed runtime dependencies')).toBe(false);
          expect(realpathSync(globalPackage)).toBe(realpathSync(candidateRoot));
          expect(JSON.parse(readFileSync(globalManifest, 'utf-8')).dependencies['repo-harness']).toBe('^0.22.1');
          expect(readFileSync(cliBin, 'utf-8')).toContain('0.22.1');
          expect(JSON.parse(readFileSync(hookPath, 'utf-8')).hooks.Stop[0].hooks[0].timeout).toBe(150);
          if (scenario === 'candidate-daemon') {
            expect(handoff.detail).toContain('Daemon readiness pending');
            expect(runtime.lines.join('\n')).toContain('User authorization required: daemon fixture needs maintenance');
          }
          // The same parent verifier must still reject v5 without a handoff.
          if (scenario === 'parent-renderer') {
            const noCli = spawnSync(process.execPath, [join(parentRoot, 'src', 'cli', 'index.ts'), ...args,
              '--version', '0.22.1', '--no-cli'], { cwd: repo, encoding: 'utf-8', env });
            expect(noCli.status).toBe(1);
            expect(noCli.stdout).toContain('archctx architecture docs renderer mismatch');
          }
        } else {
          expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(1);
          expect(handoff).toMatchObject({ status: 'failed' });
          if (scenario === 'candidate-renderer') {
            expect(handoff.stderr).toContain('archctx architecture docs renderer mismatch');
          } else {
            expect(handoff.detail).toContain('expected 0.22.2, got 0.22.1');
          }
          expect(realpathSync(globalPackage)).toBe(realpathSync(parentRoot));
          expect(readFileSync(globalManifest, 'utf-8')).toBe(oldManifest);
          expect(readFileSync(cliBin, 'utf-8')).toBe(oldBin);
          expect(readFileSync(hookPath, 'utf-8')).toBe(oldHooks);
          expect(readFileSync(statePath, 'utf-8')).toBe(oldState);
        }
        expect(log.includes('__reconcile-installed-runtime')).toBe(scenario !== 'wrong-version');
        expect(log).toContain(`add -g repo-harness@${scenario === 'wrong-version' ? '0.22.2' : '0.22.1'} --no-cache`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  }

  test.skipIf(process.platform === 'win32')('candidate update restores staged Antigravity links unless external skills are explicitly disabled', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rh-candidate-antigravity-')));
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const parent = join(root, 'parent');
    const candidate = join(root, 'candidate');
    const bunInstall = join(home, '.bun');
    const globalPackage = join(bunInstall, 'install', 'global', 'node_modules', 'repo-harness');
    const bun = join(bin, 'bun');
    const bunLog = join(root, 'bun.log');
    const providerLog = join(root, 'provider.log');
    const env = { HOME: home, BUN_INSTALL: bunInstall, PATH: `${bin}:${fakeHcBin}:${pathBeforeFakeHc ?? ''}`,
      REPO_HARNESS_BUN_EXECUTABLE: bun, TMPDIR: root };
    const cli = join(parent, 'src', 'cli', 'index.ts');
    const run = (...args: string[]) => spawnSync(process.execPath, ['--no-env-file', cli, ...args], {
      cwd: root, env, encoding: 'utf8',
    });
    try {
      mkdirSync(bin);
      mkdirSync(join(globalPackage, '..'), { recursive: true });
      copyRuntimeFixture(parent, '0.36.0', 30);
      copyRuntimeFixture(candidate, '0.36.1', 30);
      symlinkSync(parent, globalPackage, 'dir');
      writeCoreOnlyInstallState(home);
      writeCandidateSwitchingBun(root, bun, bunLog, globalPackage, candidate, undefined, true);
      const wrapper = readFileSync(`${bun}.fixture-body`, 'utf8');
      writeShellExecutableFixture(root, bun, wrapper.replace(/exit 0\n$/, `if [[ "$1" == "${candidate}/scripts/skill-surface-select.ts" ]]; then exec "${process.execPath}" "$@"; fi\nexit 0\n`));
      for (const command of ['bunx', 'curl']) {
        writeExecutable(join(bin, command), `#!/bin/sh\nprintf '%s\\n' '${command}' >> '${providerLog}'\nexit 1\n`);
      }
      for (const name of ['think', 'hunt', 'check', 'health']) {
        const staged = join(home, '.agents', 'skills', name);
        mkdirSync(staged, { recursive: true });
        writeFileSync(join(staged, 'SKILL.md'), `# ${name}\n`);
      }
      const install = run('install', '--target', 'antigravity');
      expect(install.status, install.stdout + install.stderr).toBe(0);
      const link = join(home, '.gemini', 'config', 'skills', 'think');
      expect(realpathSync(link)).toBe(join(home, '.agents', 'skills', 'think'));
      rmSync(link);

      for (const args of [['--no-external-skills'], []]) {
        const update = run('update', '--no-codegraph', '--json', ...args);
        const runtime = JSON.parse(update.stdout);
        expect(update.status, runtime.stderr).toBe(0);
        expect(runtime.steps).toContainEqual(expect.objectContaining({ step: 'reconcile installed candidate runtime', status: 'ok' }));
        expect(realpathSync(globalPackage)).toBe(candidate);
        expect(existsSync(providerLog)).toBe(false);
        expect(existsSync(link)).toBe(args.length === 0);
      }
      expect(realpathSync(link)).toBe(join(home, '.agents', 'skills', 'think'));
      expect(readFileSync(join(link, 'SKILL.md'), 'utf8')).toBe('# think\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('the leftover summary comes from candidate C after B assets change in place', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-candidate-leftovers-'));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    const bin = join(root, 'bin');
    const parentRoot = join(root, 'parent-b');
    const candidateRoot = join(root, 'candidate-c');
    const bunLog = join(root, 'bun.log');
    try {
      mkdirSync(repo, { recursive: true });
      mkdirSync(bin, { recursive: true });
      copyRuntimeFixture(parentRoot, '0.17.0', 150);
      copyRuntimeFixture(candidateRoot, '0.18.0', 150);
      const globalPackagePath = join(home, '.bun', 'install', 'global', 'node_modules', 'repo-harness');
      mkdirSync(join(home, '.bun', 'install', 'global', 'node_modules'), { recursive: true });
      symlinkSync(parentRoot, globalPackagePath, 'dir');
      writeCoreOnlyInstallState(home);
      writeCandidateSwitchingBun(
        root,
        join(bin, 'bun'),
        bunLog,
        globalPackagePath,
        candidateRoot,
        join(parentRoot, 'assets', 'skill-commands', 'manifest.json'),
      );

      const result = spawnSync(process.execPath, [
        join(parentRoot, 'src', 'cli', 'index.ts'),
        'update',
        '--target', 'codex',
        '--no-sync-skill',
        '--no-external-skills',
        '--no-codegraph',
        '--json',
      ], {
        cwd: repo,
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: home,
          BUN_INSTALL: join(home, '.bun'),
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          REPO_HARNESS_BUN_EXECUTABLE: join(bin, 'bun'),
        },
      });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      const runtime = JSON.parse(result.stdout) as { lines: string[] };
      expect(runtime.lines.filter((line) => /^\d+ leftovers \(\d+ removable\)\. Run: rh upgrade$/.test(line))).toHaveLength(1);
      // The registered-repo line follows the leftover summary.
      expect(runtime.lines.at(-1)).toMatch(/^Registered repos: \d+ of \d+ have pending project upgrade work.* Preview: rh upgrade --registered(\. Apply: rh upgrade --registered --apply --expected-revision sha256:[0-9a-f]{64})?$/);
      expect(readFileSync(bunLog, 'utf-8')).toContain(`${candidateRoot}/src/cli/index.ts upgrade --summary-line`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('frozen legacy B can only bootstrap C; an explicit second C update reconciles its predecessor projection', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-candidate-legacy-migration-'));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    const bin = join(root, 'bin');
    const legacyParentRoot = join(root, 'legacy-b');
    const candidateRoot = join(root, 'candidate-c');
    const bunLog = join(root, 'bun.log');
    try {
      mkdirSync(repo, { recursive: true });
      mkdirSync(bin, { recursive: true });
      copyRuntimeFixture(legacyParentRoot, '0.17.0', 30, true);
      copyRuntimeFixture(candidateRoot, '0.18.0', 150);
      const globalPackagePath = join(home, '.bun', 'install', 'global', 'node_modules', 'repo-harness');
      mkdirSync(join(home, '.bun', 'install', 'global', 'node_modules'), { recursive: true });
      symlinkSync(legacyParentRoot, globalPackagePath, 'dir');
      writeCoreOnlyInstallState(home);
      writeCandidateSwitchingBun(root, join(bin, 'bun'), bunLog, globalPackagePath, candidateRoot);
      const sharedEnv = {
        ...process.env,
        HOME: home,
        BUN_INSTALL: join(home, '.bun'),
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        REPO_HARNESS_BUN_EXECUTABLE: join(bin, 'bun'),
      };
      const updateArgs = ['update', '--target', 'codex', '--no-sync-skill', '--no-external-skills', '--no-codegraph', '--json'];

      const bootstrap = spawnSync(process.execPath, [join(legacyParentRoot, 'src', 'cli', 'index.ts'), ...updateArgs], {
        cwd: repo,
        encoding: 'utf-8',
        env: sharedEnv,
      });
      expect(bootstrap.status, `${bootstrap.stderr}\n${bootstrap.stdout}`).toBe(0);
      expect(realpathSync(globalPackagePath)).toBe(realpathSync(candidateRoot));
      const bootstrappedHooks = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf-8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>>;
      };
      expect(bootstrappedHooks.hooks.Stop?.[0]?.hooks[0]?.timeout).toBe(30);

      const reconciled = spawnSync(process.execPath, [join(candidateRoot, 'src', 'cli', 'index.ts'), ...updateArgs], {
        cwd: repo,
        encoding: 'utf-8',
        env: sharedEnv,
      });
      expect(reconciled.status, `${reconciled.stderr}\n${reconciled.stdout}`).toBe(0);
      const reconciledHooks = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf-8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>>;
      };
      expect(reconciledHooks.hooks.Stop?.[0]?.hooks[0]?.timeout).toBe(150);
      expect(JSON.parse(reconciled.stdout).steps.find((step: { step: string }) => step.step === 'reconcile installed candidate runtime')).toMatchObject({
        status: 'ok',
        detail: expect.stringContaining('candidate=0.18.0'),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  // This test copies two runtimes and runs two complete updates.
  // The full-suite run reached 32.5 seconds; one update is not the full budget.
  }, 60_000);

  // The candidate's hc step result reaches the parent for each branch: the
  // PATH hint of a fresh install (the review finding), the update and the no-change line.
  test.each([
    { label: 'missing hc, ~/.local/bin off PATH', hcBefore: null, requests: 1,
      lines: (dir: string) => [`[runtime] ok: ensure herdr-core (hc) - installed hc ${HC_MIN_VERSION} (sha256 verified) into ${dir}`, `add ${dir} to PATH to use hc; this run uses it for its later steps`] },
    { label: 'hc below the floor', hcBefore: '0.1.15', requests: 0,
      lines: (_dir: string, hc: string) => [`[runtime] ok: ensure herdr-core (hc) - hc client 0.1.15 was below the repo-harness floor ${HC_MIN_VERSION}; hc update --version ${HC_MIN_VERSION} updated it to ${HC_MIN_VERSION} at ${hc}`] },
    { label: 'hc at the floor', hcBefore: HC_MIN_VERSION, requests: 0,
      lines: (_dir: string, hc: string) => [`[runtime] ok: ensure herdr-core (hc) - hc ${HC_MIN_VERSION} at ${hc} is at or above ${HC_MIN_VERSION}; no change`] },
  ])('the default update shows the hc step result of candidate C: $label', async ({ hcBefore, requests, lines }) => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-candidate-hc-'));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    const bin = join(root, 'bin');
    const hcBin = join(root, 'hc-bin');
    const pkg = join(root, 'pkg');
    const release = join(root, 'release');
    const parentRoot = join(root, 'parent-b');
    const candidateRoot = join(root, 'candidate-c');
    const bunLog = join(root, 'bun.log');
    const server = startFakeHcRelease(root, release);
    // An hc that answers --version and --skill; `update --version X` sets its version to X.
    const fakeHc = (versionFile: string) => `#!/bin/sh\nif [ "\${1:-}" = --skill ]; then printf '%s\\n' '# hc manual (herdr-core)' '' '\`$HC_TERMINAL_ID\` is your address.'; `
      + `elif [ "\${1:-}" = update ]; then printf '%s' "$3" > "${versionFile}"; else printf 'hc %s\\n' "$(cat "${versionFile}")"; fi\n`;
    try {
      for (const dir of [repo, bin, hcBin, pkg, release]) mkdirSync(dir, { recursive: true });
      copyRuntimeFixture(parentRoot, '0.17.0', 30);
      copyRuntimeFixture(candidateRoot, '0.18.0', 30);
      writeFileSync(join(root, 'release-version'), HC_MIN_VERSION);
      writeExecutable(join(pkg, 'herdr-core'), fakeHc(join(root, 'release-version')));
      if (hcBefore !== null) {
        writeFileSync(join(root, 'hc-version'), hcBefore);
        writeExecutable(join(hcBin, 'hc'), fakeHc(join(root, 'hc-version')));
      }
      expect(spawnSync('tar', ['-czf', join(release, 'herdr-core.tar.gz'), '-C', pkg, 'herdr-core']).status).toBe(0);
      const sha256 = createHash('sha256').update(readFileSync(join(release, 'herdr-core.tar.gz'))).digest('hex');
      const url = `http://127.0.0.1:${await server.port}/herdr-core.tar.gz`;
      // Candidate C reads its own package pin; it points at the fake release.
      const assets = Object.fromEntries(['linux-aarch64', 'linux-x86_64', 'macos-aarch64', 'macos-x86_64', 'windows-x86_64'].map(name => [name, { url, sha256 }]));
      writeFileSync(join(candidateRoot, 'src', 'core', 'terminal', 'herdr-core-pin.json'), `${JSON.stringify({ min_version: HC_MIN_VERSION, release_assets: assets }, null, 2)}\n`);
      const globalPackagePath = join(home, '.bun', 'install', 'global', 'node_modules', 'repo-harness');
      mkdirSync(join(home, '.bun', 'install', 'global', 'node_modules'), { recursive: true });
      symlinkSync(parentRoot, globalPackagePath, 'dir');
      writeCoreOnlyInstallState(home);
      writeCandidateSwitchingBun(root, join(bin, 'bun'), bunLog, globalPackagePath, candidateRoot);

      const result = spawnSync(process.execPath, [
        join(parentRoot, 'src', 'cli', 'index.ts'),
        'update', '--target', 'codex', '--no-sync-skill', '--no-external-skills', '--no-codegraph', '--json',
      ], {
        cwd: repo,
        encoding: 'utf-8',
        // An explicit PATH: the fake hc dir or no hc, and never ~/.local/bin.
        env: { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun'), PATH: `${bin}:${hcBin}:/usr/bin:/bin`, REPO_HARNESS_BUN_EXECUTABLE: join(bin, 'bun') },
      });

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      const runtime = JSON.parse(result.stdout) as { steps: Array<{ step: string; status: string; detail?: string }> };
      const reconcile = runtime.steps.find((step) => step.step === 'reconcile installed candidate runtime');
      expect(reconcile?.status).toBe('ok');
      for (const line of lines(join(home, '.local', 'bin'), join(hcBin, 'hc'))) expect(reconcile?.detail).toContain(line);
      expect(server.requests()).toHaveLength(requests);
    } finally {
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test.each(['repository ledger migration', 'fleet reconciliation'])('a 0.35.2 parent completes rollback after candidate %s fails', (failure) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'repo-harness-candidate-protocol4-')));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    const bin = join(root, 'bin');
    const parent = join(root, 'parent');
    const candidate = join(root, 'candidate');
    const bun = join(bin, 'bun');
    const bunInstall = join(root, 'bun-install');
    const globalPackage = join(bunInstall, 'install', 'global', 'node_modules', 'repo-harness');
    const env = { HOME: home, BUN_INSTALL: bunInstall, PATH: `${bin}:${fakeHcBin}:/usr/bin:/bin`, REPO_HARNESS_BUN_EXECUTABLE: bun };
    try {
      for (const dir of [home, repo, bin, parent, join(globalPackage, '..')]) mkdirSync(dir, { recursive: true });
      // The unmodified 0.35.2 runtime reads protocol 4 and runs the parent rollback.
      const archive = spawnSync('git', ['archive', 'c1339a0edde952ea4294df9b307bef4d9d65240c', 'package.json', 'src', 'assets', 'scripts', 'agents', 'interfaces', 'packages'], { cwd: ROOT, env, maxBuffer: 32 * 1024 * 1024 });
      expect(archive.status, archive.stderr.toString()).toBe(0);
      const extract = spawnSync('tar', ['-xf', '-', '-C', parent], { input: archive.stdout, env });
      expect(extract.status, extract.stderr.toString()).toBe(0);
      symlinkSync(join(ROOT, 'node_modules'), join(parent, 'node_modules'), 'dir');
      symlinkSync(parent, globalPackage, 'dir');
      copyRuntimeFixture(candidate, '0.36.0', 30);
      writeCoreOnlyInstallState(home);
      writeCandidateSwitchingBun(root, bun, join(root, 'bun.log'), globalPackage, candidate, undefined, true);

      const config = join(home, '.repo-harness', 'config');
      mkdirSync(config, { recursive: true });
      const ledger = join(config, 'ledger.json');
      const protocol4 = { ...EMPTY_LEDGER, protocol: 4, paths: {} as Record<string, unknown> };
      const movedRepo = join(config, 'repos', 'a', 'ledger.json');
      const repoBefore = JSON.stringify(protocol4);
      let liveFiles: Array<{ path: string; bytes: string; identity?: number }> = [];
      if (failure === 'repository ledger migration') {
        const brokenRepo = join(config, 'repos', 'b', 'ledger.json');
        for (const path of [movedRepo, brokenRepo]) mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(movedRepo, repoBefore);
        writeFileSync(brokenRepo, JSON.stringify({ ...protocol4, paths: null }));
      } else {
        const agents = join(home, '.claude', 'agents');
        const backups = join(home, '.repo-harness', 'replaced-agents');
        mkdirSync(agents, { recursive: true });
        mkdirSync(backups, { recursive: true });
        liveFiles = ['explorer', 'deep-reasoner', 'harness-evaluator'].map((name, index) => {
          const file = `${name}.md`;
          const path = join(agents, file);
          const bytes = readFileSync(join(candidate, 'agents', 'fleet', file), 'utf8') + (index === 2 ? '\nprevious fleet version\n' : '');
          writeFileSync(path, bytes);
          writeFileSync(join(backups, `claude-${file}.2026-01-01T00-00-00-000Z-1.bak`), 'original user file\n');
          if (index > 0) protocol4.paths[path] = { owner: 'core', host: 'claude', kind: 'created', baseline: { state: 'unknown' }, committed: { type: 'file', sha256: sha256Prefixed(bytes) } };
          return { path, bytes, identity: index < 2 ? lstatSync(path).ino : undefined };
        });
        const codexAgents = join(home, '.codex', 'agents');
        mkdirSync(codexAgents, { recursive: true });
        writeFileSync(join(codexAgents, 'explorer.toml'), 'drift stops reconciliation\n');
      }
      const snapshot = Buffer.from(JSON.stringify(protocol4));
      writeFileSync(ledger, snapshot);
      const result = spawnSync(process.execPath, [join(parent, 'src', 'cli', 'index.ts'), 'update', '--target', 'claude', '--no-sync-skill', '--no-external-skills', '--no-codegraph', '--json'], {
        cwd: repo, encoding: 'utf8', env,
      });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout + result.stderr).toContain(failure === 'repository ledger migration' ? 'the protocol 4 ledger has an invalid shape' : '[runtime] failed: install agent fleet');
      expect(readFileSync(ledger)).toEqual(snapshot);
      expect(realpathSync(globalPackage)).toBe(parent);
      expect(readdirSync(runtimeTransactionRoot(globalRuntimeScope(env))).filter((name) => name.startsWith('install-'))).toEqual([]);
      if (failure === 'repository ledger migration') expect(readFileSync(movedRepo, 'utf8')).toBe(repoBefore);
      for (const { path, bytes, identity } of liveFiles) {
        expect(readFileSync(path, 'utf8')).toBe(bytes);
        if (identity !== undefined) expect(lstatSync(path).ino).toBe(identity);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('a candidate failure after projection restores the predecessor adapter through the parent transaction', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-candidate-rollback-'));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    const bin = join(root, 'bin');
    try {
      mkdirSync(repo, { recursive: true });
      mkdirSync(bin, { recursive: true });
      const globalModules = join(home, '.bun', 'install', 'global', 'node_modules');
      seedGlobalPackageFixture({ HOME: home, BUN_INSTALL: join(home, '.bun') });
      mkdirSync(join(home, '.repo-harness'), { recursive: true });
      writeFileSync(installStateFixturePath({ HOME: home }), `${JSON.stringify({
        protocol: 5,
        selection: [],
        ...versions([]),
        transaction_id: 'predecessor-install',
        applied_at: '2026-09-04T00:00:00.000Z',
        previous: null,
      }, null, 2)}\n`);
      const predecessor = structuredClone(buildManagedHooks('codex'));
      const stop = predecessor.Stop?.find((entry) => entry.hooks[0]?.command.includes(' Stop --route default'));
      if (!stop) throw new Error('fixture requires Stop.default');
      stop.hooks[0]!.timeout = 30;
      mkdirSync(join(home, '.codex'), { recursive: true });
      writeFileSync(join(home, '.codex', 'hooks.json'), `${JSON.stringify({ hooks: predecessor }, null, 2)}\n`);
      writeShellExecutableFixture(root, join(bin, 'bun'), [
        '#!/bin/bash',
        'if [[ "${1:-}" == "--version" ]]; then echo 1.4.0; exit 0; fi',
        `if [[ "\${1:-}" == "pm" && "\${2:-}" == "view" ]]; then printf '%s\\n' '${JSON.stringify(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version)}'; exit 0; fi`,
        `if [[ "\${1:-}" == "${ROOT}/src/cli/index.ts" || "\${1:-}" == "${join(globalModules, 'repo-harness', 'src', 'cli', 'index.ts')}" || "\${1:-}" == "${ROOT}/scripts/"* ]]; then exec "${process.execPath}" "$@"; fi`,
        'exit 0',
        '',
      ].join('\n'));

      const result = spawnSync(process.execPath, [
        CLI,
        'update',
        '--no-external-skills',
        '--no-codegraph',
        '--json',
      ], {
        cwd: repo,
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: home,
          BUN_INSTALL: join(home, '.bun'),
          PATH: `${bin}:/usr/bin:/bin`,
          REPO_HARNESS_BUN_EXECUTABLE: join(bin, 'bun'),
        },
      });

      expect(result.status).toBe(1);
      const installed = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf-8')) as {
        hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>>;
      };
      expect(installed.hooks.Stop?.[0]?.hooks[0]?.timeout).toBe(30);
      expect(existsSync(join(home, '.codex', 'skills', 'repo-harness'))).toBe(false);
      expect(JSON.parse(readFileSync(join(home, '.repo-harness', 'install-state.json'), 'utf-8')).transaction_id).toBe('predecessor-install');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
