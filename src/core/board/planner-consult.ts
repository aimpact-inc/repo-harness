import { isAbsolute, join, relative, sep } from 'node:path';

export const PLANNER_CONSULT_KIND = 'repo-harness.seats.consult';
export const PLANNER_CONSULT_PROTOCOL = 1;

export class PlannerConsultError extends Error {
  constructor(readonly code: 'consult_path_inside_repo' | 'consult_path_unavailable' | 'consult_path_exists' | 'consult_runtime_unsupported' | 'consult_launch_invalid' | 'repository_id_required', message: string) {
    super(message);
  }
}

export function defaultConsultPlanPath(tmpDir: string, repoSlug: string, issue: number, qualifier?: string): string {
  const slug = repoSlug.replace(/[^a-zA-Z0-9._-]/gu, '-');
  const directory = slug === '' || slug === '.' || slug === '..' ? '_' : slug;
  return join(tmpDir, 'rh-plans', directory, `issue-${issue}${qualifier === undefined ? '' : `-${qualifier}`}.md`);
}

/** Compare paths in the same namespace. The caller also checks paths resolved by the filesystem. */
export function validateConsultOutPath(outPath: string, gitRoots: readonly string[]): void {
  for (const root of gitRoots) {
    const fromRoot = relative(root, outPath);
    if (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)) {
      throw new PlannerConsultError('consult_path_inside_repo', `The plan path ${outPath} is inside ${root}. Choose a path outside Git.`);
    }
  }
}

export function renderConsultTask(input: { issue: number; parent?: number; outPath: string; question?: string }): string {
  const destination = JSON.stringify(input.outPath);
  return [
    `Provide a read-only reference plan for issue #${input.issue}${input.parent === undefined ? '' : ` in parent #${input.parent}`}.`,
    `From the checkout, read the issue body with \`env -u GH_REPO gh issue view ${input.issue} --json title,body\` and all comments with \`env -u GH_REPO gh issue view ${input.issue} --comments\`. Inspect the relevant source files.`,
    ...(input.question === undefined ? [] : [`Focus the plan on this question: ${JSON.stringify(input.question)}`]),
    'Include these sections: Recommendation, Files and symbols, Implementation skeleton, Delete list, Forbidden additions, Acceptance and risks.',
    `Write the full plan only to ${destination}. Use Bash with noclobber (\`set -C\`) and quote the path as a literal. If the file already exists or the write fails, report the failure and stop.`,
    'Keep the checkout read-only. Do not change repository files, create worktrees, commit, push, post claims, write to GitHub, or read credentials.',
    `After the write succeeds, print only a short completion line that names ${destination}, then stop. Keep the plan out of terminal scrollback.`,
  ].join('\n');
}
