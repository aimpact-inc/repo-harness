import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { sha256Prefixed } from '../../core/evidence/sha256';
import type { HostPath, Sha256 } from '../../core/host-config/types';
import { openRepositoryGate, resolveHostConfigRepository } from '../host-config/repository';
import { replaceTarget } from '../host-config/store';
import { globalRuntimeScope, withRuntimeTransactionContext, type RuntimeTransactionContext } from '../locking/runtime-transaction-lock';
import { hookFileRemovals, hookLocation, planLegacyLeftovers, removeLegacyHookCommands } from './legacy-inventory';

/**
 * The retired repo-local hook adapters in a repository's `.claude/settings.json`
 * and `.codex/hooks.json` (#2854). `rh init`, `rh upgrade --scope project`
 * and `rh upgrade --registered --apply` strip them here, after their own
 * transaction, so no copy of the user file lands in the working tree.
 */

/** A repository hook file with legacy rh hooks, and the file without them. */
export interface PlannedHookStrip {
  /** Relative to the worktree, with `/`. */
  readonly path: string;
  readonly expected: Sha256;
  readonly next: Buffer;
}

const PACKAGE_ROOT = resolve(import.meta.dir, '..', '..', '..');

/**
 * The legacy rh hooks of `.claude/settings.json` and `.codex/hooks.json` in
 * one worktree, by the legacy inventory and its text edits: the bytes outside
 * the removed commands stay. A file that the inventory reports stays out.
 */
export function planRepositoryHookStrips(worktree: string): PlannedHookStrip[] {
  const items = planLegacyLeftovers({ scope: 'project', cwd: worktree, home: worktree, packageRoot: PACKAGE_ROOT, installOwnership: () => () => null }).items;
  const strips: PlannedHookStrip[] = [];
  for (const path of new Set(items.filter((item) => item.action === 'strip-entry').map((item) => item.path))) {
    const bytes = readFileSync(path);
    const hookFile = hookFileRemovals(bytes, path, hookLocation('project', { home: worktree }));
    if ('refused' in hookFile || hookFile.removals.length === 0) continue;
    strips.push({ path: relative(resolve(worktree), path).split(sep).join('/'), expected: sha256Prefixed(bytes), next: Buffer.from(removeLegacyHookCommands(hookFile.content, hookFile.removals), 'utf8') });
  }
  return strips;
}

/**
 * Where a strip is recorded; the caller names it. `ledger`: the repository
 * ledger keeps the whole file before the strip, and `rh config restore --repo`
 * puts it back. `commit`: an rh-owned refresh worktree, whose commit and pull
 * request are the record (D7).
 */
export type HookStripRecord = 'ledger' | 'commit';

export interface HookStripOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly record: HookStripRecord;
  /** The global runtime lock that the caller already holds. */
  readonly runtimeLock?: RuntimeTransactionContext;
}

/** Strip the legacy rh hooks of one worktree; returns the paths that rh wrote, relative to the worktree. */
export function stripRepositoryHookFiles(worktree: string, options: HookStripOptions): string[] {
  const strips = planRepositoryHookStrips(worktree);
  if (!strips.length) return [];
  const repository = resolveHostConfigRepository(worktree);
  if (realpathSync.native(worktree) !== repository.worktree) throw new Error(`rh strips repository hook files only at the worktree root ${repository.worktree}: ${worktree}`);
  const target = (strip: PlannedHookStrip) => join(repository.worktree, strip.path);
  if (options.record === 'commit') {
    for (const strip of strips) replaceTarget(target(strip) as HostPath, strip.next, { existed: true, sha256: strip.expected });
    return strips.map((strip) => strip.path);
  }
  return withRuntimeTransactionContext(globalRuntimeScope(options.env), options.runtimeLock, () => {
    const written = openRepositoryGate(options.env, repository).writePaths(strips.map((strip) => ({
      path: target(strip), owner: 'core', replace: true, expected: strip.expected,
      entry: { type: 'file' as const, bytes: strip.next, mode: lstatSync(target(strip)).mode & 0o777 },
    })));
    return written.map((key) => relative(repository.worktree, key).split(sep).join('/'));
  });
}
