import type { SeatRuntime } from './seats-settings';

export const COUNCIL_CONSULT_KIND = 'repo-harness.seats.council';
export const COUNCIL_CONSULT_PROTOCOL = 1;

export const COUNCIL_MEMBERS = ['fable', 'carbon', 'astra'] as const;
export type CouncilMember = typeof COUNCIL_MEMBERS[number];

export type CouncilConsultErrorCode =
  | 'council_member_invalid'
  | 'council_path_inside_repo'
  | 'council_path_unavailable'
  | 'council_path_exists'
  | 'council_runtime_unsupported'
  | 'council_launch_invalid'
  | 'repository_id_required';

export class CouncilConsultError extends Error {
  constructor(readonly code: CouncilConsultErrorCode, message: string) {
    super(message);
  }
}

export function isCouncilMember(value: string): value is CouncilMember {
  return (COUNCIL_MEMBERS as readonly string[]).includes(value);
}

export function parseCouncilMembers(raw: string): readonly CouncilMember[] {
  const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > COUNCIL_MEMBERS.length) {
    throw new CouncilConsultError('council_member_invalid', `--members must name 1 to ${COUNCIL_MEMBERS.length} distinct members from: ${COUNCIL_MEMBERS.join(', ')}.`);
  }
  const seen = new Set<CouncilMember>();
  for (const part of parts) {
    if (!isCouncilMember(part)) {
      throw new CouncilConsultError('council_member_invalid', `Unknown council member ${JSON.stringify(part)}. Allowed council members: ${COUNCIL_MEMBERS.join(', ')}.`);
    }
    if (seen.has(part)) {
      throw new CouncilConsultError('council_member_invalid', `Duplicate council member ${JSON.stringify(part)}. List each member at most once.`);
    }
    seen.add(part);
  }
  return [...seen];
}

export function defaultCouncilPlanPath(tmpDir: string, repoSlug: string, issue: number, member: CouncilMember, qualifier?: string): string {
  const slug = repoSlug.replace(/[^a-zA-Z0-9._-]/gu, '-');
  const directory = slug === '' || slug === '.' || slug === '..' ? '_' : slug;
  const file = `issue-${issue}-${member}${qualifier === undefined ? '' : `-${qualifier}`}.md`;
  return `${tmpDir.replace(/\/+$/u, '')}/rh-council/${directory}/${file}`;
}

/** Compare absolute, normalized path strings with slash separators. */
export function validateCouncilOutPath(outPath: string, gitRoots: readonly string[]): void {
  for (const root of gitRoots) {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (outPath === root || outPath.startsWith(prefix)) {
      throw new CouncilConsultError('council_path_inside_repo', `The council output path ${outPath} is inside ${root}. Choose a path outside Git.`);
    }
  }
}

export function renderCouncilTask(input: { issue: number; parent?: number; member: CouncilMember; outPath: string; question?: string; runtime?: SeatRuntime }): string {
  const destination = JSON.stringify(input.outPath);
  const writeStep = input.runtime === 'codex'
    ? `Return the complete proposal as your final message; the host \`-o\` flag writes it directly to ${destination}. Do not attempt shell file writes.`
    : [
      `Write the full proposal only to ${destination}. Use Bash with noclobber (\`set -C\`) and quote the path as a literal. If the file already exists or the write fails, report the failure and stop.`,
      `After the write succeeds, print only a short completion line that names ${destination}, then stop. Keep the proposal out of terminal scrollback.`,
    ].join('\n');
  return [
    `Provide an independent read-only council proposal (${input.member}) for issue #${input.issue}${input.parent === undefined ? '' : ` in parent #${input.parent}`}.`,
    `From the checkout, read the issue body with \`env -u GH_REPO gh issue view ${input.issue} --json title,body\` and all comments with \`env -u GH_REPO gh issue view ${input.issue} --comments\`. Inspect the relevant source files.`,
    ...(input.question === undefined ? [] : [`Focus the proposal on this question: ${JSON.stringify(input.question)}`]),
    'Open with `RECOMMENDATION: <one sentence> — confidence: HIGH|MEDIUM|LOW`. Include these sections: Recommendation, Files and symbols, Implementation skeleton, Delete list, Forbidden additions, Acceptance and risks.',
    writeStep,
    'Keep the checkout read-only. Do not change repository files, create worktrees, commit, push, post claims, write to GitHub, message a worker, or read credentials.',
  ].join('\n');
}
