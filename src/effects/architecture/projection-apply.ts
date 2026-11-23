import type { ProjectionResultV3, ProjectionRequestV1 } from 'archctx-contracts';
import {
  architectureProjectionRequest,
  runArchitectureProjection,
  type ArchitectureProjectionRequestOptions,
} from './archctx-provider';
import type { ArchctxProviderOptions } from '../../core/architecture/contracts';

export interface ArchitectureProjectionApplyOptions extends ArchctxProviderOptions, ArchitectureProjectionRequestOptions {
  readonly mode?: 'apply' | 'adopt';
  readonly runProjection?: (request: ProjectionRequestV1, repoRoot: string) => ProjectionResultV3;
}

/**
 * archctx observes and applies at one snapshot in-process under its writer lock.
 * With the daemon and replay cache retired, every apply runs directly.
 */
export function applyArchitectureProjection(repoRoot: string, options: ArchitectureProjectionApplyOptions = {}): ProjectionResultV3 {
  const request = architectureProjectionRequest(options.mode ?? 'apply', repoRoot, options);
  return (options.runProjection ?? ((input, root) => runArchitectureProjection(input, root, options)))(request, repoRoot);
}
