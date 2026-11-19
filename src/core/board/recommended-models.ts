import { DEFAULT_SEATS_CONFIG, PI_CODEX_MODEL_PREFIX, SEAT_IDS, type SeatId, type SeatModelEntryV1 } from './seats-settings';

// Per-agent Codex target overrides — the only model/effort remaps in the fleet.
// Every role carries an explicit target so Codex model/effort never drift with
// the Claude-side family default.
export const AGENT_TARGET_OVERRIDES: Record<string, { model: string; effort: string; targetDescription: string }> = {
  explorer: { model: "gpt-6-luna", effort: "high", targetDescription: "GPT-6 Luna at high reasoning" },
  "deep-reasoner": { model: "gpt-6.2-astra", effort: "high", targetDescription: "GPT-6.2 Astra at high reasoning" },
  "harness-evaluator": { model: "gpt-6.2-astra", effort: "medium", targetDescription: "GPT-6.2 Astra at medium reasoning" },
};

const entry = (runtime: SeatModelEntryV1['runtime'], model: string): SeatModelEntryV1 => Object.freeze({ runtime, model });
const OPUS = entry('claude', 'opus');
const SOL = entry('codex', 'gpt-6.2-sol');
export const AGY_ADVISOR_STARTER = entry('agy', 'gemini-4-neon-high');
// One id per model line, the newest release (#3252). GLM flash: the id that the review launcher runs. DeepSeek flash: the id that the Pi seats run.
const GLM_FLASH = entry('pi', 'zai/glm-5.3-flash');
const DEEPSEEK_FLASH = entry('pi', 'magpie/group/deepseek-v4.1-flash');
const WORKER = Object.freeze([OPUS, entry('claude', 'sonnet'), SOL, entry('codex', 'gpt-6.1-terra'), GLM_FLASH, DEEPSEEK_FLASH]);
const REVIEW = Object.freeze([SOL, entry('codex', 'gpt-6.2-astra'), GLM_FLASH]);

/**
 * The models that rh recommends for each seat kind, in the owner's order (owner list, 2026-11-19, #3252). The settings page offers them;
 * the user can set any other id (#3250). A release that moves a model line changes its entry here; a stored value is never rewritten.
 * Every worker seat offers the whole worker list, ordered from the hardest work to the lightest.
 */
export const SEAT_RECOMMENDED_MODELS: Readonly<Record<SeatId, readonly SeatModelEntryV1[]>> = Object.freeze({
  orchestrator: Object.freeze([OPUS]),
  advisor: Object.freeze([OPUS, entry('claude', 'fable'), entry('pi', 'magpie/agy-cli/gemini-4-neon'), entry('pi', 'magpie/agy-cli/gemini-4-carbon'),
    entry('agy', 'gemini-4-neon-low'), entry('agy', 'gemini-4-neon-medium'), AGY_ADVISOR_STARTER, entry('agy', 'gemini-4-neon-xhigh')]),
  planner: Object.freeze([entry('pi', 'magpie/agy-cli/gemini-4-carbon'), entry('pi', 'magpie/agy-cli/gemini-4-neon'), entry('codex', 'gpt-6.2-astra'), OPUS]),
  worker: WORKER,
  'worker-deep': WORKER,
  'worker-important': WORKER,
  'worker-important-fast': WORKER,
  'worker-light': WORKER,
  gatekeeper: REVIEW,
  'gatekeeper-deep': REVIEW,
  'gatekeeper-fallback': REVIEW,
  reviewer: REVIEW,
});

const recommended = Object.values(SEAT_RECOMMENDED_MODELS).flat();
const defaults = [...SEAT_IDS.map(id => DEFAULT_SEATS_CONFIG[id]?.model), DEFAULT_SEATS_CONFIG.routing.low_quota_explorer.model]
  .filter((model): model is string => typeof model === 'string');

/**
 * The model ids that may appear outside the launch argv (#3250): every recommended id, every default id, and each recommended
 * Codex id on the Pi Codex route, which runs the same model on the same account.
 */
export const SHIPPED_MODEL_IDS: ReadonlySet<string> = new Set([
  ...recommended.map(item => item.model),
  ...defaults,
  ...recommended.filter(item => item.runtime === 'codex').map(item => `${PI_CODEX_MODEL_PREFIX}${item.model}`),
]);
