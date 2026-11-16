import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { sha256Prefixed } from '../../core/evidence/sha256';
import { planFile, type FilePlan } from '../../core/host-config/plan';
import { classifyFile, expectedFromCommitted, recoveryAction, sameExpected } from '../../core/host-config/recovery';
import {
  HostConfigError,
  type ExpectedFile,
  type FileRecord,
  type FragmentRecord,
  type FragmentRequest,
  type HostConfigLedger,
  type SkippedOverride,
  type TransactionFileEntry,
  type TransactionRecord,
} from '../../core/host-config/types';
import { globalRuntimeScope, withRuntimeTransactionContext, type RuntimeTransactionContext } from '../locking/runtime-transaction-lock';
import {
  assertHostPath,
  createDirectories,
  ensurePrivateDirectory,
  expectedOf,
  hostConfigPaths,
  listTransactionRecords,
  missingDirectories,
  observeFile,
  platformMode,
  putVault,
  readLedger,
  readPreimageCopy,
  removeCreatedDirectories,
  removePreimageCopy,
  removeTarget,
  removeTransaction,
  replaceTarget,
  targetTemporary,
  transactionDirectory,
  writeLedger,
  writePreimageCopy,
  writeTransactionRecord,
  type HostConfigPaths,
} from './store';

export type HostConfigFaultPoint = 'after-record' | 'after-rename' | 'after-ledger' | 'after-cleanup';

/** Test seam: a hook at each fault point. `path` names the file for `after-rename`. */
export interface HostConfigFaults {
  at(point: HostConfigFaultPoint, path?: string): void;
}

export interface HostConfigFileChange {
  readonly path: string;
  readonly fragments: readonly FragmentRequest[];
  /** Mode of a file the transaction creates. An existing target keeps its mode. */
  readonly createMode?: number;
  /** An earlier rh version wrote this path before the ledger existed. */
  readonly baselineUnknown?: boolean;
}

export interface HostConfigApplyResult {
  readonly txn: string | null;
  readonly written: readonly string[];
  readonly skipped: readonly SkippedOverride[];
}

export interface HostConfigDelegateResult {
  readonly txn: string;
  readonly changed: readonly string[];
}

export interface UnresolvedHostConfigChange {
  readonly code: 'host_config_unresolved_external_change';
  readonly txn: string;
  readonly path: string;
}

export interface HostConfigRecoveryReport {
  readonly unresolved: readonly UnresolvedHostConfigChange[];
}

export interface HostConfigGateOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** A held runtime transaction lock; without it the gate takes the lock for each call. */
  readonly runtimeLock?: RuntimeTransactionContext;
  readonly faults?: HostConfigFaults;
}

