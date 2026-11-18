import { runUserUninstall } from '../installer/uninstall';
/**
 * `rh install|uninstall --target codex|claude|both --location global`
 *
 * Resolves --target to AgentTarget list for install. Uninstall restores
 * owned user configuration. Idempotent: re-run with no diff returns
 * `action: 'unchanged'` or `action: 'not-found'` (verified by
 * tests/cli/install.test.ts).
 *
 * Target/location matrix:
 *   - codex + global → writes ~/.codex/hooks.json
 *   - claude + global → writes ~/.claude/settings.json
 *   - both + global   → codex + claude
 */

import { existsSync, readFileSync } from 'fs';
import type { Location, TargetId } from '../installer/types';
import { ALL_TARGETS, getTarget, listTargetIds } from '../installer/targets/registry';
import { planJsonConfigMigration } from '../installer/json-config-migration';
import { planFile, type PlannedFragment } from '../../core/host-config/plan';
import { NO_OVERRIDES, formatOverride, parseOverride, unmatchedOverrides, type OverrideSelection } from '../../core/host-config/override';
import type { FragmentRecord, SkippedOverride } from '../../core/host-config/types';
import { openHostConfigGate, type HostConfigFileChange, type HostConfigGate } from '../../effects/host-config/gate';
import { hostConfigPaths, resolveHostPath } from '../../effects/host-config/store';

export type InstallTargetSpec = 'codex' | 'claude' | 'both';

export interface InstallCommandOptions {
  target: InstallTargetSpec;
  location: Location;
  overrides?: OverrideSelection;
}

export interface UninstallCommandOptions {
  target: InstallTargetSpec;
  location: Location;
  dryRun?: boolean;
  removeEditedBlocks?: readonly string[];
}

export interface InstallCommandResult {
  exitCode: number;
  lines: string[];
}

function resolveTargets(spec: InstallTargetSpec) {
  if (spec === 'both') return [...ALL_TARGETS];
  const t = getTarget(spec);
  if (!t) {
    throw new Error(
      `rh install: unknown --target "${spec}" (known: ${listTargetIds().join(', ')}, both)`,
    );
  }
  return [t];
}

export function runInstall(opts: InstallCommandOptions): InstallCommandResult {
  if (opts.location !== 'global') {
    return { exitCode: 2, lines: [`rh install: invalid --location "${opts.location}" (expected: global)`] };
  }
  const targets = resolveTargets(opts.target);
  const lines: string[] = [];
  let exitCode = 0;

  for (const target of targets) {
    try {
      const result = target.install(opts.location, { overrides: opts.overrides ?? NO_OVERRIDES });
      for (const file of result.files) {
        lines.push(`[${target.id}] ${file.action}: ${file.detail ?? file.path}`);
      }
      for (const note of result.notes ?? []) {
        lines.push(`[${target.id}] note: ${note}`);
      }
    } catch (err) {
      lines.push(`[${target.id}] error: ${(err as Error).message}`);
      if (exitCode === 0) exitCode = 1;
    }
  }

  return { exitCode, lines };
}

/** Parses each `--override` once and resolves its path with the user's links followed. */
export function resolveOverrides(raw: readonly string[], env: NodeJS.ProcessEnv): OverrideSelection {
  if (!raw.length) return NO_OVERRIDES;
  const paths = hostConfigPaths(env);
  return raw.map(parseOverride).map((entry) => ({ path: resolveHostPath(paths, entry.path), selector: entry.selector }));
}

/** The host-config changes of each target that the run installs; null `spec` when the run installs no host adapters. */
function targetChanges(spec: InstallTargetSpec | null, overrides: OverrideSelection) {
  return (spec === null ? [] : resolveTargets(spec)).map((target) => ({
    target,
    changes: () => target.hostConfigChanges?.('global', { overrides }) ?? null,
  }));
}

/**
 * Refuses, before any write, an override that no request of the run carries:
 * no writer of this run builds the fragment, or its writer takes no selection
 * yet. The check builds the same requests that the install applies.
 */
