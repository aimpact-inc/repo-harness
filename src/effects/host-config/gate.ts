import { randomUUID } from 'node:crypto';
import { sha256Prefixed } from '../../core/evidence/sha256';
import { planFile, type FilePlan, type PlannedFragment } from '../../core/host-config/plan';
import { classifyFile, expectedFromCommitted, recoveryAction, sameExpected } from '../../core/host-config/recovery';
import {
  HostConfigError,
  type ExpectedFile,
  type FileRecord,
  type FragmentRecord,
  type FragmentRequest,
  type HostConfigLedger,
  type HostPath,
  type SkippedOverride,
  type TransactionFileEntry,
  type TransactionRecord,
} from '../../core/host-config/types';
import { globalRuntimeScope, withRuntimeTransactionContext, type RuntimeTransactionContext } from '../locking/runtime-transaction-lock';
import { isPathInside } from '../path-containment';
import {
  createDirectories,
  ensurePrivateDirectory,
  expectedOf,
  hostConfigPaths,
  listTransactionRecords,
  missingDirectories,
  observeFile,
  platformMode,
  preimageCopyName,
  putVault,
  readLedger,
  readPreimageCopy,
  resolveHostPath,
  removeCreatedDirectories,
  removePreimageCopy,
  removeTarget,
  removeTemporary,
  removeTransaction,
  replaceTarget,
  transactionDirectory,
  writeLedger,
  writePreimageCopy,
  writeTransactionRecord,
  type HostConfigPaths,
} from './store';

export type HostConfigFaultPoint = 'after-record' | 'before-rename' | 'after-rename' | 'after-ledger' | 'after-cleanup';

