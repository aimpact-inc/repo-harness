import { lstatSync, readFileSync, type Stats } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { sha256Prefixed } from '../core/evidence/sha256';
import { PANE_PREFIX } from '../core/terminal/pane-prefix';
import type {
  RepoHarnessRegisteredRepo,
  RepoHarnessRegistryStrictErrorCode,
  RepoHarnessRegistryStrictSnapshot,
} from './repo-registry';

type StrictRegistryRules = {
  readonly registryError: (code: RepoHarnessRegistryStrictErrorCode, message: string, cause?: unknown) => Error;
  readonly canonicalRepoPath: (path: string) => string;
  readonly repoHarnessRepoIdFor: (path: string) => string;
  readonly panePrefixOf: (entry: { readonly panePrefix?: unknown }) => { readonly panePrefix?: string };
};

function strictRegistryEntry(value: unknown, index: number, rules: StrictRegistryRules): RepoHarnessRegisteredRepo {
  const { registryError, canonicalRepoPath, repoHarnessRepoIdFor, panePrefixOf } = rules;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw registryError('fleet_registry_invalid', `registry repo ${index} must be an object`);
  }
  const entry = value as Record<string, unknown>;
  const expected = ['accessMode', 'id', 'lastSeenAt', ...('panePrefix' in entry ? ['panePrefix'] : []), 'path', 'registeredAt', 'source'];
  const keys = Object.keys(entry).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw registryError('fleet_registry_invalid', `registry repo ${index} fields are invalid`);
  }
  if (typeof entry.id !== 'string' || entry.id.trim() === '') {
    throw registryError('fleet_registry_invalid', `registry repo ${index} id is invalid`);
  }
  if (typeof entry.path !== 'string' || entry.path.trim() === '' || !isAbsolute(entry.path) || resolve(entry.path) !== entry.path) {
    throw registryError('fleet_registry_invalid', `registry repo ${index} path is invalid`);
  }
  const canonicalPath = canonicalRepoPath(entry.path);
  if (canonicalPath !== entry.path) {
    throw registryError('fleet_registry_invalid', `registry repo ${index} path is not canonical`);
  }
  if (entry.id !== repoHarnessRepoIdFor(canonicalPath)) {
    throw registryError('fleet_registry_invalid', `registry repo ${index} id does not match its canonical path`);
  }
  if (entry.accessMode !== 'read_only' && entry.accessMode !== 'read_write') {
    throw registryError('fleet_registry_invalid', `registry repo ${index} access mode is invalid`);
  }
  if (entry.source !== 'adopt' && entry.source !== 'init' && entry.source !== 'mcp-setup'
    && entry.source !== 'manual' && entry.source !== 'discovery') {
    throw registryError('fleet_registry_invalid', `registry repo ${index} source is invalid`);
  }
  if (typeof entry.registeredAt !== 'string' || entry.registeredAt.trim() === ''
    || typeof entry.lastSeenAt !== 'string' || entry.lastSeenAt.trim() === '') {
    throw registryError('fleet_registry_invalid', `registry repo ${index} timestamps are invalid`);
  }
  if ('panePrefix' in entry && (typeof entry.panePrefix !== 'string' || !PANE_PREFIX.test(entry.panePrefix))) {
    throw registryError('fleet_registry_invalid', `registry repo ${index} panePrefix must match ${PANE_PREFIX.source}`);
  }
  return Object.freeze({
    id: entry.id,
    path: entry.path,
    accessMode: entry.accessMode,
    source: entry.source,
    registeredAt: entry.registeredAt,
    lastSeenAt: entry.lastSeenAt,
    ...panePrefixOf(entry),
  });
}

export function readStrictRegistryFile(registryPath: string, rules: StrictRegistryRules): RepoHarnessRegistryStrictSnapshot {
  const { registryError } = rules;
  let stat: Stats;
  try {
    stat = lstatSync(registryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Object.freeze({
        registryPath,
        authorizationRevision: 0,
        registryRevision: sha256Prefixed('repo-harness-registry-v1:empty'),
        repos: Object.freeze([]),
      });
    }
    throw registryError('fleet_registry_unavailable', `cannot inspect registry authority: ${registryPath}`, error);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw registryError('fleet_registry_invalid', `registry authority is not a regular file: ${registryPath}`);
  }
  let raw: string;
  try {
    raw = readFileSync(registryPath, 'utf-8');
  } catch (error) {
    throw registryError('fleet_registry_unavailable', `cannot read registry authority: ${registryPath}`, error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw registryError('fleet_registry_invalid', `registry authority is not valid JSON: ${registryPath}`, error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw registryError('fleet_registry_invalid', 'registry authority must be an object');
  }
  const record = parsed as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(['authorizationRevision', 'repos', 'version'])) {
    throw registryError('fleet_registry_invalid', 'registry authority fields are invalid');
  }
  if (record.version !== 1 || !Number.isInteger(record.authorizationRevision) || (record.authorizationRevision as number) < 0) {
    throw registryError('fleet_registry_invalid', 'registry authority version or revision is invalid');
  }
  if (!Array.isArray(record.repos)) {
    throw registryError('fleet_registry_invalid', 'registry authority repos must be an array');
  }
  const repos = record.repos.map((value, index) => strictRegistryEntry(value, index, rules));
  const ids = new Set<string>();
  const paths = new Set<string>();
  const prefixes = new Set<string>();
  for (const repo of repos) {
    if (ids.has(repo.id) || paths.has(repo.path)) {
      throw registryError('fleet_registry_invalid', 'registry authority has duplicate repository identities');
    }
    if (repo.panePrefix !== undefined && prefixes.has(repo.panePrefix)) {
      throw registryError('fleet_registry_invalid', `registry authority has duplicate pane prefix ${repo.panePrefix}`);
    }
    ids.add(repo.id);
    paths.add(repo.path);
    if (repo.panePrefix !== undefined) prefixes.add(repo.panePrefix);
  }
  return Object.freeze({
    registryPath,
    authorizationRevision: record.authorizationRevision as number,
    registryRevision: sha256Prefixed(raw),
    repos: Object.freeze([...repos].sort((left, right) => left.id.localeCompare(right.id))),
  });
}