export function assertOverridesCarried(spec: InstallTargetSpec | null, overrides: OverrideSelection, env: NodeJS.ProcessEnv): void {
  if (!overrides.length) return;
  const paths = hostConfigPaths(env);
  const offered = targetChanges(spec, overrides).flatMap(({ changes }) => changes() ?? [])
    .map((change) => ({ path: resolveHostPath(paths, change.path), selectors: change.fragments.map((fragment) => fragment.selector) }));
  const missing = unmatchedOverrides(overrides, offered);
  if (missing.length) {
    throw new Error(`--override: no host-config write of this run can take ${missing.map(formatOverride).join(', ')}; check the path, the selector, --target and --no-hooks`);
  }
}

export interface HostConfigPreviewItem {
  readonly path: string;
  readonly selector: string;
  readonly action: 'add' | 'refresh' | 'override' | SkippedOverride['code'];
}

export interface HostConfigPreview {
  readonly items: readonly HostConfigPreviewItem[];
  /** A target whose items are not listed, and why. */
  readonly unplanned: readonly { readonly target: TargetId; readonly reason: string }[];
}

/** The gate's rule for user bytes: an edit that removes nothing adds, one that removes rh's recorded text refreshes, any other overrides. */
function plannedAction(fragment: PlannedFragment): 'add' | 'refresh' | 'override' {
  if (fragment.edit.removed === '') return 'add';
  return fragment.previous?.inserted === fragment.edit.removed ? 'refresh' : 'override';
}

/** The records that the install plans against: the projected ledger, or for an unrecorded JSON file the adoption that the install runs first. */
function previewRecords(gate: HostConfigGate, env: NodeJS.ProcessEnv, requested: string, path: string): readonly FragmentRecord[] {
  const recorded = gate.recorded(requested);
  if (recorded.length) return recorded;
  const adoption = planJsonConfigMigration(env, [requested])?.files.find((file) => file.path === requested)?.adoption;
  return (adoption?.fragments ?? []).map((fragment) => ({ file: path, ...fragment }));
}

function previewFile(gate: HostConfigGate, env: NodeJS.ProcessEnv, change: HostConfigFileChange): HostConfigPreviewItem[] {
  const path = resolveHostPath(hostConfigPaths(env), change.path);
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const plan = planFile(path, content, change.fragments, previewRecords(gate, env, change.path, path));
  return [
    ...plan.fragments.filter((fragment) => fragment.edit.removed !== fragment.edit.inserted)
      .map((fragment) => ({ path, selector: fragment.selector, action: plannedAction(fragment) })),
    ...plan.skipped.map((skip) => ({ path, selector: skip.selector, action: skip.code })),
  ];
}

/**
 * The host-config items that the install would write or skip, from the same
 * requests and the same planner as the apply. It reads the ledger as the
 * schema move would leave it and writes nothing. A target that cannot be
 * planned is listed with the reason, never with a guessed value.
 */
export function previewHostConfig(spec: InstallTargetSpec | null, overrides: OverrideSelection, env: NodeJS.ProcessEnv): HostConfigPreview {
  const gate = openHostConfigGate({ env, preview: true });
  const items: HostConfigPreviewItem[] = [];
  const unplanned: { target: TargetId; reason: string }[] = [];
  for (const { target, changes } of targetChanges(spec, overrides)) {
    try {
      const built = changes();
      if (built === null) unplanned.push({ target: target.id, reason: 'its host-config writer lists no items yet' });
      else items.push(...built.flatMap((change) => previewFile(gate, env, change)));
    } catch (error) {
      unplanned.push({ target: target.id, reason: (error as Error).message });
    }
  }
  return { items, unplanned };
}

export function formatHostConfigPreview(preview: HostConfigPreview): string[] {
  return [
    ...preview.items.map((item) => `[host-config] ${item.action}: ${formatOverride(item)}`),
    ...preview.unplanned.map((entry) => `[host-config] not planned for ${entry.target}: ${entry.reason}`),
  ];
}

export function runUninstall(opts: UninstallCommandOptions): InstallCommandResult {
  if (opts.location !== 'global') {
    return { exitCode: 2, lines: [`rh uninstall: invalid --location "${opts.location}" (expected: global)`] };
  }
  return runUserUninstall(opts);
}
