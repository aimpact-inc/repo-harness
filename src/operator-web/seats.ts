import { useCallback, useRef, useState } from 'react';
import {
  decodeSeatOverrideResult,
  decodeSeatOverridesResponse,
  normalizeOverrideInstruction,
  type SeatOverrideResultV1,
  type SeatOverrideRevokeRequestV1,
  type SeatOverrideSetRequestV1,
  type SeatOverridesResponseV1,
  type SeatOverridesV1,
} from '../core/board/seat-overrides';
import {
  AGY_READONLY_SEAT_TOOLS,
  COUNCIL_TOOLS,
  DEFAULT_SEATS_CONFIG,
  ROUTING_CLASSES,
  ROUTING_KEYS,
  SEAT_IDS,
  SEAT_SCAFFOLD_SUB_AGENTS,
  agyEffortValid,
  agySeatTools,
  decodeSeatsSettings,
  decodeSeatsSettingsResult,
  isAgyToolsValid,
  isWorkerSeat,
  seatTakesFleet,
  type SeatConfigV1,
  type RoutingClass,
  type OptionalSeatId,
  type SeatId,
  type SeatModelV1,
  type SeatRoutingV1,
  type SeatRuntime,
  type SeatScaffoldSubAgent,
  type SeatsConfigV1,
  type SeatsSettingsRequestV1,
  type SeatsSettingsV1,
  type SeatTool,
  type WorkerSeatId,
} from '../core/board/seats-settings';
import { agySeatStarter } from '../core/board/recommended-models';
import { decodeSeatPool } from '../core/board/seat-pool';
import { isRecord } from '../core/evidence/is-record';
import { postOperatorWrite, type OperatorWriteAnswer } from './operator-write';
import {
  fetchSettings,
  postSettings,
  useSettingsForm,
  type SettingsForm,
  type SettingsReader,
  type SettingsReason,
  type SettingsSection,
  type SettingsWriter,
} from './settings';
import { answered, useObservationRefresh } from './useObservationRefresh';

/** Browser side of `GET` and `POST /api/v1/settings/seats`. Save sends the whole section. */
const SEATS_SETTINGS_PATH = '/api/v1/settings/seats';
const SEAT_OVERRIDES_PATH = '/api/v1/settings/seats/overrides';
const SEAT_OVERRIDES_REVOKE_PATH = '/api/v1/settings/seats/overrides/revoke';

export type SeatsSettingsReader = SettingsReader<SeatsSettingsV1>;
export type SeatsSettingsWriter = SettingsWriter<SeatsSettingsRequestV1>;
export type SeatsSettingsForm = SettingsForm<SeatsSettingsV1, SeatsSettingsV1['config'], SeatsConfigV1, SeatsSettingsRequestV1>;

export type SeatOverridesReader = SettingsReader<SeatOverridesResponseV1>;
export type SeatOverrideSetPost = SeatOverrideSetRequestV1 & { readonly request_id: string };
export type SeatOverrideRevokePost = SeatOverrideRevokeRequestV1 & { readonly request_id: string };
export type SeatOverrideWrite = OperatorWriteAnswer<SeatOverrideResultV1>;
export type SeatOverrideSetter = (body: SeatOverrideSetPost) => Promise<SeatOverrideWrite>;
export type SeatOverrideRevoker = (body: SeatOverrideRevokePost) => Promise<SeatOverrideWrite>;

export type SeatOverridesView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable'; readonly reason: SettingsReason }
  | { readonly kind: 'ready'; readonly response: SeatOverridesResponseV1; readonly refreshFailed: boolean };

export interface SeatOverridesController {
  readonly view: SeatOverridesView;
  readonly saves: number;
  readonly needsReload: boolean;
  readonly authorize: (request: SeatOverrideSetRequestV1) => Promise<SeatOverrideWrite>;
  readonly revoke: (request: SeatOverrideRevokeRequestV1) => Promise<SeatOverrideWrite>;
  readonly reload: () => void;
}

