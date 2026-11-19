/** Default adapter pair for install, update and the shared host checks. */

import type { AgentTarget, DefaultTargetId, TargetId } from '../types';
import { codexTarget } from './codex';
import { claudeTarget } from './claude';
import { antigravityTarget } from './antigravity';

export const ALL_TARGETS: readonly AgentTarget[] = Object.freeze([
  codexTarget,
  claudeTarget,
]);

export function getTarget(id: string): AgentTarget<TargetId> | undefined {
  if (id === antigravityTarget.id) return antigravityTarget;
  return ALL_TARGETS.find((target) => target.id === id);
}

/** The targets selected together by default, in registry order. */
export function listTargetIds(): DefaultTargetId[] {
  return ALL_TARGETS.map((target) => target.id);
}
