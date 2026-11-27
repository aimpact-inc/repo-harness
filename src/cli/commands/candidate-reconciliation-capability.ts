import { randomUUID } from 'crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { isPathInside } from '../../effects/path-containment';
import { readExclusiveDirectoryLockOwner } from '../../effects/locking/exclusive-directory-lock';
import {
  runtimeTransactionLockRelativePath,
  runtimeTransactionRoot,
  type RuntimeTransactionScope,
} from '../../effects/locking/runtime-transaction-lock';

const CANDIDATE_CAPABILITY_NAME = '.candidate-runtime-reconciliation-capability.v1.json';

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface CapabilityFileRecord<TProtocol extends number = number> {
  readonly protocol: TProtocol;
  readonly transaction_id: string;
  readonly parent_token: string;
  readonly parent_pid: number;
  readonly lock_path: string;
  readonly lock_owner_token: string;
  readonly created_at: string;
}

export interface ClaimCapabilityInput<TProtocol extends number> {
  readonly transactionId: string;
  readonly transactionBackupRoot: string;
  readonly parentToken: string;
  readonly expectedProtocol: TProtocol;
}

function fileIdentity(stat: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalDirectory(path: string, label: string): string {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  return realpathSync(resolved);
}

function candidateCapabilityPath(transactionBackupRoot: string): string {
  return join(transactionBackupRoot, CANDIDATE_CAPABILITY_NAME);
}

function parseCapability<TProtocol extends number>(
  raw: string,
  expectedProtocol: TProtocol,
): CapabilityFileRecord<TProtocol> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('candidate reconciliation capability is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('candidate reconciliation capability is not an object');
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.protocol !== expectedProtocol
    || typeof value.transaction_id !== 'string' || !value.transaction_id.startsWith('sha256:')
    || typeof value.parent_token !== 'string' || !/^[a-f0-9]{64}$/i.test(value.parent_token)
    || typeof value.parent_pid !== 'number' || !Number.isSafeInteger(value.parent_pid) || value.parent_pid < 1
    || typeof value.lock_path !== 'string' || !isAbsolute(value.lock_path)
    || typeof value.lock_owner_token !== 'string' || !/^[1-9]\d*-\d+-[0-9a-f-]{36}$/i.test(value.lock_owner_token)
    || typeof value.created_at !== 'string'
  ) {
    throw new Error('candidate reconciliation capability has invalid shape');
  }
  return {
    protocol: expectedProtocol,
    transaction_id: value.transaction_id,
    parent_token: value.parent_token,
    parent_pid: value.parent_pid,
    lock_path: value.lock_path,
    lock_owner_token: value.lock_owner_token,
    created_at: value.created_at,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function writeCandidateCapabilityFile<TProtocol extends number>(
  transactionBackupRoot: string,
  record: CapabilityFileRecord<TProtocol>,
): CapabilityFileRecord<TProtocol> {
  const backupRoot = canonicalDirectory(transactionBackupRoot, 'candidate reconciliation transaction backup');
  parseCapability(JSON.stringify(record), record.protocol);
  const path = candidateCapabilityPath(backupRoot);
  const temporary = join(backupRoot, `.${CANDIDATE_CAPABILITY_NAME}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
    const temporaryIdentity = fileIdentity(fstatSync(fd));
    closeSync(fd);
    fd = null;
    // link(2) is an atomic no-replace publication fence in this directory.
    linkSync(temporary, path);
    const published = lstatSync(path);
    if (!published.isFile() || !sameFileIdentity(fileIdentity(published), temporaryIdentity)) {
      throw new Error('candidate reconciliation capability publication lost ownership');
    }
    unlinkSync(temporary);
    return record;
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // The transaction rollback owns cleanup after a failed publication.
    }
    throw error;
  }
}

export function claimCandidateCapabilityFile<TProtocol extends number>(
  input: ClaimCapabilityInput<TProtocol>,
  scope: RuntimeTransactionScope,
): CapabilityFileRecord<TProtocol> {
  const canonicalHome = canonicalDirectory(realpathSync(scope.root), 'candidate reconciliation home');
  const canonicalScope: RuntimeTransactionScope = { kind: scope.kind, root: canonicalHome };
  const lockRelativePath = runtimeTransactionLockRelativePath(canonicalScope);
  const transactionRoot = canonicalDirectory(runtimeTransactionRoot(canonicalScope), 'candidate reconciliation transaction root');
  const backupRoot = canonicalDirectory(input.transactionBackupRoot, 'candidate reconciliation transaction backup');
  if (!isPathInside(transactionRoot, backupRoot) || backupRoot === transactionRoot) {
    throw new Error(`candidate reconciliation transaction backup is outside the active transaction root: ${backupRoot}`);
  }
  const path = candidateCapabilityPath(backupRoot);
  const observed = lstatSync(path);
  if (!observed.isFile()) throw new Error('candidate reconciliation capability is not a regular file');
  const observedIdentity = fileIdentity(observed);
  const capability = parseCapability(readFileSync(path, 'utf-8'), input.expectedProtocol);
  if (
    capability.transaction_id !== input.transactionId
    || capability.parent_token !== input.parentToken
  ) {
    throw new Error('candidate reconciliation capability binding mismatch');
  }
  if (capability.parent_pid !== process.ppid || !processIsAlive(capability.parent_pid)) {
    throw new Error('candidate reconciliation parent process is not the live transaction owner');
  }
  const expectedLockPath = join(canonicalHome, lockRelativePath);
  if (capability.lock_path !== expectedLockPath) {
    throw new Error('candidate reconciliation capability lock path mismatch');
  }
  const lockOwner = readExclusiveDirectoryLockOwner(canonicalHome, lockRelativePath);
  if (
    lockOwner === null
    || lockOwner.lockPath !== capability.lock_path
    || lockOwner.pid !== capability.parent_pid
    || lockOwner.token !== capability.lock_owner_token
  ) {
    throw new Error('candidate reconciliation parent does not own the active global runtime lock');
  }
  const consumed = join(backupRoot, `.${CANDIDATE_CAPABILITY_NAME}.consumed-${randomUUID()}`);
  renameSync(path, consumed);
  const claimed = lstatSync(consumed);
  if (!claimed.isFile() || !sameFileIdentity(fileIdentity(claimed), observedIdentity)) {
    throw new Error('candidate reconciliation capability changed before consumption');
  }
  return capability;
}