function decodeSeatsSettingsWithPool(value: unknown): SeatsSettingsV1 {
  if (!isRecord(value)) throw new Error('seats_settings_invalid');
  const { model_pool, ...settings } = value;
  const decoded = decodeSeatsSettings(settings);
  if (model_pool === undefined) return decoded;
  if (!isRecord(model_pool) || (model_pool.status !== 'ready' && model_pool.status !== 'stale')) throw new Error('seats_settings_invalid');
  return { ...decoded, model_pool: { status: model_pool.status, report: decodeSeatPool(model_pool.report) } };
}

export const fetchSeatsSettings: SeatsSettingsReader = signal => fetchSettings(SEATS_SETTINGS_PATH, decodeSeatsSettingsWithPool, signal);
export const postSeatsSettings: SeatsSettingsWriter = body => postSettings(SEATS_SETTINGS_PATH, decodeSeatsSettingsResult, body);
export const fetchSeatOverrides: SeatOverridesReader = signal => fetchSettings(SEAT_OVERRIDES_PATH, decodeSeatOverridesResponse, signal);
export const postSeatOverride: SeatOverrideSetter = body => postOperatorWrite(SEAT_OVERRIDES_PATH, body, decodeSeatOverrideResult);
export const postSeatOverrideRevoke: SeatOverrideRevoker = body => postOperatorWrite(SEAT_OVERRIDES_REVOKE_PATH, body, decodeSeatOverrideResult);

const OVERRIDE_RETRY_SAME_REQUEST: ReadonlySet<string> = new Set(['busy', 'audit_unavailable']);

function withoutOverride(overrides: SeatOverridesV1, seat: SeatId): SeatOverridesV1 {
  const next: Partial<Record<SeatId, NonNullable<SeatOverridesV1[SeatId]>>> = {};
  for (const id of SEAT_IDS) {
    if (id !== seat && overrides[id] !== undefined) next[id] = overrides[id];
  }
  return next;
}

interface SeatOverridesState {
  readonly view: SeatOverridesView;
  readonly saves: number;
  readonly needsReload: boolean;
}

function nextOverridesAfterWrite(
  current: SeatOverridesState,
  revision: string,
  update: (previous: SeatOverridesV1) => SeatOverridesV1,
): SeatOverridesState {
  const previous = current.view.kind === 'ready' ? current.view.response.overrides : {};
  const response: SeatOverridesResponseV1 = {
    protocol: 1,
    kind: 'operator_seat_overrides',
    config_revision: revision,
    overrides: update(previous),
  };
  return { ...current, view: { kind: 'ready', response, refreshFailed: false }, saves: current.saves + 1 };
}

