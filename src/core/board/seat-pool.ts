import { isRecord } from '../evidence/is-record';
import { modelFamily } from '../review/model-family';
import { SEAT_RECOMMENDED_MODELS } from './recommended-models';
import { seatAccount } from './seat-routing';
import { SEAT_IDS, SEAT_RUNTIMES, unavailablePiSeat, type SeatId, type SeatConfigV1, type SeatModelEntryV1, type SeatRuntime, type SeatsConfigV1 } from './seats-settings';

export const SEAT_POOL_STALE_MS = 15 * 60_000;
export const SEAT_POOL_KIND = 'seat_pool' as const;
export const SEAT_POOL_QUOTA_HINT = 'Run rh quota for account and route state.';

export const SEAT_POOL_REASONS = {
  available: 'Listed by the signed-in runtime',
  pi_on_path: 'pi on PATH; provider not checked',
  not_installed: 'Runtime not found on PATH',
  signed_out: 'Runtime signed out',
  not_listed: 'Model missing from the runtime catalog',
  disabled: 'Model disabled by the runtime',
  provider_unavailable: 'Provider marked unavailable in seats.routing.unavailable_pi_providers',
  unknown: 'Runtime or catalog check failed',
  outside_recommendations: 'Configured model is outside this seat’s recommendations',
  no_model: 'No explicit model is configured',
} as const;

type SeatPoolReason = keyof typeof SEAT_POOL_REASONS;
type ModelStatus = Exclude<SeatPoolReason, 'outside_recommendations' | 'no_model'>;
const available = (status: SeatPoolReason): boolean => status === 'available' || status === 'pi_on_path';

const installHints = { claude: 'Install Claude Code and add claude to PATH.', codex: 'Install Codex and add codex to PATH.', pi: 'Install Pi and add pi to PATH.', agy: 'Install a stable agy release of 1.5.0 or later.' };
const loginHints = { claude: 'Run claude auth login.', codex: 'Run codex login.', pi: '', agy: 'Sign in through agy.' };

function entryHint(runtime: SeatRuntime, status: ModelStatus): string | null {
  switch (status) {
    case 'not_installed': return installHints[runtime];
    case 'signed_out': return loginHints[runtime];
    case 'unknown': return 'Run rh seats pool again.';
    case 'not_listed':
    case 'disabled': return 'Choose another recommended model.';
    default: return null;
  }
}

const INSTALLATIONS = ['available', 'not_installed', 'unknown'] as const;
const SIGN_IN_STATES = ['logged_in', 'logged_out', 'unknown', 'not_checked'] as const;
const CATALOG_STATES = ['ok', 'unauthenticated', 'unknown', 'not_checked'] as const;

export interface SeatPoolRuntimeV1 {
  readonly id: SeatRuntime;
  readonly installation: typeof INSTALLATIONS[number];
  readonly sign_in: typeof SIGN_IN_STATES[number];
  readonly models: typeof CATALOG_STATES[number];
}

/** Child projection. Catalog detail is limited to recommended ids and the disabled bit. */
export interface SeatPoolProbe extends SeatPoolRuntimeV1 {
  readonly listed: readonly { readonly id: string; readonly disabled: boolean }[];
}

interface PoolEntry extends SeatModelEntryV1 {
  readonly status: ModelStatus;
  readonly reason: string;
  readonly hint: string | null;
  readonly account: ReturnType<typeof seatAccount>;
  readonly family: ReturnType<typeof modelFamily>;
}

interface ConfiguredModel {
  readonly field: string;
  readonly table_entry: boolean;
  readonly in_pool: boolean;
  readonly reason: SeatPoolReason;
}

interface SeatPoolRow {
  readonly seat: SeatId;
  readonly configured: ConfiguredModel;
  readonly pool: readonly PoolEntry[];
  readonly excluded: readonly PoolEntry[];
}

export interface SeatPoolV1 {
  readonly protocol: 1;
  readonly kind: typeof SEAT_POOL_KIND;
  readonly collected_at: string;
  readonly runtimes: readonly SeatPoolRuntimeV1[];
  readonly seats: readonly SeatPoolRow[];
  readonly quota_hint: typeof SEAT_POOL_QUOTA_HINT;
}

export type SeatPoolCacheV1 = { readonly status: 'ready' | 'stale'; readonly report: SeatPoolV1 };

function publicRuntime(probe: SeatPoolRuntimeV1): SeatPoolRuntimeV1 {
  return { id: probe.id, installation: probe.installation, sign_in: probe.sign_in, models: probe.models };
}

export function emptySeatPoolProbe(id: SeatRuntime, installation: SeatPoolRuntimeV1['installation']): SeatPoolProbe {
  return { id, installation, sign_in: 'not_checked', models: 'not_checked', listed: [] };
}

export function recommendedModelIds(runtime: SeatRuntime): ReadonlySet<string> {
  return new Set(Object.values(SEAT_RECOMMENDED_MODELS).flatMap(entries => entries.filter(entry => entry.runtime === runtime).map(entry => entry.model)));
}

