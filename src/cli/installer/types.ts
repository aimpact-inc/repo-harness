/**
 * Target abstraction for the repo-harness hook-runtime installer.
 *
 * Each host (Codex CLI, Claude Code) implements AgentTarget so the
 * installer orchestrator can write the right hook config without
 * baking host-specific paths into core code. Adding a new host =
 * one new file in targets/ + one entry in registry.ts.
 *
 * Modeled after _ref/codegraph/src/installer/targets/types.ts:15,51-62
 * but scoped to hook-runtime installation (Codex hooks.json + Claude
 * settings.json), not MCP server registration.
 */

import type { OverrideSelection } from '../../core/host-config/override';
import type { HostConfigFileChange } from '../../effects/host-config/gate';

export type Location = 'global';

/**
 * Stable id for the --target CLI flag and registry lookup.
 * Phase 1 supports codex + claude only; more hosts can be added in
 * Phase 2+ by appending to this union and registry.ts.
 */
export type TargetId = 'codex' | 'claude';

export interface DetectionResult {
  installed: boolean;
  alreadyConfigured: boolean;
  /** Path inspected; surfaced in diagnostic / dry-run output. */
  configPath?: string;
}

/**
 * What target.install(location) actually changed on disk. The
 * orchestrator renders one log line per file using `action`.
 *
 * `unchanged` means the file content already matched what we'd write
 * — used for byte-identical idempotent re-runs.
 */
export interface WriteResult {
  files: Array<{
    path: string;
    action: 'created' | 'updated' | 'unchanged' | 'removed' | 'not-found' | 'kept';
    /** Printed in place of the path, e.g. the user's value that a `kept` file keeps. */
    detail?: string;
  }>;
  /**
   * Optional short one-liner notes the orchestrator surfaces verbatim
   * — e.g. "Restart Codex to register the hook trust hash." Keep these
   * short; long-form goes in README / Phase 1E docs.
   */
  notes?: string[];
}

export interface InstallOptions {
  /** The user's `--override` selection; a target without `hostConfigChanges` takes none. */
  readonly overrides?: OverrideSelection;
}

export interface AgentTarget {
  readonly id: TargetId;
  readonly displayName: string;
  /**
   * Hook adapters support only the user-level global location.
   */
  supportsLocation(loc: Location): boolean;
  detect(loc: Location): DetectionResult;
  install(loc: Location, opts: InstallOptions): WriteResult;
  /**
   * The host-config changes that `install` applies, built from the current
   * files without a write: the dry run plans them and the override check
   * reads their selectors. A target without it takes no override selection.
   */
  hostConfigChanges?(loc: Location, opts: InstallOptions): readonly HostConfigFileChange[];
}
