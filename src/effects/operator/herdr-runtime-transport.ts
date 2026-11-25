// Shared operator reads from the herdr-core selected by HC_SESSION or HC_SOCKET.
import { HC_MIN_VERSION, hcVersionCheck, type HcVersionCheck } from '../../core/terminal/herdr-pin';
import { RH_LABEL, RH_ROLE, hcEvents, hcServerStatusAsync, type HcLabels, type HcTerminal } from '../terminal/herdr-core';

/** The operator observes task-session terminals only; it never lists unlabeled terminals. */
export const TASK_SESSION_LABELS: HcLabels = { [RH_LABEL.role]: RH_ROLE.taskSession };

export interface HcCoreObservation { readonly core_id: string; readonly check: HcVersionCheck }

/** The answering core and its version against the package floor. Throws a `HerdrCoreError`. */
export async function observeHcCore(env: NodeJS.ProcessEnv, timeoutMs?: number): Promise<HcCoreObservation> {
  const status = await hcServerStatusAsync({ env, timeoutMs });
  return { core_id: status.core.id, check: hcVersionCheck(status.version, HC_MIN_VERSION) };
}

export interface HcSnapshot { readonly seq: number; readonly terminals: readonly HcTerminal[] }

/** One snapshot: `hc events` sends the matching terminals first, then the stream is closed. */
export function readHcSnapshot(labels: HcLabels, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<HcSnapshot> {
  return new Promise((resolve, reject) => {
    let snapshot: HcSnapshot | null = null;
    const stream = hcEvents(labels, item => {
      if (snapshot === null && item.type !== 'event') { snapshot = { seq: item.seq, terminals: item.terminals }; stream.close(); }
    }, { env });
    const abort = () => stream.close();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    stream.done.then(() => (snapshot ? resolve(snapshot) : reject(new Error(signal?.aborted ? 'hc_snapshot_aborted' : 'hc_snapshot_missing'))), reject)
      .finally(() => signal?.removeEventListener('abort', abort));
  });
}