export const MAGPIE_EXTENSION_PATH = 'extensions/magpie.ts';
const MAGPIE_MISSING = `Magpie extension missing. Checked ${MAGPIE_EXTENSION_PATH} under PI_CODING_AGENT_DIR when set, otherwise under the default Pi agent directory. Set seats.routing.unavailable_pi_providers to mark this provider unavailable.`;

function runtimeStatus(probe: SeatPoolProbe): ModelStatus {
  if (probe.installation !== 'available') return probe.installation;
  if (probe.id === 'pi') return 'pi_on_path';
  if (probe.sign_in === 'logged_out' || probe.models === 'unauthenticated') return 'signed_out';
  return probe.sign_in === 'logged_in' ? 'available' : 'unknown';
}

function modelStatus(entry: Pick<SeatConfigV1, 'runtime' | 'model'>, probe: SeatPoolProbe, routing: SeatsConfigV1['routing'], checkCatalog: boolean): ModelStatus {
  const status = runtimeStatus(probe);
  if (status === 'pi_on_path') return unavailablePiSeat(entry, routing) === null ? status : 'provider_unavailable';
  if (status !== 'available') return status;
  if (!checkCatalog) return status;
  if (probe.models !== 'ok') return 'unknown';
  const model = probe.listed.find(item => item.id === entry.model);
  if (model === undefined) return 'not_listed';
  return model.disabled ? 'disabled' : 'available';
}

function runtimeProbe(probes: readonly SeatPoolProbe[], id: SeatRuntime): SeatPoolProbe {
  return probes.find(probe => probe.id === id) ?? emptySeatPoolProbe(id, 'unknown');
}

function availabilityBlock(id: SeatId, runtime: SeatRuntime, status: ModelStatus): string | null {
  if (available(status)) return null;
  const hint = entryHint(runtime, status);
  return `${runtime}: ${SEAT_POOL_REASONS[status]}. See seats.${id}.model.${hint === null ? '' : ` ${hint}`}`;
}

export function seatRuntimeBlock(id: SeatId, runtime: SeatRuntime, probes: readonly SeatPoolProbe[]): string | null {
  return availabilityBlock(id, runtime, runtimeStatus(runtimeProbe(probes, runtime)));
}

/** Launch and dispatch share the live status. Free ids get the runtime check and stay out of the result. */
export function seatModelBlock(id: SeatId, seat: SeatConfigV1, seats: SeatsConfigV1, probes: readonly SeatPoolProbe[], magpieInstalled: () => boolean): string | null {
  const probe = runtimeProbe(probes, seat.runtime);
  const recommended = SEAT_RECOMMENDED_MODELS[id].some(entry => entry.model === seat.model && entry.runtime === seat.runtime);
  const status = modelStatus(seat, probe, seats.routing, recommended);
  if (status === 'pi_on_path' && seat.model?.startsWith('magpie/') && !magpieInstalled()) return `${MAGPIE_MISSING} See seats.${id}.model.`;
  return availabilityBlock(id, seat.runtime, status);
}

function recommendedEntries(id: SeatId, routing: SeatsConfigV1['routing'], probes: readonly SeatPoolProbe[]): PoolEntry[] {
  return SEAT_RECOMMENDED_MODELS[id].map(entry => poolEntry(entry, modelStatus(entry, runtimeProbe(probes, entry.runtime), routing, true)));
}

export function seatPoolHint(id: SeatId, seats: SeatsConfigV1, probes: readonly SeatPoolProbe[]): string {
  const pool = recommendedEntries(id, seats.routing, probes).filter(entry => available(entry.status));
  return `Available pool for ${id}: ${pool.map(entry => `${entry.runtime} ${entry.model}`).join(', ') || 'empty'}.`;
}

function poolEntry(entry: SeatModelEntryV1, status: ModelStatus): PoolEntry {
  return { ...entry, status, reason: SEAT_POOL_REASONS[status], hint: entryHint(entry.runtime, status), account: seatAccount(entry), family: modelFamily(entry.model) };
}

function poolRow(seat: SeatId, reason: SeatPoolReason, entries: readonly PoolEntry[]): SeatPoolRow {
  const tableEntry = reason !== 'outside_recommendations' && reason !== 'no_model';
  return {
    seat,
    configured: { field: `seats.${seat}.model`, table_entry: tableEntry, in_pool: available(reason), reason },
    pool: entries.filter(entry => available(entry.status)),
    excluded: entries.filter(entry => !available(entry.status)),
  };
}

function report(collected_at: string, runtimes: readonly SeatPoolRuntimeV1[], seats: readonly SeatPoolRow[]): SeatPoolV1 {
  return { protocol: 1, kind: SEAT_POOL_KIND, collected_at, runtimes, seats, quota_hint: SEAT_POOL_QUOTA_HINT };
}

