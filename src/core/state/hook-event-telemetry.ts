import { isRecord } from '../evidence/is-record';
import { parseJsonText } from '../evidence/file-syntax';
import { sha256Hex } from '../evidence/sha256';

export const HOOK_EVENT_TELEMETRY_PROTOCOL = 'loop-engine-hook-event/v2' as const;
export const HOOK_EVENT_TELEMETRY_PATH = '.ai/harness/runs/hook-events.jsonl';
export const HOOK_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const HOOK_EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface HookEventFingerprintInput {
  readonly event: string;
  readonly route_id: string;
  readonly exit_code: number;
  readonly blocked: boolean;
  readonly reason: string;
}

export function hookEventFingerprint({ event, route_id, exit_code, blocked, reason }: HookEventFingerprintInput): string {
  return `sha256:${sha256Hex(JSON.stringify({ event, route_id, exit_code, blocked, reason }))}`;
}

/** Verify a complete writer record before disposable telemetry can be removed. */
export function isHookEventTelemetryLine(line: string): boolean {
  const value = parseJsonText(line, null);
  if (!isRecord(value) || Object.keys(value).sort().join(',') !==
    'blocked,command_names,completed_at,elapsed_ms,event,event_id,exit_code,fingerprint,host,protocol,reason,route_id,run_id,session_id,started_at,turn_id') return false;
  const { event, route_id, exit_code, blocked, reason } = value;
  return value.protocol === HOOK_EVENT_TELEMETRY_PROTOCOL
    && typeof value.event_id === 'string' && HOOK_EVENT_ID.test(value.event_id)
    && [value.started_at, value.completed_at].every(stamp => typeof stamp === 'string' && Number.isFinite(Date.parse(stamp)))
    && [value.session_id, value.run_id, value.turn_id].every(id => id === null || typeof id === 'string')
    && typeof value.host === 'string' && value.host.length > 0
    && typeof event === 'string' && event.length > 0 && typeof route_id === 'string' && route_id.length > 0
    && typeof exit_code === 'number' && Number.isSafeInteger(exit_code) && typeof blocked === 'boolean' && typeof reason === 'string'
    && typeof value.elapsed_ms === 'number' && Number.isFinite(value.elapsed_ms) && value.elapsed_ms >= 0
    && Array.isArray(value.command_names) && value.command_names.every(name => typeof name === 'string' && HOOK_COMMAND_NAME.test(name))
    && value.fingerprint === hookEventFingerprint({ event, route_id, exit_code, blocked, reason });
}