export function useSeatOverrides(
  read: SeatOverridesReader,
  writeSet: SeatOverrideSetter,
  writeRevoke: SeatOverrideRevoker,
  generation: number,
  sharedSaves: number,
  enabled: boolean,
): SeatOverridesController {
  const [state, setState] = useState<SeatOverridesState>({
    view: { kind: 'loading' }, saves: 0, needsReload: false,
  });
  const pending = useRef<{ readonly key: string; readonly id: string } | null>(null);
  const readsStarted = useRef(0);
  const staleReadsThrough = useRef(0);

  const observe = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    const started = ++readsStarted.current;
    const result = await read(signal);
    if (signal.aborted) return false;
    if (started <= staleReadsThrough.current) return true;
    if (result.state !== 'ok') {
      setState((current: SeatOverridesState) => ({
        ...current,
        view: current.view.kind === 'ready' ? { ...current.view, refreshFailed: true } : { kind: 'unavailable', reason: result.reason },
      }));
      return answered(result);
    }
    setState((current: SeatOverridesState) => ({ ...current, view: { kind: 'ready', response: result.settings, refreshFailed: false } }));
    return true;
  }, [read]);

  const readNow = useObservationRefresh(observe, JSON.stringify(['seat-overrides', generation, sharedSaves]), { enabled });

  const runWrite = useCallback(async (
    key: string,
    send: (requestId: string) => Promise<SeatOverrideWrite>,
    apply: (previous: SeatOverridesV1, value: SeatOverrideResultV1) => SeatOverridesV1,
  ): Promise<SeatOverrideWrite> => {
    const id = pending.current?.key === key ? pending.current.id : crypto.randomUUID();
    pending.current = { key, id };
    const outcome = await send(id);
    if (outcome.state === 'ok') {
      pending.current = null;
      staleReadsThrough.current = readsStarted.current;
      setState((current: SeatOverridesState) => nextOverridesAfterWrite(current, outcome.value.config_revision, previous => apply(previous, outcome.value)));
      readNow();
      return outcome;
    }
    if (outcome.state === 'reload_required') {
      pending.current = null;
      setState((current: SeatOverridesState) => ({ ...current, needsReload: true }));
    } else if (outcome.state === 'refused' && !OVERRIDE_RETRY_SAME_REQUEST.has(outcome.error.code)) {
      pending.current = null;
    }
    return outcome;
  }, [readNow]);

  const authorize = useCallback((request: SeatOverrideSetRequestV1): Promise<SeatOverrideWrite> => {
    const instruction = normalizeOverrideInstruction(request.instruction) ?? request.instruction.trim();
    return runWrite(
      `set:${JSON.stringify(request)}`,
      (request_id: string) => writeSet({ request_id, ...request }),
      (previous: SeatOverridesV1, value: SeatOverrideResultV1) => ({
        ...previous,
        [request.seat]: {
          runtime: request.runtime,
          model: request.model,
          effort: request.effort,
          authorized_at: value.authorized_at ?? new Date().toISOString(),
          instruction,
        },
      }),
    );
  }, [runWrite, writeSet]);

  const revoke = useCallback((request: SeatOverrideRevokeRequestV1): Promise<SeatOverrideWrite> => runWrite(
    `revoke:${JSON.stringify(request)}`,
    (request_id: string) => writeRevoke({ request_id, ...request }),
    (previous: SeatOverridesV1) => withoutOverride(previous, request.seat),
  ), [runWrite, writeRevoke]);

  const reload = useCallback(() => {
    pending.current = null;
    readNow();
  }, [readNow]);

  return { view: state.view, saves: state.saves, needsReload: state.needsReload, authorize, revoke, reload };
}

export function seatsDraftOf(config: SeatsSettingsV1['config']): SeatsConfigV1 {
  const { revision: _revision, ...seats } = config;
  return seats;
}

const sameSeat = (left: SeatConfigV1 | null, right: SeatConfigV1 | null): boolean =>
  left === null || right === null ? left === right : left.runtime === right.runtime && left.model === right.model && left.effort === right.effort
  && left.advisor_model === right.advisor_model && left.tools.join() === right.tools.join() && left.fleet.join() === right.fleet.join();

const changedSectionFields = (base: SeatsConfigV1, draft: SeatsConfigV1): number =>
  ROUTING_KEYS.filter(field => JSON.stringify(base.routing[field]) !== JSON.stringify(draft.routing[field])).length
  + SEAT_SCAFFOLD_SUB_AGENTS.filter(role => base.pi_sub_agent_models?.[role] !== draft.pi_sub_agent_models?.[role]).length;

export const sameSeats = (left: SeatsConfigV1, right: SeatsConfigV1): boolean => SEAT_IDS.every(id => sameSeat(left[id], right[id])) && changedSectionFields(left, right) === 0;

/** Count the fields that the server names in `changed_keys`. */
export function seatChanges(base: SeatsConfigV1, draft: SeatsConfigV1): number {
  return SEAT_IDS.reduce((count, id) => {
    const before = base[id], after = draft[id];
    return count + (before === null || after === null ? Number(before !== after) : (['runtime', 'model', 'advisor_model', 'effort', 'tools', 'fleet'] as const)
      .filter(field => String(before[field]) !== String(after[field])).length);
  }, changedSectionFields(base, draft));
}