export interface HostConfigGate {
  apply(changes: readonly HostConfigFileChange[]): HostConfigApplyResult;
  /** Only for out-of-process writers: `run` may write the declared paths, and the gate records them. */
  delegate(declaredPaths: readonly string[], run: () => void): HostConfigDelegateResult;
  recover(): HostConfigRecoveryReport;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function newTransactionId(): string {
  return `txn-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

function preimageCopyName(index: number): string {
  return `preimage-${index}`;
}

function unresolvedError(unresolved: readonly UnresolvedHostConfigChange[], cause?: unknown): HostConfigError {
  const list = unresolved.map((entry) => `${entry.path} (${entry.txn})`).join(', ');
  return new HostConfigError('host_config_unresolved_external_change', `another writer changed a host file; the preimage stays in the journal: ${list}`, { cause });
}

function withLedger(ledger: HostConfigLedger, files: Record<string, FileRecord>, fragments: readonly FragmentRecord[], txn?: string): HostConfigLedger {
  return {
    protocol: 1,
    committed_transactions: txn ? [...ledger.committed_transactions, txn] : ledger.committed_transactions,
    files,
    fragments,
  };
}

/**
 * Roll back or recover one transaction with the pure decision of
 * `recoveryAction`. `attempted` limits an in-process rollback to the files
 * whose rename may have run; recovery after a kill passes null and checks all.
 * Returns the files that stay unresolved; the record keeps only those.
 */
function settleTransaction(paths: HostConfigPaths, record: TransactionRecord, attempted: ReadonlySet<string> | null): UnresolvedHostConfigChange[] {
  const ledger = readLedger(paths);
  const committed = ledger.committed_transactions.includes(record.txn);
  const files = { ...ledger.files };
  let ledgerChanged = false;
  const remaining: TransactionFileEntry[] = [];
  // Reverse order: a file that a later entry put in a new directory goes before that directory is removed.
  for (const entry of [...record.files].reverse()) {
    rmSync(targetTemporary(entry.path, record.txn), { force: true });
    if (attempted && !attempted.has(entry.path)) continue;
    const recorded = files[entry.path];
    const intended: ExpectedFile | null = entry.intended
      ?? (committed && recorded?.committed.txn === record.txn ? expectedFromCommitted(recorded.committed) : null);
    const action = recoveryAction(classifyFile(observeFile(entry.path).observation, entry.preimage, intended), committed);
    if (action === 'unresolved') { remaining.push(entry); continue; }
    if (action === 'mark_external_change') {
      if (!recorded) throw new HostConfigError('host_config_invalid_state', `a committed transaction has no file record: ${entry.path}`);
      files[entry.path] = { ...recorded, external_change: true };
      ledgerChanged = true;
      continue;
    }
    if (action === 'restore_preimage' && intended) {
      try {
        if (entry.preimage.existed && entry.preimage_copy) {
          const bytes = readPreimageCopy(paths, record.txn, entry.preimage_copy, entry.preimage.sha256);
          replaceTarget(entry.path, record.txn, bytes, entry.preimage.mode, intended, () => {});
        } else {
          removeTarget(entry.path, intended);
          removeCreatedDirectories(entry.created_dirs);
        }
      } catch (error) {
        if (!(error instanceof HostConfigError && error.code === 'host_config_target_changed')) throw error;
        remaining.push(entry);
      }
    }
  }
  if (ledgerChanged) writeLedger(paths, withLedger(ledger, files, ledger.fragments));
  if (remaining.length === 0) {
    removeTransaction(paths, record.txn);
    return [];
  }
  for (const entry of record.files) {
    if (entry.preimage_copy && !remaining.includes(entry)) removePreimageCopy(paths, record.txn, entry.preimage_copy);
  }
  writeTransactionRecord(paths, { ...record, stage: 'unresolved', files: remaining });
  return remaining.map((entry) => ({ code: 'host_config_unresolved_external_change', txn: record.txn, path: entry.path }));
}

function recoverAll(paths: HostConfigPaths): UnresolvedHostConfigChange[] {
  return listTransactionRecords(paths).flatMap((record) => settleTransaction(paths, record, null));
}

function prepareStorage(paths: HostConfigPaths): void {
  for (const directory of [paths.root, paths.vault, paths.journal]) ensurePrivateDirectory(paths, directory);
}

/** Validate the targets and refuse a path that an unresolved record still holds. */
function admitPaths(paths: HostConfigPaths, targets: readonly string[], unresolved: readonly UnresolvedHostConfigChange[]): void {
  if (new Set(targets).size !== targets.length) throw new HostConfigError('host_config_invalid_state', 'a transaction names one path twice');
  for (const path of targets) assertHostPath(paths, path);
  const held = unresolved.filter((entry) => targets.includes(entry.path));
  if (held.length) throw unresolvedError(held);
}

/** Write the preimage copies, then fsync the record; no target write happens before this returns. */
function recordTransaction(paths: HostConfigPaths, record: TransactionRecord, preimages: ReadonlyMap<string, Buffer>): void {
  ensurePrivateDirectory(paths, transactionDirectory(paths, record.txn));
  for (const entry of record.files) {
    const bytes = preimages.get(entry.path);
    if (entry.preimage_copy && bytes) writePreimageCopy(paths, record.txn, entry.preimage_copy, bytes);
  }
  writeTransactionRecord(paths, record);
}

function settleAfterFailure(paths: HostConfigPaths, record: TransactionRecord, attempted: ReadonlySet<string> | null, error: unknown): never {
  const unresolved = settleTransaction(paths, record, attempted);
  if (unresolved.length) throw unresolvedError(unresolved, error);
  throw error;
}

function nextFileRecord(previous: FileRecord | undefined, preimage: ExpectedFile, committed: FileRecord['committed'], createdDirs: readonly string[], baselineUnknown: boolean): FileRecord {
  if (!previous) {
    return {
      baseline: baselineUnknown ? { state: 'unknown' }
        : preimage.existed ? { state: 'known', existed: true, type: 'file', mode: preimage.mode, sha256: preimage.sha256 }
        : { state: 'known', existed: false },
      committed,
      external_change: false,
      created_dirs: createdDirs,
    };
  }
  return {
    baseline: previous.baseline,
    committed,
    external_change: previous.external_change || !sameExpected(preimage, expectedFromCommitted(previous.committed)),
    created_dirs: [...previous.created_dirs, ...createdDirs.filter((directory) => !previous.created_dirs.includes(directory))],
  };
}

/** A refresh keeps the first record's kind and removed text, so the ledger always holds the text before rh. */
function nextFragments(paths: HostConfigPaths, ledger: HostConfigLedger, plans: readonly FilePlan[]): FragmentRecord[] {
  const replaced = new Set<FragmentRecord>();
  const added: FragmentRecord[] = [];
  for (const plan of plans) {
    for (const fragment of plan.fragments) {
      const { previous, edit } = fragment;
      if (previous) {
        replaced.add(previous);
        const removed = 'removed_vault' in previous.edit ? { removed_vault: previous.edit.removed_vault } : { removed: previous.edit.removed };
        added.push({ ...previous, edit: { at: edit.at, inserted: edit.inserted, ...removed } });
      } else {
        added.push({
          file: plan.file,
          owner: fragment.owner,
          selector: fragment.selector,
          kind: fragment.kind,
          edit: fragment.kind === 'override'
            ? { at: edit.at, removed_vault: putVault(paths, Buffer.from(edit.removed, 'utf8')), inserted: edit.inserted }
            : edit,
          state: 'active',
        });
      }
    }
  }
  return [...ledger.fragments.filter((record) => !replaced.has(record)), ...added];
}

function applyChanges(paths: HostConfigPaths, changes: readonly HostConfigFileChange[], faults: HostConfigFaults | undefined): HostConfigApplyResult {
  prepareStorage(paths);
  admitPaths(paths, changes.map((change) => change.path), recoverAll(paths));
  const ledger = readLedger(paths);
  const txn = newTransactionId();
  const skipped: SkippedOverride[] = [];
  const claimedDirs = new Set<string>();
  const work: { change: HostConfigFileChange; plan: FilePlan; entry: TransactionFileEntry; preimage: Buffer | null }[] = [];
  for (const [index, change] of changes.entries()) {
    const { observation, bytes } = observeFile(change.path);
    const preimage = expectedOf(observation, change.path);
    let content: string;
    try { content = bytes === null ? '' : UTF8.decode(bytes); }
    catch { throw new HostConfigError('host_config_invalid_state', `not UTF-8 text: ${change.path}`); }
    const plan = planFile(change.path, content, change.fragments, ledger.fragments);
    skipped.push(...plan.skipped);
    if (plan.fragments.length === 0 || (bytes !== null && plan.result === content)) continue;
    const createdDirs = missingDirectories(paths, change.path).filter((directory) => !claimedDirs.has(directory));
    for (const directory of createdDirs) claimedDirs.add(directory);
    const result = Buffer.from(plan.result, 'utf8');
    const mode = preimage.existed ? preimage.mode : platformMode(change.createMode ?? 0o600);
    work.push({
      change,
      plan,
      preimage: bytes,
      entry: {
        path: change.path,
        preimage,
        preimage_copy: preimage.existed ? preimageCopyName(index) : null,
        intended: { existed: true, mode, sha256: sha256Prefixed(result) },
        created_dirs: createdDirs,
      },
    });
  }
  if (work.length === 0) return { txn: null, written: [], skipped };

  const record: TransactionRecord = { protocol: 1, txn, intended: 'write', stage: 'recorded', files: work.map((item) => item.entry) };
  recordTransaction(paths, record, new Map(work.flatMap((item) => (item.preimage ? [[item.change.path, item.preimage] as const] : []))));
  faults?.at('after-record');

  const attempted = new Set<string>();
  try {
    for (const { entry, plan } of work) {
      createDirectories(entry.created_dirs);
      if (!entry.intended?.existed) throw new HostConfigError('host_config_invalid_state', `a write needs an intended file: ${entry.path}`);
      replaceTarget(entry.path, txn, Buffer.from(plan.result, 'utf8'), entry.intended.mode, entry.preimage, () => attempted.add(entry.path));
      faults?.at('after-rename', entry.path);
    }
    const files = { ...ledger.files };
    for (const { change, entry } of work) {
      if (!entry.intended?.existed) continue;
      files[entry.path] = nextFileRecord(ledger.files[entry.path], entry.preimage,
        { type: 'file', sha256: entry.intended.sha256, mode: entry.intended.mode, txn }, entry.created_dirs, change.baselineUnknown === true);
    }
    writeLedger(paths, withLedger(ledger, files, nextFragments(paths, ledger, work.map((item) => item.plan)), txn));
  } catch (error) {
    settleAfterFailure(paths, record, attempted, error);
  }
  faults?.at('after-ledger');
  removeTransaction(paths, txn);
  faults?.at('after-cleanup');
  return { txn, written: work.map((item) => item.entry.path), skipped };
}

function delegateWrite(paths: HostConfigPaths, declaredPaths: readonly string[], run: () => void, faults: HostConfigFaults | undefined): HostConfigDelegateResult {
  prepareStorage(paths);
  admitPaths(paths, declaredPaths, recoverAll(paths));
  const txn = newTransactionId();
  const preimages = new Map<string, Buffer>();
  const entries = declaredPaths.map((path, index): TransactionFileEntry => {
    const { observation, bytes } = observeFile(path);
    const preimage = expectedOf(observation, path);
    if (bytes !== null) preimages.set(path, bytes);
    return { path, preimage, preimage_copy: preimage.existed ? preimageCopyName(index) : null, intended: null, created_dirs: [] };
  });
  const record: TransactionRecord = { protocol: 1, txn, intended: 'delegated', stage: 'recorded', files: entries };
  recordTransaction(paths, record, preimages);
  faults?.at('after-record');

  const changed: string[] = [];
  try {
    run();
    const ledger = readLedger(paths);
    const files = { ...ledger.files };
    for (const entry of entries) {
      const result = expectedOf(observeFile(entry.path).observation, entry.path);
      if (sameExpected(result, entry.preimage)) continue;
      changed.push(entry.path);
      files[entry.path] = nextFileRecord(ledger.files[entry.path], entry.preimage,
        result.existed ? { type: 'file', sha256: result.sha256, mode: result.mode, txn } : { type: 'absent', txn }, [], false);
    }
    writeLedger(paths, withLedger(ledger, files, ledger.fragments, txn));
  } catch (error) {
    settleAfterFailure(paths, record, null, error);
  }
  faults?.at('after-ledger');
  removeTransaction(paths, txn);
  faults?.at('after-cleanup');
  return { txn, changed };
}

export function openHostConfigGate(options: HostConfigGateOptions = {}): HostConfigGate {
  const env = options.env ?? process.env;
  const paths = hostConfigPaths(env);
  const locked = <T>(run: () => T): T => withRuntimeTransactionContext(globalRuntimeScope(env), options.runtimeLock, run);
  return {
    apply: (changes) => locked(() => applyChanges(paths, changes, options.faults)),
    delegate: (declaredPaths, run) => locked(() => delegateWrite(paths, declaredPaths, run, options.faults)),
    recover: () => locked(() => {
      prepareStorage(paths);
      return { unresolved: recoverAll(paths) };
    }),
  };
}
