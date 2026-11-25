import {
  AGY_HYDROGEN_ENTRY,
  AGY_HYDROGEN_VARIANTS,
  AGY_NEON_VARIANTS,
  AGY_NEON_XHIGH_ENTRY,
  CATALOG_AGENT_TARGET_OVERRIDES,
  catalogEntry,
  catalogModelIds,
  type AgentTargetOverride,
} from './model-catalog';
import { DEFAULT_SEATS_CONFIG, PI_CODEX_MODEL_PREFIX, SEAT_IDS, type SeatId, type SeatModelEntryV1 } from './seats-settings';

// Per-agent Codex target overrides — the only model/effort remaps in the fleet.
// Every role carries an explicit target so Codex model/effort never drift with
// the Claude-side family default.
export const AGENT_TARGET_OVERRIDES: Record<string, AgentTargetOverride> = { ...CATALOG_AGENT_TARGET_OVERRIDES };

const OPUS = catalogEntry('opus', 'native');
const FABLE = catalogEntry('fable', 'native');
const NEON = catalogEntry('neon', 'magpie');
const CARBON = catalogEntry('carbon', 'magpie');
const PI_HYDROGEN = catalogEntry('hydrogen', 'magpie');
const PI_SOL = catalogEntry('sol', 'magpie');
const SOL = catalogEntry('sol', 'native');
const ASTRA = catalogEntry('astra', 'native');
const PI_ASTRA = catalogEntry('astra', 'magpie');
export const AGY_ADVISOR_STARTER = catalogEntry('neon', 'native');
export const AGY_COUNCIL_STARTER = catalogEntry('carbon', 'native');
const GLM_FLASH = catalogEntry('glm-5.3-flash', 'magpie');
const GLM_5_4 = catalogEntry('glm-5.4', 'magpie');
const DEEPSEEK_FLASH = catalogEntry('deepseek-v4.1-flash', 'magpie');

export function agySeatStarter(seat: SeatId): SeatModelEntryV1 {
  if (seat === 'council') return AGY_COUNCIL_STARTER;
  if (seat === 'worker-neon-deep') return AGY_NEON_XHIGH_ENTRY;
  if (seat === 'worker-light' || seat === 'gatekeeper-fallback') return AGY_HYDROGEN_ENTRY;
  return AGY_ADVISOR_STARTER;
}

const WORKER = Object.freeze([
  OPUS,
  NEON,
  ...AGY_NEON_VARIANTS,
  PI_SOL,
  SOL,
  GLM_FLASH,
  DEEPSEEK_FLASH,
  PI_HYDROGEN,
  ...AGY_HYDROGEN_VARIANTS,
]);
const REVIEW = Object.freeze([
  PI_SOL,
  SOL,
  OPUS,
  GLM_FLASH,
  DEEPSEEK_FLASH,
  PI_HYDROGEN,
  ...AGY_HYDROGEN_VARIANTS,
]);

/**
 * The models that rh recommends for each seat kind, derived from `model-catalog.ts` (ADR-0006 §1).
 * The settings page offers them; the user can set any other id (#3250). A release that moves a model
 * line changes its entry in `model-catalog.ts`; a stored value is never rewritten.
 */
export const SEAT_RECOMMENDED_MODELS: Readonly<Record<SeatId, readonly SeatModelEntryV1[]>> = Object.freeze({
  orchestrator: Object.freeze([OPUS, NEON]),
  advisor: Object.freeze([OPUS, NEON, FABLE, CARBON, ...AGY_NEON_VARIANTS]),
  council: Object.freeze([FABLE, CARBON, AGY_COUNCIL_STARTER, PI_ASTRA, ASTRA]),
  worker: WORKER,
  'worker-deep': WORKER,
  'worker-opus': WORKER,
  'worker-neon': WORKER,
  'worker-neon-deep': WORKER,
  'worker-light': Object.freeze([...WORKER, GLM_5_4]),
  gatekeeper: REVIEW,
  'gatekeeper-fallback': REVIEW,
  reviewer: Object.freeze([...REVIEW, GLM_5_4]),
});

const recommended = Object.values(SEAT_RECOMMENDED_MODELS).flat();
const defaults = [...SEAT_IDS.map(id => DEFAULT_SEATS_CONFIG[id]?.model), DEFAULT_SEATS_CONFIG.routing.low_quota_explorer.model]
  .filter((model): model is string => typeof model === 'string');

/**
 * The model ids that may appear outside the launch argv (#3250): every catalog id, every recommended id,
 * every default id, and each recommended Codex id on the Pi Codex route, which runs the same model on the same account.
 */
export const SHIPPED_MODEL_IDS: ReadonlySet<string> = new Set([
  ...catalogModelIds(),
  ...recommended.map(item => item.model),
  ...defaults,
  ...recommended.filter(item => item.runtime === 'codex').map(item => `${PI_CODEX_MODEL_PREFIX}${item.model}`),
]);
