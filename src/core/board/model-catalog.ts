import { AGY_HYDROGEN_HIGH_MODEL, AGY_NEON_XHIGH_MODEL, MODEL_FAMILY_LABELS, PI_AGY_MODEL_PREFIX, PI_CODEX_MODEL_PREFIX, type SeatId, type SeatModelEntryV1, type SeatRuntime } from './seats-settings';
import type { QuotaAccount } from './quota';

export const LOGICAL_MODEL_IDS = [
  'opus',
  'fable',
  'haiku',
  'carbon',
  'neon',
  'hydrogen',
  'astra',
  'sol',
  'terra',
  'luna',
  'glm-5.3-flash',
  'glm-5.4',
  'deepseek-v4.1-flash',
] as const;

export type LogicalModelId = typeof LOGICAL_MODEL_IDS[number];

export type ModelVendorFamily = 'anthropic' | 'google' | 'openai' | 'zhipu' | 'deepseek';

export type ModelCatalogAccount = QuotaAccount | 'flash_api';

export type LogicalModelPlane =
  | 'orchestrator'
  | 'advisor'
  | 'council'
  | 'worker-opus'
  | 'worker-neon'
  | 'worker-neon-deep'
  | 'worker-deep'
  | 'worker'
  | 'worker-light'
  | 'gatekeeper'
  | 'gatekeeper-fallback'
  | 'reviewer'
  | 'explorer'
  | 'deep-reasoner'
  | 'harness-evaluator';

export interface LogicalModelRoute extends SeatModelEntryV1 {
  readonly effort?: string | null;
}

export interface LogicalModelEntry {
  readonly id: LogicalModelId;
  readonly family: ModelVendorFamily;
  readonly account: ModelCatalogAccount;
  readonly magpie: LogicalModelRoute | null;
  readonly native: LogicalModelRoute | null;
  readonly planes: readonly LogicalModelPlane[];
}

const route = (runtime: SeatRuntime, model: string, effort?: string | null): LogicalModelRoute =>
  Object.freeze(effort === undefined ? { runtime, model } : { runtime, model, effort });

const defineModel = (entry: LogicalModelEntry): LogicalModelEntry => Object.freeze({
  ...entry,
  planes: Object.freeze([...entry.planes]),
});

