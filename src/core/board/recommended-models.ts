import { DEFAULT_SEATS_CONFIG, MODEL_FAMILY_LABELS, PI_CODEX_MODEL_PREFIX, SEAT_IDS, type SeatRuntime } from './seats-settings';

// Per-agent Codex target overrides — the only model/effort remaps in the fleet.
// Every role carries an explicit target so Codex model/effort never drift with
// the Claude-side family default.
export const AGENT_TARGET_OVERRIDES: Record<string, { model: string; effort: string; targetDescription: string }> = {
  explorer: { model: "gpt-6-luna", effort: "high", targetDescription: "GPT-6 Luna at high reasoning" },
  "deep-reasoner": { model: "gpt-6.2-astra", effort: "high", targetDescription: "GPT-6.2 Astra at high reasoning" },
  "fast-worker": { model: "gpt-6.2-sol", effort: "medium", targetDescription: "GPT-6.2 Sol at medium reasoning" },
  "deep-worker": { model: "gpt-6.2-sol", effort: "high", targetDescription: "GPT-6.2 Sol at high reasoning" },
  gatekeeper: { model: "gpt-6.2-astra", effort: "medium", targetDescription: "GPT-6.2 Astra at medium reasoning" },
  "root-cause-prover": { model: "gpt-6.2-astra", effort: "high", targetDescription: "GPT-6.2 Astra at high reasoning" },
  "harness-evaluator": { model: "gpt-6.2-astra", effort: "medium", targetDescription: "GPT-6.2 Astra at medium reasoning" },
};

const CODEX_MODELS = [...new Set([...Object.values(AGENT_TARGET_OVERRIDES).map(target => target.model),
  ...SEAT_IDS.flatMap(id => {
    const seat = DEFAULT_SEATS_CONFIG[id];
    return seat?.runtime === 'codex' && seat.model !== null ? [seat.model] : [];
  }),
  // Seats that still use these earlier models keep them as choices.
  'gpt-6-astra', 'gpt-6.1-sol'])];

/**
 * The model ids that rh ships as recommendations (#3250): the seat ranges offer them, and only they may appear outside the launch argv.
 * Claude takes a fleet model family, Codex a fleet target model. Pi takes DeepSeek, GLM, Gemini or a Codex model behind `magpie/codex/`.
 */
export const RECOMMENDED_MODELS: Readonly<Record<SeatRuntime, readonly string[]>> = {
  claude: Object.keys(MODEL_FAMILY_LABELS),
  codex: CODEX_MODELS,
  pi: ['magpie/cursor/deepseek-v41-flash-1017', 'magpie/opencode-go/deepseek-v4.1-flash', 'magpie/group/deepseek-v4.1-flash', 'zai/glm-5.3', 'magpie/zcode/GLM-5.3', 'magpie/zcode/GLM-5.3-Flash', 'magpie/agy-cli/gemini-4-carbon', 'magpie/agy-cli/gemini-4-neon', ...CODEX_MODELS.map(model => `${PI_CODEX_MODEL_PREFIX}${model}`)],
};