const SEATS_SECTION: SettingsSection<SeatsSettingsV1, SeatsSettingsV1['config'], SeatsConfigV1, SeatsSettingsRequestV1> = {
  id: 'seats',
  config: settings => settings.config,
  draftOf: seatsDraftOf,
  request: (base, draft) => (sameSeats(seatsDraftOf(base), draft) ? null : { expected_revision: base.revision, seats: draft }),
  sameDraft: sameSeats,
  applied: (revision, draft) => ({ revision, ...draft }),
};

export function useSeatsSettingsForm(read: SeatsSettingsReader, write: SeatsSettingsWriter, generation: number, agentsSaves: number, enabled: boolean): SeatsSettingsForm {
  return useSettingsForm(SEATS_SECTION, read, write, generation, agentsSaves, enabled);
}

const toggled = <T extends string>(items: readonly T[], item: T, on: boolean): readonly T[] =>
  on ? (items.includes(item) ? items : [...items, item].sort()) : items.filter(value => value !== item);

// The page edits the fields of a configured seat only; an optional seat set to null shows no seat controls.
const patch = (draft: SeatsConfigV1, seat: SeatId, change: Partial<SeatConfigV1>): SeatsConfigV1 => ({ ...draft, [seat]: { ...draft[seat]!, ...change } });

/**
 * A new runtime keeps the model only when it is a recommended entry of the seat on that runtime, keeps the effort only
 * where the runtime accepts it, and keeps fleet roles where the runtime and seat take them. Codex always runs commands,
 * so its shell group is on. The active runtime changes nothing.
 */
export function setSeatRuntime(draft: SeatsConfigV1, seat: SeatId, runtime: SeatRuntime, ranges: SeatsSettingsV1['ranges']): SeatsConfigV1 {
  const range = ranges.runtimes.find(entry => entry.id === runtime)!;
  const current = draft[seat]!;
  if (current.runtime === runtime) return draft;
  if (runtime === 'agy') {
    return patch(draft, seat, { ...agySeatStarter(seat), advisor_model: null, effort: null, fleet: [], tools: agySeatTools(seat, current.tools) });
  }
  const model = ranges.seats[seat].models.some(entry => entry.runtime === runtime && entry.model === current.model)
    ? current.model
    : seat === 'council' ? (ranges.seats.council.models.find(entry => entry.runtime === runtime)?.model ?? null) : null;
  return patch(draft, seat, {
    runtime,
    model,
    advisor_model: runtime === 'claude' ? current.advisor_model : null,
    effort: range.effort ? current.effort : null,
    fleet: range.fleet ? current.fleet.filter(role => ranges.seats[seat].fleet.includes(role)) : [],
    tools: runtime === 'codex' ? toggled(current.tools, 'shell', true) : current.tools,
  });
}

/** The efforts that an agy seat on this model may select: its catalog menu through the seat effort rule, or null while agy does not report that menu. */
export function agyEffortMenu(model: string | null, agyModels: SeatsSettingsV1['ranges']['agy_models']): readonly string[] | null {
  if (agyModels === null || model === null) return null;
  const listed = agyModels.find(entry => entry.id === model);
  if (listed === undefined) return [];
  return listed.efforts === null ? null : listed.efforts.filter(effort => agyEffortValid(model, effort));
}

/** An agy seat keeps its explicit effort across a model change only when the new model's menu offers it. */
export function setSeatModel(draft: SeatsConfigV1, seat: SeatId, model: string | null, agyModels: SeatsSettingsV1['ranges']['agy_models']): SeatsConfigV1 {
  const current = draft[seat]!;
  if (current.runtime !== 'agy' || current.effort === null || current.model === model) return patch(draft, seat, { model });
  return patch(draft, seat, { model, effort: agyEffortMenu(model, agyModels)?.includes(current.effort) ? current.effort : null });
}

export const setSeatAdvisorModel = (draft: SeatsConfigV1, seat: SeatId, advisor_model: string | null): SeatsConfigV1 => patch(draft, seat, { advisor_model });
export const setSeatEffort = (draft: SeatsConfigV1, seat: SeatId, effort: string | null): SeatsConfigV1 => patch(draft, seat, { effort });
export const setSeatTool = (draft: SeatsConfigV1, seat: SeatId, tool: SeatTool, on: boolean): SeatsConfigV1 =>
  patch(draft, seat, { tools: toggled(draft[seat]!.tools, tool, on) });