export const MODEL_CATALOG: Readonly<Record<LogicalModelId, LogicalModelEntry>> = Object.freeze({
  opus: defineModel({
    id: 'opus',
    family: 'anthropic',
    account: 'claude',
    magpie: route('claude', 'opus', 'high'),
    native: route('claude', 'opus', 'high'),
    planes: ['orchestrator', 'worker-opus', 'reviewer'],
  }),
  fable: defineModel({
    id: 'fable',
    family: 'anthropic',
    account: 'claude',
    magpie: route('claude', 'fable', 'high'),
    native: route('claude', 'fable', 'high'),
    planes: ['council'],
  }),
  haiku: defineModel({
    id: 'haiku',
    family: 'anthropic',
    account: 'claude',
    magpie: route('claude', 'haiku', 'high'),
    native: route('claude', 'haiku', 'high'),
    planes: ['explorer'],
  }),
  carbon: defineModel({
    id: 'carbon',
    family: 'google',
    account: 'agy_gemini',
    magpie: route('pi', `${PI_AGY_MODEL_PREFIX}gemini-4-carbon`, 'high'),
    native: route('agy', 'gemini-4-carbon-high', null),
    planes: ['council', 'advisor'],
  }),
  neon: defineModel({
    id: 'neon',
    family: 'google',
    account: 'agy_gemini',
    magpie: route('pi', `${PI_AGY_MODEL_PREFIX}gemini-4-neon`, 'xhigh'),
    native: route('agy', 'gemini-4-neon-high', null),
    planes: ['advisor', 'worker-neon', 'worker-neon-deep'],
  }),
  hydrogen: defineModel({
    id: 'hydrogen',
    family: 'google',
    account: 'agy_gemini',
    magpie: route('pi', `${PI_AGY_MODEL_PREFIX}gemini-4-hydrogen`, 'high'),
    native: route('agy', AGY_HYDROGEN_HIGH_MODEL, null),
    planes: ['worker-light', 'gatekeeper-fallback', 'explorer'],
  }),
  astra: defineModel({
    id: 'astra',
    family: 'openai',
    account: 'chatgpt',
    magpie: route('pi', `${PI_CODEX_MODEL_PREFIX}gpt-6.2-astra`, 'high'),
    native: route('codex', 'gpt-6.2-astra', 'high'),
    planes: ['council'],
  }),
  sol: defineModel({
    id: 'sol',
    family: 'openai',
    account: 'chatgpt',
    magpie: route('pi', `${PI_CODEX_MODEL_PREFIX}gpt-6.2-sol`, 'high'),
    native: route('codex', 'gpt-6.2-sol', 'high'),
    planes: ['worker-deep', 'gatekeeper', 'deep-reasoner', 'harness-evaluator'],
  }),
  terra: defineModel({
    id: 'terra',
    family: 'openai',
    account: 'chatgpt',
    magpie: route('pi', `${PI_CODEX_MODEL_PREFIX}gpt-6.1-terra`, 'high'),
    native: route('codex', 'gpt-6.1-terra', 'high'),
    planes: ['worker'],
  }),
  luna: defineModel({
    id: 'luna',
    family: 'openai',
    account: 'chatgpt',
    magpie: route('pi', `${PI_CODEX_MODEL_PREFIX}gpt-6-luna`, 'high'),
    native: route('codex', 'gpt-6-luna', 'high'),
    planes: ['explorer'],
  }),
  'glm-5.3-flash': defineModel({
    id: 'glm-5.3-flash',
    family: 'zhipu',
    account: 'flash_api',
    magpie: route('pi', 'zai/glm-5.3-flash', null),
    native: null,
    planes: ['worker-light', 'gatekeeper-fallback', 'explorer'],
  }),
  'glm-5.4': defineModel({
    id: 'glm-5.4',
    family: 'zhipu',
    account: 'flash_api',
    magpie: route('pi', 'magpie/zcode/GLM-5.4', null),
    native: null,
    planes: ['worker-light', 'reviewer', 'gatekeeper-fallback'],
  }),
  'deepseek-v4.1-flash': defineModel({
    id: 'deepseek-v4.1-flash',
    family: 'deepseek',
    account: 'flash_api',
    magpie: route('pi', 'magpie/group/deepseek-v4.1-flash', null),
    native: null,
    planes: ['worker-light', 'gatekeeper-fallback'],
  }),
});

export type TransportPreset = 'magpie' | 'native';

export function resolveCatalogRoute(id: LogicalModelId, preset: TransportPreset): LogicalModelRoute | null {
  return MODEL_CATALOG[id][preset];
}

export function catalogEntry(id: LogicalModelId, routeKind: TransportPreset): SeatModelEntryV1 {
  const resolved = resolveCatalogRoute(id, routeKind);
  if (resolved === null) throw new Error(`Logical model ${id} has no ${routeKind} route.`);
  return Object.freeze({ runtime: resolved.runtime, model: resolved.model });
}

export const AGY_NEON_XHIGH_ENTRY: SeatModelEntryV1 = Object.freeze({ runtime: 'agy', model: AGY_NEON_XHIGH_MODEL });

export const AGY_NEON_VARIANTS: readonly SeatModelEntryV1[] = Object.freeze([
  Object.freeze({ runtime: 'agy', model: 'gemini-4-neon-low' }),
  Object.freeze({ runtime: 'agy', model: 'gemini-4-neon-medium' }),
  catalogEntry('neon', 'native'),
  AGY_NEON_XHIGH_ENTRY,
]);

export const AGY_HYDROGEN_ENTRY: SeatModelEntryV1 = catalogEntry('hydrogen', 'native');
export const AGY_HYDROGEN_VARIANTS: readonly SeatModelEntryV1[] = Object.freeze([
  Object.freeze({ runtime: 'agy', model: 'gemini-4-hydrogen-low' }),
  Object.freeze({ runtime: 'agy', model: 'gemini-4-hydrogen-medium' }),
  AGY_HYDROGEN_ENTRY,
  Object.freeze({ runtime: 'agy', model: 'gemini-4-hydrogen-xhigh' }),
]);

