/** Default adapter pair for install, update and the shared host checks. */

import type { AgentTarget, TargetId } from '../types';
import { codexTarget } from './codex';
import { claudeTarget } from './claude';
import { antigravityTarget } from './antigravity';

export const ALL_TARGETS: readonly AgentTarget[] = Object.freeze([
  codexTarget,
  claudeTarget,
]);

const TARGETS: readonly AgentTarget<TargetId>[] = [...ALL_TARGETS, antigravityTarget];

export function getTarget(id: string): AgentTarget<TargetId> | undefined {
  return TARGETS.find((target) => target.id === id);
}

export function listTargetIds(): TargetId[] {
  return TARGETS.map((target) => target.id);
}
