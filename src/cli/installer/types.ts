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
import type { ReportLanguageFlag } from './global-context';

export type Location = 'global';

export type DefaultTargetId = 'codex' | 'claude';
export type TargetId = DefaultTargetId | 'antigravity';

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
  /** Reporting language for Global Working Rules on targets that manage global rules. */
  readonly reportLanguage?: ReportLanguageFlag;
  /** True on `rh update`: refresh only already-recorded surfaces rather than opting in fresh. */
  readonly updateMode?: boolean;
  /** False when `--no-hooks` is passed on update. */
  readonly hooks?: boolean;
  /** The enclosing runtime transaction keeps whole-path preimages here. */
  readonly transaction?: string;
  readonly syncSkill?: boolean;
}

export interface TargetPathPreview {
  readonly items: readonly {
    readonly path: string;
    readonly selector: string;
    readonly action: 'create' | 'update' | 'remove';
  }[];
  readonly refusals: readonly string[];
}

export interface AgentTarget<Id extends TargetId = DefaultTargetId> {
  readonly id: Id;
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
  hostConfigChanges?(loc: Location, opts: InstallOptions, env?: NodeJS.ProcessEnv): readonly HostConfigFileChange[];
  /**
   * Optional read-only preview of whole-path operations (such as projected
   * skill symlinks and their collisions/refusals), sharing the same planner
   * as `install`.
   */
  hostConfigPathPreview?(loc: Location, opts: InstallOptions, env?: NodeJS.ProcessEnv): TargetPathPreview;
}