/**
 * Test seam: a hook at each fault point. `path` names the file for
 * `before-rename` (its directories and temporary file exist) and `after-rename`.
 */
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
  /**
   * Only for out-of-process writers: `run` gets the resolved destinations of
   * the declared paths, may write them, and the gate records them.
   */
  delegate(declaredPaths: readonly string[], run: (destinations: readonly HostPath[]) => void): HostConfigDelegateResult;
  recover(): HostConfigRecoveryReport;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function newTransactionId(): string {
  return `txn-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
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
 * A file at its preimage in an uncommitted transaction also loses the
 * directories that the transaction created, when they are still empty.
 * Returns the files that stay unresolved; the record keeps only those, and a
 * created directory that an unresolved file still holds moves to that entry.
 */
function settleTransaction(paths: HostConfigPaths, record: TransactionRecord, attempted: ReadonlySet<string> | null): UnresolvedHostConfigChange[] {
  const ledger = readLedger(paths);
  const committed = ledger.committed_transactions.includes(record.txn);
  const files = { ...ledger.files };
  let ledgerChanged = false;
  const remaining: TransactionFileEntry[] = [];
  const keptDirs: HostPath[] = [];
  // Reverse order: a file that a later entry put in a new directory goes before that directory is removed.
  for (const entry of [...record.files].reverse()) {
    if (entry.intended === 'unchanged') continue;
    removeTemporary(entry.path, record.txn);
    const touched = attempted === null || attempted.has(entry.path);
    const action = touched ? recoveryAction(classifyFile(observeFile(entry.path).observation, entry.preimage, entry.intended), committed) : 'resolved';
    if (action === 'unresolved') { remaining.push(entry); continue; }
    if (action === 'mark_external_change') {
      const recorded = files[entry.path];
      if (!recorded) throw new HostConfigError('host_config_invalid_state', `a committed transaction has no file record: ${entry.path}`);
      files[entry.path] = { ...recorded, external_change: true };
      ledgerChanged = true;
      continue;
    }
    if (action === 'restore_preimage' && entry.intended) {
      try {
        if (entry.preimage.existed && entry.preimage_copy) {
          const bytes = readPreimageCopy(paths, record.txn, entry.preimage_copy, entry.preimage.sha256);
          replaceTarget(entry.path, record.txn, bytes, entry.preimage.mode, entry.intended, () => {});
        } else {
          removeTarget(entry.path, entry.intended);
        }
      } catch (error) {
        // A changed target, or a preimage copy that cannot be read, keeps this entry; other entries and records go on.
        if (!(error instanceof HostConfigError && (error.code === 'host_config_target_changed' || error.code === 'host_config_invalid_state'))) throw error;
        remaining.push(entry);
        continue;
      }
    }
    if (!committed) keptDirs.push(...removeCreatedDirectories(entry.created_dirs));
  }
  if (ledgerChanged) writeLedger(paths, withLedger(ledger, files, ledger.fragments));
  if (remaining.length === 0) {
    removeTransaction(paths, record.txn);
    return [];
  }
  for (const entry of record.files) {
    if (entry.preimage_copy && !remaining.includes(entry)) removePreimageCopy(paths, record.txn, entry.preimage_copy);
  }
  // A kept directory above no unresolved file holds other content, so it is no longer the transaction's to remove.
  const unresolved = record.files.filter((entry) => remaining.includes(entry)).map((entry) => {
    const carried = keptDirs.filter((directory) => isPathInside(directory, entry.path) && !entry.created_dirs.includes(directory));
    return carried.length === 0 ? entry : { ...entry, created_dirs: [...entry.created_dirs, ...carried].sort((a, b) => a.length - b.length) };
  });
  writeTransactionRecord(paths, { ...record, stage: 'unresolved', files: unresolved });
  return unresolved.map((entry) => ({ code: 'host_config_unresolved_external_change', txn: record.txn, path: entry.path }));
}

function recoverAll(paths: HostConfigPaths): UnresolvedHostConfigChange[] {
  return listTransactionRecords(paths).flatMap((record) => settleTransaction(paths, record, null));
}

function prepareStorage(paths: HostConfigPaths): void {
  for (const directory of [paths.harness, paths.root, paths.vault, paths.journal]) ensurePrivateDirectory(directory);
}

/** Resolve the targets once and refuse a path that an unresolved record still holds. Two aliases of one file are one path. */
function admitPaths(paths: HostConfigPaths, targets: readonly string[], unresolved: readonly UnresolvedHostConfigChange[]): HostPath[] {
  const admitted = targets.map((path) => resolveHostPath(paths, path));
  const distinct = new Set<string>(admitted);
  if (distinct.size !== admitted.length) throw new HostConfigError('host_config_invalid_state', 'a transaction names one path twice');
  const held = unresolved.filter((entry) => distinct.has(entry.path));
  if (held.length) throw unresolvedError(held);
  return admitted;
}

/** Write the preimage copies, then fsync the record; no target write happens before this returns. */
function recordTransaction(paths: HostConfigPaths, record: TransactionRecord, preimages: ReadonlyMap<string, Buffer>): void {
  ensurePrivateDirectory(transactionDirectory(paths, record.txn));
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

/** True when the ledger does not already hold this fragment with this edit. */
function fragmentChanges(fragment: PlannedFragment): boolean {
  const { previous, edit } = fragment;
  return !previous || previous.edit.at !== edit.at || previous.edit.inserted !== edit.inserted;
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
  const targets = admitPaths(paths, changes.map((change) => change.path), recoverAll(paths));
  const ledger = readLedger(paths);
  const txn = newTransactionId();
  const skipped: SkippedOverride[] = [];
  const claimedDirs = new Set<string>();
  const plans: FilePlan[] = [];
  const files = { ...ledger.files };
  let externalChange = false;
  const work: { change: HostConfigFileChange; plan: FilePlan; entry: TransactionFileEntry; preimage: Buffer | null; mode: number; sha256: string }[] = [];
  for (const [index, change] of changes.entries()) {
    const path = targets[index]!;
    const { observation, bytes } = observeFile(path);
    const preimage = expectedOf(observation, path);
    let content: string;
    try { content = bytes === null ? '' : UTF8.decode(bytes); }
    catch { throw new HostConfigError('host_config_invalid_state', `not UTF-8 text: ${path}`); }
    const plan = planFile(path, content, change.fragments, ledger.fragments);
    skipped.push(...plan.skipped);
    plans.push(plan);
    // A fragment whose text is already in place is still recorded, but its file is not written.
    if (plan.result === content) {
      // No write, but an outside edit since the commit is still recorded, as a written file would record it.
      const recorded = ledger.files[path];
      if (recorded && !recorded.external_change && !sameExpected(preimage, expectedFromCommitted(recorded.committed))) {
        files[path] = { ...recorded, external_change: true };
        externalChange = true;
      }
      continue;
    }
    const createdDirs = missingDirectories(paths, path).filter((directory) => !claimedDirs.has(directory));
    for (const directory of createdDirs) claimedDirs.add(directory);
    const result = Buffer.from(plan.result, 'utf8');
    const mode = preimage.existed ? preimage.mode : platformMode(change.createMode ?? 0o600);
    const sha256 = sha256Prefixed(result);
    work.push({
      change,
      plan,
      preimage: bytes,
      mode,
      sha256,
      entry: {
        path,
        preimage,
        preimage_copy: preimage.existed ? preimageCopyName(index) : null,
        intended: { existed: true, mode, sha256 },
        created_dirs: createdDirs,
      },
    });
  }
  if (work.length === 0) {
    if (!externalChange && !plans.some((plan) => plan.fragments.some(fragmentChanges))) return { txn: null, written: [], skipped };
    // Only ledger records change: the ledger write is the whole transaction, and settlement has nothing to touch.
    writeLedger(paths, withLedger(ledger, files, nextFragments(paths, ledger, plans), txn));
    return { txn, written: [], skipped };
  }

  const record: TransactionRecord = { protocol: 1, txn, intended: 'write', stage: 'recorded', files: work.map((item) => item.entry) };
  recordTransaction(paths, record, new Map(work.flatMap((item) => (item.preimage ? [[item.entry.path, item.preimage] as const] : []))));
  faults?.at('after-record');

  const attempted = new Set<string>();
  try {
    for (const { entry, plan, mode } of work) {
      createDirectories(entry.created_dirs);
      replaceTarget(entry.path, txn, Buffer.from(plan.result, 'utf8'), mode, entry.preimage, () => {
        faults?.at('before-rename', entry.path);
        attempted.add(entry.path);
      });
      faults?.at('after-rename', entry.path);
    }
    for (const { change, entry, mode, sha256 } of work) {
      files[entry.path] = nextFileRecord(ledger.files[entry.path], entry.preimage,
        { type: 'file', sha256, mode, txn }, entry.created_dirs, change.baselineUnknown === true);
    }
    writeLedger(paths, withLedger(ledger, files, nextFragments(paths, ledger, plans), txn));
  } catch (error) {
    settleAfterFailure(paths, record, attempted, error);
  }
  faults?.at('after-ledger');
  removeTransaction(paths, txn);
  faults?.at('after-cleanup');
  return { txn, written: work.map((item) => item.entry.path), skipped };
}

function delegateWrite(paths: HostConfigPaths, declaredPaths: readonly string[], run: (destinations: readonly HostPath[]) => void, faults: HostConfigFaults | undefined): HostConfigDelegateResult {
  prepareStorage(paths);
  const targets = admitPaths(paths, declaredPaths, recoverAll(paths));
  const txn = newTransactionId();
  const preimages = new Map<string, Buffer>();
  const entries = targets.map((path, index): TransactionFileEntry => {
    const { observation, bytes } = observeFile(path);
    const preimage = expectedOf(observation, path);
    if (bytes !== null) preimages.set(path, bytes);
    return { path, preimage, preimage_copy: preimage.existed ? preimageCopyName(index) : null, intended: null, created_dirs: [] };
  });
  let record: TransactionRecord = { protocol: 1, txn, intended: 'delegated', stage: 'recorded', files: entries };
  recordTransaction(paths, record, preimages);
  faults?.at('after-record');

  const changed: HostPath[] = [];
  try {
    run(targets);
    // The journal holds every declared path with its observed outcome before the commit, so settlement never guesses.
    const observed = entries.map((entry): TransactionFileEntry => {
      const result = expectedOf(observeFile(entry.path).observation, entry.path);
      return { ...entry, intended: sameExpected(result, entry.preimage) ? 'unchanged' : result };
    });
    const outcome: TransactionRecord = { ...record, stage: 'observed', files: observed };
    writeTransactionRecord(paths, outcome);
    record = outcome;
    const ledger = readLedger(paths);
    const files = { ...ledger.files };
    for (const entry of observed) {
      if (entry.intended === null) continue;
      if (entry.intended === 'unchanged') {
        // The path keeps its committed result, but an outside edit before the delegate is still recorded.
        const recorded = ledger.files[entry.path];
        if (recorded && !sameExpected(entry.preimage, expectedFromCommitted(recorded.committed))) files[entry.path] = { ...recorded, external_change: true };
        continue;
      }
      changed.push(entry.path);
      files[entry.path] = nextFileRecord(ledger.files[entry.path], entry.preimage,
        entry.intended.existed ? { type: 'file', sha256: entry.intended.sha256, mode: entry.intended.mode, txn } : { type: 'absent', txn }, [], false);
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