const OPENAI_CODEX_TARGET_LABELS: Readonly<Record<'sol' | 'terra' | 'luna' | 'astra', string>> = Object.freeze({
  sol: 'GPT-6.2 Sol',
  terra: 'GPT-6.1 Terra',
  luna: 'GPT-6 Luna',
  astra: 'GPT-6.2 Astra',
});

export interface AgentTargetOverride {
  readonly model: string;
  readonly effort: string;
  readonly targetDescription: string;
}

function codexTargetOverride(id: 'sol' | 'luna', effort: string): AgentTargetOverride {
  const native = resolveCatalogRoute(id, 'native');
  if (native === null || native.runtime !== 'codex') throw new Error(`Missing native codex route for ${id}`);
  return Object.freeze({
    model: native.model,
    effort,
    targetDescription: `${OPENAI_CODEX_TARGET_LABELS[id]} at ${effort} reasoning`,
  });
}

// Per-agent Codex target overrides — the only model/effort remaps in the fleet.
// Every role carries an explicit target so Codex model/effort never drift with
// the Claude-side family default.
export const CATALOG_AGENT_TARGET_OVERRIDES: Readonly<Record<string, AgentTargetOverride>> = Object.freeze({
  explorer: codexTargetOverride('luna', 'high'),
  'deep-reasoner': codexTargetOverride('sol', 'high'),
  'harness-evaluator': codexTargetOverride('sol', 'medium'),
});

/** Check whether a model ID matches a known logical model entry in the catalog. */
export function catalogModelIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of Object.values(MODEL_CATALOG)) {
    if (entry.magpie !== null) ids.add(entry.magpie.model);
    if (entry.native !== null) ids.add(entry.native.model);
  }
  for (const entry of [...AGY_NEON_VARIANTS, ...AGY_HYDROGEN_VARIANTS]) ids.add(entry.model);
  return ids;
}

/**
 * Resolve quota account from a configured runtime and model ID using the catalog rules.
 * Keeps free-form model IDs working (`gemini-*` on `agy` -> `agy_gemini`, `magpie/codex/*` -> `chatgpt`).
 */
export function catalogSeatAccount(seat: { readonly runtime: SeatRuntime; readonly model: string | null }): QuotaAccount | null {
  if (seat.runtime === 'claude') return 'claude';
  if (seat.runtime === 'codex' || (seat.runtime === 'pi' && seat.model?.startsWith(PI_CODEX_MODEL_PREFIX) === true)) {
    return 'chatgpt';
  }
  if (seat.runtime === 'agy' && seat.model !== null) {
    return seat.model.startsWith('gemini-') ? 'agy_gemini' : 'agy_other';
  }
  if (seat.runtime === 'pi' && seat.model?.startsWith(PI_AGY_MODEL_PREFIX)) {
    return seat.model.startsWith(`${PI_AGY_MODEL_PREFIX}gemini-`) ? 'agy_gemini' : 'agy_other';
  }
  if (seat.model !== null) {
    for (const entry of Object.values(MODEL_CATALOG)) {
      if (entry.account === 'flash_api') continue;
      if ((entry.magpie?.runtime === seat.runtime && entry.magpie.model === seat.model)
        || (entry.native?.runtime === seat.runtime && entry.native.model === seat.model)) {
        return entry.account;
      }
    }
  }
  return null;
}

/**
 * Validate whether a logical model or catalog entry is permitted on a seat plane.
 * Free-form user-set model IDs outside the catalog stay allowed when shaped validly (#3250).
 */
export function isCatalogModelPermittedOnSeat(seatId: SeatId, entry: SeatModelEntryV1): boolean {
  const matched = Object.values(MODEL_CATALOG).filter(item =>
    (item.magpie?.runtime === entry.runtime && item.magpie.model === entry.model)
    || (item.native?.runtime === entry.runtime && item.native.model === entry.model),
  );
  if (matched.length === 0) return true;
  return matched.some(item => item.planes.includes(seatId));
}

export { MODEL_FAMILY_LABELS };
