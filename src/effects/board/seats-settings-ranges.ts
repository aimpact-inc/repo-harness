import { SEAT_RECOMMENDED_MODELS } from '../../core/board/recommended-models';
import {
  ALLOWED_SEAT_FLEET_ROLES, COUNCIL_TOOLS, ROUTING_KEYS, SEAT_IDS, SEAT_SCAFFOLD_SUB_AGENTS, SEAT_TOOLS,
  type SeatId, type SeatRangeV1, type SeatRuntime, type SeatRuntimeRangeV1, type SeatsConfigV1, type SeatsRangesV1, type SeatTool,
} from '../../core/board/seats-settings';

const without = (...excluded: SeatTool[]): readonly SeatTool[] => SEAT_TOOLS.filter(tool => !excluded.includes(tool));

/**
 * Per-seat scaffold sub-agent and tool grants (ADR-0006 §3).
 * The orchestrator does not edit (#1472). The advisor may edit proposals (#2032) and post GitHub comments and intake issues when `gh` is granted (#3468).
 */
const SEAT_ACCESS: { readonly [seat in SeatId]: Omit<SeatRangeV1, 'models'> } = {
  orchestrator: { fleet: ALLOWED_SEAT_FLEET_ROLES.orchestrator, tools: without('edit') },
  advisor: { fleet: ALLOWED_SEAT_FLEET_ROLES.advisor, tools: SEAT_TOOLS },
  council: { fleet: ALLOWED_SEAT_FLEET_ROLES.council, tools: COUNCIL_TOOLS },
  worker: { fleet: ALLOWED_SEAT_FLEET_ROLES.worker, tools: SEAT_TOOLS },
  'worker-deep': { fleet: ALLOWED_SEAT_FLEET_ROLES['worker-deep'], tools: SEAT_TOOLS },
  'worker-opus': { fleet: ALLOWED_SEAT_FLEET_ROLES['worker-opus'], tools: SEAT_TOOLS },
  'worker-neon': { fleet: ALLOWED_SEAT_FLEET_ROLES['worker-neon'], tools: SEAT_TOOLS },
  'worker-neon-deep': { fleet: ALLOWED_SEAT_FLEET_ROLES['worker-neon-deep'], tools: SEAT_TOOLS },
  'worker-light': { fleet: ALLOWED_SEAT_FLEET_ROLES['worker-light'], tools: SEAT_TOOLS },
  gatekeeper: { fleet: ALLOWED_SEAT_FLEET_ROLES.gatekeeper, tools: ['net', 'read', 'shell'] },
  'gatekeeper-fallback': { fleet: ALLOWED_SEAT_FLEET_ROLES['gatekeeper-fallback'], tools: ['net', 'read', 'shell'] },
  reviewer: { fleet: ALLOWED_SEAT_FLEET_ROLES.reviewer, tools: ['net', 'read', 'shell'] },
};
export const SEAT_RANGES = Object.fromEntries(SEAT_IDS.map(id => [id, { models: SEAT_RECOMMENDED_MODELS[id], ...SEAT_ACCESS[id] }])) as SeatsRangesV1['seats'];

export const RUNTIME_RANGES: Readonly<Record<SeatRuntime, Omit<SeatRuntimeRangeV1, 'id' | 'enabled'>>> = {
  claude: { effort: true, fleet: true },
  codex: { effort: true, fleet: true },
  pi: { effort: true, fleet: true },
  agy: { effort: true, fleet: false },
};

const FIELDS = ['runtime', 'model', 'advisor_model', 'effort', 'tools', 'fleet'] as const;

export function changedKeys(current: SeatsConfigV1, next: SeatsConfigV1): string[] {
  return [...SEAT_IDS.flatMap(id => {
    const before = current[id], after = next[id];
    if (before === null || after === null) return before === after ? [] : [`seats.${id}`];
    return FIELDS.filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
      .map(field => `seats.${id}.${field}`);
  }),
  ...ROUTING_KEYS
    .filter(field => JSON.stringify(current.routing[field]) !== JSON.stringify(next.routing[field]))
    .map(field => `seats.routing.${field}`),
  ...SEAT_SCAFFOLD_SUB_AGENTS
    .filter(role => current.pi_sub_agent_models?.[role] !== next.pi_sub_agent_models?.[role])
    .map(role => `seats.pi_sub_agent_models.${role}`)];
}
