import { createHash } from 'crypto';
import { lstatSync, readlinkSync } from 'fs';
import { join } from 'path';
import { byteCompare } from '../../core/evidence/byte-compare';
import { canonicalize } from '../../core/evidence/canonical-json';
import { sha256Prefixed } from '../../core/evidence/sha256';
import { gitExecFileSync } from '../git/runner';
import { assertObservationPath, observationReadFileSync as readFileSync } from '../readonly-observation';

// Raised from 4 MiB: a diff that overflows this cap can no longer be observed,
// so instead of collapsing distinct contents to one fixed hash we mark the
// fingerprint degraded and fail closed (status: unknown).
export const PATCH_HASH_MAX_BUFFER = 64 * 1024 * 1024;

// Accumulates whether any git observation failed during a single fingerprint
// computation. A degraded computation must fail closed (status: unknown) so the
// Done gate never accepts a review against a diff it could not fully read.
export interface FingerprintCtx {
  degraded: boolean;
}

export interface GitTextResult {
  readonly ok: boolean;
  readonly text: string;
}

export interface GitBufferResult {
  readonly ok: boolean;
  readonly buf: Buffer;
}

// Returns ok:false on any git failure (non-zero exit, maxBuffer overflow, git
// missing) so callers can distinguish a legitimately empty result from an
// unobservable one. The previous helper returned '' for both, which let command
// failures masquerade as clean state.
// --literal-pathspecs: every path handed back to git here was discovered from
// git's own `-z` output, so it must be matched verbatim. Without this flag a
// filename that looks like pathspec magic (a leading `:`, e.g. `:(icase)x`) is
// re-interpreted as a pattern, silently matching a different file or nothing and
// dropping its content from the fingerprint.
export function gitRun(repoRoot: string, args: readonly string[], maxBuffer = PATCH_HASH_MAX_BUFFER): GitTextResult {
  try {
    const text = gitExecFileSync(['-C', repoRoot, '--literal-pathspecs', ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer,
    });
    return { ok: true, text };
  } catch {
    return { ok: false, text: '' };
  }
}

// Byte-exact variant for NUL-delimited (`-z`) output so non-ASCII, quoted, or
// whitespace-bearing pathnames survive verbatim instead of being mangled by
// line/space splitting.
export function gitRunBuffer(repoRoot: string, args: readonly string[], maxBuffer = PATCH_HASH_MAX_BUFFER): GitBufferResult {
  try {
    const out = gitExecFileSync(['-C', repoRoot, '--literal-pathspecs', ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer,
    });
    return { ok: true, buf: Buffer.isBuffer(out) ? out : Buffer.from(String(out)) };
  } catch {
    return { ok: false, buf: Buffer.alloc(0) };
  }
}

export function hashJson(value: unknown): string {
  return sha256Prefixed(canonicalize(value));
}

// Parse `git diff --name-status --find-renames -z`. Format is `<status>\0<path>`
// per entry; rename/copy entries are `<status>\0<old>\0<new>`.
export function parseNameStatusZ(tokens: readonly string[]): string[] {
  const paths: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index];
    index += 1;
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      const oldPath = tokens[index];
      const newPath = tokens[index + 1];
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
      index += 2;
    } else {
      const path = tokens[index];
      if (path) paths.push(path);
      index += 1;
    }
  }
  return Array.from(new Set(paths.filter(Boolean))).sort(byteCompare);
}

export function isOperationalReviewPath(path: string): boolean {
  return (
    /^tasks\/(?:contracts|reviews|notes|archive)\//.test(path) ||
    path === '.ai/harness/active-worktree' ||
    path === '.ai/harness/events.jsonl' ||
    path.startsWith('.ai/harness/capability-context/') ||
    path.startsWith('.ai/harness/architecture-projection/') ||
    path.startsWith('.ai/harness/checks/') ||
    path.startsWith('.ai/harness/evidence/') ||
    path.startsWith('.ai/harness/failures/') ||
    path.startsWith('.ai/harness/planning/') ||
    path.startsWith('.ai/harness/runs/') ||
    path.startsWith('.ai/harness/state/') ||
    path === 'evals/harness/reports/profile-comparison.json' ||
    path === 'evals/harness/reports/profile-comparison.md' ||
    path === 'evals/harness/reports/profile-comparison.sha256.json' ||
    path === '.claude/.active-plan'
  );
}

export function normalizedFinalContent(
  repoRoot: string,
  paths: readonly string[],
  ctx: FingerprintCtx,
): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const path of paths) {
    const absolute = join(repoRoot, path);
    assertObservationPath(absolute);
    try {
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        entries.push({
          path,
          type: 'symlink',
          mode: '120000',
          target_hex: readlinkSync(absolute, { encoding: 'buffer' }).toString('hex'),
        });
      } else if (stat.isFile()) {
        entries.push({
          path,
          type: 'file',
          mode: (stat.mode & 0o111) !== 0 ? '100755' : '100644',
          sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
        });
      } else if (stat.isDirectory()) {
        const stage = gitRun(repoRoot, ['ls-files', '--stage', '--', path]);
        const match = stage.ok ? stage.text.match(/^160000 ([0-9a-f]{40,64}) [0-3]\t/) : null;
        if (match) entries.push({ path, type: 'gitlink', mode: '160000', oid: match[1] });
        else {
          ctx.degraded = true;
          entries.push({ path, type: 'unsupported' });
        }
      } else {
        ctx.degraded = true;
        entries.push({ path, type: 'unsupported' });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        entries.push({ path, type: 'deleted' });
      } else {
        ctx.degraded = true;
        entries.push({ path, type: 'unreadable' });
      }
    }
  }
  return entries;
}
