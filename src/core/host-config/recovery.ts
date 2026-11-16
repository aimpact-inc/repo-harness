import type { ExpectedFile, FileCommitted, FileObservation } from './types';

export type FileState = 'preimage' | 'intended' | 'other';

export type RecoveryAction =
  /** Nothing to write for this file; its preimage copy can go. */
  | 'resolved'
  | 'restore_preimage'
  | 'mark_external_change'
  /** No write; keep the preimage and report host_config_unresolved_external_change. */
  | 'unresolved';

export function matchesExpected(observed: FileObservation, expected: ExpectedFile): boolean {
  if (!expected.existed) return !observed.existed;
  return observed.existed && observed.type === 'file' && observed.mode === expected.mode && observed.sha256 === expected.sha256;
}

export function sameExpected(a: ExpectedFile, b: ExpectedFile): boolean {
  return a.existed ? b.existed && a.mode === b.mode && a.sha256 === b.sha256 : !b.existed;
}

export function expectedFromCommitted(committed: FileCommitted): ExpectedFile {
  return committed.type === 'absent' ? { existed: false } : { existed: true, mode: committed.mode, sha256: committed.sha256 };
}

/**
 * The preimage wins a tie: an intended result equal to the preimage is not a
 * change, and the gate leaves such a file out of the transaction.
 */
export function classifyFile(observed: FileObservation, preimage: ExpectedFile, intended: ExpectedFile | null): FileState {
  if (matchesExpected(observed, preimage)) return 'preimage';
  if (intended && matchesExpected(observed, intended)) return 'intended';
  return 'other';
}

/**
 * One pure decision for rollback after a failure and recovery after a kill.
 * `committed` is whether the ledger lists the transaction ID. A committed
 * transaction never rolls back, so it always settles: a file that differs from
 * the committed result is an external change, and no preimage stays.
 */
export function recoveryAction(state: FileState, committed: boolean): RecoveryAction {
  if (state === 'other') return committed ? 'mark_external_change' : 'unresolved';
  if (state === 'preimage') return committed ? 'mark_external_change' : 'resolved';
  return committed ? 'resolved' : 'restore_preimage';
}
