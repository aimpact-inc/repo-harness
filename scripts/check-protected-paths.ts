#!/usr/bin/env bun
/** Git is the authority: NUL-delimited paths, with rename detection disabled. */
import { execFileSync } from 'node:child_process';
import { REFACTOR_DECISION_DIRECTORY, REFACTOR_DECISION_FILE_PATTERN } from 'archctx-contracts';
import { protectedRepoDir, PROTECTED_REPO_DIRS } from '../src/cli/hook/mutation-protected-dirs';

const DECISION_GIT_MAX_BUFFER = 64 * 1024 * 1024;
const DECISION_DIR_PREFIX = `${REFACTOR_DECISION_DIRECTORY}/`;

function nonCanonicalDecisionPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (lower === REFACTOR_DECISION_DIRECTORY || lower.startsWith(DECISION_DIR_PREFIX))
    && !REFACTOR_DECISION_FILE_PATTERN.test(path);
}

export function checkProtectedPaths(args: readonly string[], cwd = process.cwd(), env = process.env): number {
  if (args.length > 1 || (args.length === 1 && !['--staged', '--tracked'].includes(args[0]!))) {
    process.stderr.write('Usage: rh run check-protected-paths [--staged|--tracked]\n');
    return 2;
  }
  const trackedMode = args[0] === '--tracked';
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const gitArgs = trackedMode
      ? ['--literal-pathspecs', 'ls-files', '--cached', '--full-name', '-z', '--', ...PROTECTED_REPO_DIRS]
      : ['--literal-pathspecs', '-c', 'diff.relative=false', 'diff', '--cached', '--name-only', '--no-renames', '-z', '--', ...PROTECTED_REPO_DIRS];
    const output = execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
    const paths = output.split('\0').filter(path => protectedRepoDir(path));

    const decisionArgs = trackedMode
      ? ['--literal-pathspecs', 'ls-files', '--cached', '--full-name', '-z']
      : ['--literal-pathspecs', '-c', 'diff.relative=false', 'diff', '--cached', '--diff-filter=d', '--name-only', '--no-renames', '-z'];
    const decisionOutput = execFileSync('git', decisionArgs, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      maxBuffer: DECISION_GIT_MAX_BUFFER,
    });
    const invalidDecisionPaths = decisionOutput.split('\0').filter(Boolean).filter(nonCanonicalDecisionPath);

    let failed = false;
    if (paths.length > 0) {
      if (env.REPO_HARNESS_ALLOW_PROTECTED_PATHS === '1') {
        process.stderr.write('[ProtectedGitPaths] Explicit override REPO_HARNESS_ALLOW_PROTECTED_PATHS=1 permits protected paths.\n');
      } else {
        process.stderr.write(`[ProtectedGitPaths] Refused ${trackedMode ? 'tracked' : 'staged'} paths:\n${paths.map(path => `- ${JSON.stringify(path)}`).join('\n')}\nKeep _ops/ and _ref/ private and ignored. Only a human-approved operation may set REPO_HARNESS_ALLOW_PROTECTED_PATHS=1 for this command.\n`);
        failed = true;
      }
    }
    if (invalidDecisionPaths.length > 0) {
      process.stderr.write(`[ProtectedGitPaths] Refused non-canonical refactor decision ${trackedMode ? 'tracked' : 'staged'} paths:\n${invalidDecisionPaths.map(path => `- ${JSON.stringify(path)}`).join('\n')}\nUse canonical lowercase filenames matching ${REFACTOR_DECISION_DIRECTORY}/recommendation.<16-lowercase-hex>.json.\n`);
      failed = true;
    }
    return failed ? 1 : 0;
  } catch {
    process.stderr.write('[ProtectedGitPaths] Git path inspection failed. No path clearance was established.\n');
    return 2;
  }
}

if (import.meta.main) process.exit(checkProtectedPaths(process.argv.slice(2)));
