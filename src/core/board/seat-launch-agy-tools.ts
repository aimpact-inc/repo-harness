import { isWorkerSeat, type LaunchSeatId, type SeatConfigV1 } from './seats-settings';

const AGY_READONLY_AGENT_TOOLS = Object.freeze(['view_file', 'run_command', 'search_web'] as const);
const AGY_WORKER_AGENT_TOOLS = Object.freeze(['view_file', 'write_file', 'edit_file', 'run_command', 'search_web'] as const);

export function agySeatAgentTools(seat: LaunchSeatId, config: SeatConfigV1): readonly string[] {
  if (isWorkerSeat(seat)) return AGY_WORKER_AGENT_TOOLS;
  if (seat === 'advisor') return [
    ...(config.tools.includes('edit') ? AGY_WORKER_AGENT_TOOLS : AGY_READONLY_AGENT_TOOLS),
    ...(config.tools.includes('schedule') ? ['schedule'] : []),
  ];
  if (seat === 'orchestrator' || seat === 'council' || seat === 'gatekeeper') return AGY_READONLY_AGENT_TOOLS;
  throw new Error(`agy is not supported on seat ${seat}.`);
}