export function buildSeatPool(seats: SeatsConfigV1, probes: readonly SeatPoolProbe[], collectedAt: string): SeatPoolV1 {
  return report(collectedAt, SEAT_RUNTIMES.map(id => publicRuntime(runtimeProbe(probes, id))), SEAT_IDS.map(id => {
    const seat = seats[id];
    const entries = recommendedEntries(id, seats.routing, probes);
    const match = entries.find(entry => entry.runtime === seat?.runtime && entry.model === seat.model);
    return poolRow(id, match?.status ?? (seat?.model == null ? 'no_model' : 'outside_recommendations'), entries);
  }));
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.includes(value as T);
}

function decodeRuntime(id: SeatRuntime, value: unknown): SeatPoolRuntimeV1 {
  if (!isRecord(value) || value.id !== id || !oneOf(INSTALLATIONS, value.installation)
    || !oneOf(SIGN_IN_STATES, value.sign_in) || !oneOf(CATALOG_STATES, value.models)
    || id === 'pi' && (value.sign_in !== 'not_checked' || value.models !== 'not_checked')) throw new Error('seat_pool_invalid');
  return { id, installation: value.installation, sign_in: value.sign_in, models: value.models };
}

export function decodeSeatPoolProbe(id: SeatRuntime, value: unknown): SeatPoolProbe {
  const runtime = decodeRuntime(id, value);
  if (!isRecord(value) || !Array.isArray(value.listed)) throw new Error('seat_pool_invalid');
  const ids = recommendedModelIds(id);
  const listed = value.listed.map((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !ids.has(item.id) || typeof item.disabled !== 'boolean') throw new Error('seat_pool_invalid');
    return { id: item.id, disabled: item.disabled };
  });
  return { ...runtime, listed };
}

const MODEL_STATUSES = ['available', 'pi_on_path', 'not_installed', 'signed_out', 'not_listed', 'disabled', 'provider_unavailable', 'unknown'] as const satisfies readonly ModelStatus[];

function decodePoolRow(seat: SeatId, value: unknown): SeatPoolRow {
  if (!isRecord(value) || value.seat !== seat || !isRecord(value.configured)
    || !Array.isArray(value.pool) || !Array.isArray(value.excluded)) throw new Error('seat_pool_invalid');
  const candidates: unknown[] = [...value.pool, ...value.excluded];
  const table = SEAT_RECOMMENDED_MODELS[seat];
  if (candidates.length !== table.length) throw new Error('seat_pool_invalid');
  const entries = table.map(entry => {
    const row = candidates.find(item => isRecord(item) && item.runtime === entry.runtime && item.model === entry.model);
    if (!isRecord(row) || !oneOf(MODEL_STATUSES, row.status)) throw new Error('seat_pool_invalid');
    if (entry.runtime === 'pi' ? !oneOf(['pi_on_path', 'provider_unavailable', 'not_installed', 'unknown'], row.status)
      : row.status === 'pi_on_path' || row.status === 'provider_unavailable') throw new Error('seat_pool_invalid');
    return poolEntry(entry, row.status);
  });
  const reason = value.configured.reason;
  if (reason !== 'no_model' && reason !== 'outside_recommendations' && !entries.some(entry => entry.status === reason)) throw new Error('seat_pool_invalid');
  return poolRow(seat, reason as SeatPoolReason, entries);
}

/** Rebuild output from the shipped table and closed statuses. Saved strings are never forwarded. */
export function decodeSeatPool(value: unknown): SeatPoolV1 {
  if (!isRecord(value) || value.protocol !== 1 || value.kind !== SEAT_POOL_KIND || typeof value.collected_at !== 'string'
    || !Array.isArray(value.runtimes) || value.runtimes.length !== SEAT_RUNTIMES.length
    || !Array.isArray(value.seats) || value.seats.length !== SEAT_IDS.length) throw new Error('seat_pool_invalid');
  const stamp = new Date(value.collected_at);
  if (Number.isNaN(stamp.getTime()) || stamp.toISOString() !== value.collected_at) throw new Error('seat_pool_invalid');
  const { runtimes, seats } = value;
  return report(value.collected_at, SEAT_RUNTIMES.map((id, index) => decodeRuntime(id, runtimes[index])), SEAT_IDS.map((id, index) => decodePoolRow(id, seats[index])));
}

export function formatSeatPool(value: SeatPoolV1): string {
  const model = (entry: PoolEntry) => `${entry.runtime} ${entry.model} (${entry.reason}${entry.account === null ? '' : `, ${entry.account}`}${entry.hint === null ? '' : `. ${entry.hint}`})`;
  return [
    `Collected at ${value.collected_at}`,
    ...value.seats.map(row => `pool ${row.seat}: ${row.pool.map(model).join(', ') || 'empty'}; ${row.configured.field} (${SEAT_POOL_REASONS[row.configured.reason]})${row.excluded.length === 0 ? '' : `; excluded: ${row.excluded.map(model).join(', ')}`}`),
    value.quota_hint,
  ].join('\n');
}