/**
 * An agy seat switches a tool group only when the result passes the tool rule that the section decoder enforces.
 * A worker keeps edit once on: the decoder accepts a read-only worker, but the launch refuses it.
 */
export function agyToolLocked(seat: SeatId, tools: readonly SeatTool[], tool: SeatTool): boolean {
  if (isWorkerSeat(seat) && tool === 'edit' && tools.includes('edit')) return true;
  return !isAgyToolsValid(seat, toggled(tools, tool, !tools.includes(tool)));
}
export const setSeatRole = (draft: SeatsConfigV1, seat: SeatId, role: string, on: boolean): SeatsConfigV1 =>
  patch(draft, seat, { fleet: toggled(draft[seat]!.fleet, role, on) });

export function setPiSubAgentModel(draft: SeatsConfigV1, role: SeatScaffoldSubAgent, model: string): SeatsConfigV1 {
  const { pi_sub_agent_models, ...seats } = draft;
  const models = { ...pi_sub_agent_models };
  if (model === '') delete models[role];
  else models[role] = model;
  return Object.keys(models).length === 0 ? seats : { ...seats, pi_sub_agent_models: models };
}

/**
 * Switching the gatekeeper-fallback seat on starts from a Pi Flash seat outside the model family
 * and the account of the default gatekeeper; the seat has no default of its own.
 */
export const GATEKEEPER_FALLBACK_STARTER: SeatConfigV1 = Object.freeze({
  runtime: 'pi', model: DEFAULT_SEATS_CONFIG['worker-light']!.model, advisor_model: null, effort: null, tools: DEFAULT_SEATS_CONFIG.gatekeeper.tools, fleet: [],
});

export function councilStarter(ranges: SeatsSettingsV1['ranges']): SeatConfigV1 | null {
  const recommended = ranges.seats.council.models.find(entry => ranges.runtimes.some(runtime => runtime.id === entry.runtime && runtime.enabled));
  if (recommended === undefined) return null;
  return {
    ...recommended,
    advisor_model: null,
    effort: null,
    tools: recommended.runtime === 'agy' ? AGY_READONLY_SEAT_TOOLS : COUNCIL_TOOLS,
    fleet: seatTakesFleet(recommended) ? ['explorer'] : [],
  };
}

/** An optional seat set to null leaves the routes, since the section refuses a route that names an unconfigured seat. */
export function setOptionalSeat(draft: SeatsConfigV1, id: OptionalSeatId, seat: SeatConfigV1 | null): SeatsConfigV1 {
  if (seat !== null) return { ...draft, [id]: seat };
  const routes = Object.fromEntries(ROUTING_CLASSES.map(task => [task, draft.routing[task].filter(route => route !== id)]));
  return { ...draft, [id]: null, routing: { ...draft.routing, ...routes } };
}

export const setRoute = (draft: SeatsConfigV1, task: RoutingClass, seats: readonly WorkerSeatId[]): SeatsConfigV1 =>
  ({ ...draft, routing: { ...draft.routing, [task]: seats } });
type RoutingValueField = 'claude_saving_below_remaining' | 'claude_hyper_at_or_above_remaining' | 'agy_saving_below_remaining' | 'exhausted_at_or_above_used' | 'codex_credit_mode' | 'codex_credit_floor';
export const setRoutingValue = <Field extends RoutingValueField>(draft: SeatsConfigV1, field: Field, value: SeatRoutingV1[Field]): SeatsConfigV1 =>
  ({ ...draft, routing: { ...draft.routing, [field]: value } });
export const setExplorer = (draft: SeatsConfigV1, change: Partial<SeatModelV1>): SeatsConfigV1 =>
  ({ ...draft, routing: { ...draft.routing, low_quota_explorer: { ...draft.routing.low_quota_explorer, ...change } } });
