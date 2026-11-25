import { HcVersionMismatchError } from '../../core/terminal/herdr-pin';
import { hcEvents } from '../terminal/herdr-core';
import { observeHcCore, readHcSnapshot, TASK_SESSION_LABELS } from './herdr-runtime-transport';
import { RUNTIME_SOURCE_PROTOCOL, type StructuredRuntimeTransport } from './runtime-source';

const RECONNECT_MS = 1000;

/**
 * The runtime source on herdr-core. The subscription is one `hc events` stream of the task-session terminals;
 * a snapshot is a fresh `hc events` snapshot, with the snapshot `seq` as the revision of every terminal in it.
 * The core must answer at or above the pin before anything is read, and again after each reconnect.
 */
export function createHerdrCoreRuntimeTransport(source_host: string, env: NodeJS.ProcessEnv) {
  // `advertised` is the core named in capabilities; a reconnect after a core wipe identifies another core.
  let active = false, ready = false, generation = 0, core = '', advertised = '';
  let stream: ReturnType<typeof hcEvents> | null = null, retry: ReturnType<typeof setTimeout> | null = null;
  let invalidate: (event: string, error?: unknown) => void = () => {};
  async function identify(): Promise<string> {
    const observed = await observeHcCore(env);
    if (observed.check.state !== 'aligned') throw new HcVersionMismatchError(observed.check);
    return observed.core_id;
  }
  function closeStream() { generation++; ready = false; stream?.close(); stream = null; }
  function close() { active = false; if (retry) clearTimeout(retry); retry = null; closeStream(); }
  function lost(current: number, error?: unknown) {
    if (!active || current !== generation) return;
    closeStream(); invalidate('disconnected', error);
    const reconnect = async () => {
      retry = null; if (!active) return;
      const attempt = generation;
      try {
        core = await identify(); if (!active || attempt !== generation) return;
        await connect(); if (active && attempt === generation) invalidate('reconnect');
      } catch (failure) {
        if (active && attempt === generation) { invalidate('disconnected', failure); retry = setTimeout(reconnect, RECONNECT_MS); }
      }
    };
    retry = setTimeout(reconnect, RECONNECT_MS);
  }
  /** Resolves on the stream's first snapshot, so the subscription exists before the first read. */
  function connect(): Promise<void> {
    const current = generation;
    return new Promise((resolve, reject) => {
      let started = false;
      const next = hcEvents(TASK_SESSION_LABELS, item => {
        if (!active || current !== generation) return;
        if (!started) { started = true; ready = true; resolve(); return; }
        invalidate(item.type === 'missed' ? 'events_lost' : 'terminal.changed');
      }, { env });
      stream = next;
      next.done.then(() => { if (!started) reject(new Error('hc_events_ended')); else lost(current); },
        error => { if (!started) reject(error); else lost(current, error); });
    });
  }
  const transport: StructuredRuntimeTransport = {
    async capabilities() {
      core = advertised = await identify();
      return { protocol: RUNTIME_SOURCE_PROTOCOL, source_host, hc_core: core, agent_status: true };
    },
    async subscribe(_events, callback, signal) {
      if (active) throw new Error('herdr_runtime_subscribed');
      active = true; invalidate = callback;
      const abort = () => close(); signal.addEventListener('abort', abort, { once: true });
      try { if (signal.aborted) throw new Error('herdr_runtime_aborted'); await connect(); }
      catch (error) { close(); throw error; }
      finally { signal.removeEventListener('abort', abort); }
      return close;
    },
    async snapshot(signal) {
      if (!active || !ready) throw new Error('herdr_runtime_disconnected');
      const current = generation;
      const { seq, terminals } = await readHcSnapshot(TASK_SESSION_LABELS, env, signal);
      if (current !== generation || !active || signal.aborted) throw new Error('herdr_runtime_disconnected');
      return { protocol: 'repo-harness.runtime-source.snapshot.v2', source_host, hc_core: core,
        terminals: terminals.map(terminal => ({ terminal_id: terminal.address, status: terminal.status?.state ?? null, revision: seq })) };
    },
  };
  /** True when the answering core is not the advertised core: every snapshot then fails `runtime_source_identity`. */
  const coreChanged = () => advertised !== '' && core !== advertised;
  return { transport, close, coreChanged };
}
