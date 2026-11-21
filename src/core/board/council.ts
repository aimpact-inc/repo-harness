import { resolveCatalogRoute, type TransportPreset } from './model-catalog';
import { AGY_SEAT_TOOLS, COUNCIL_TOOLS, SEAT_ALLOWED_FLEET, type SeatConfigV1, type SeatRuntime } from './seats-settings';

export const COUNCIL_KIND = 'repo-harness.seats.council';
export const COUNCIL_PROTOCOL = 1;
export const COUNCIL_MEMBER_IDS = ['fable', 'carbon', 'astra'] as const;
export type CouncilMemberId = typeof COUNCIL_MEMBER_IDS[number];

export type CouncilErrorCode =
  | 'council_members_invalid'
  | 'council_path_inside_repo'
  | 'council_path_unavailable'
  | 'council_path_exists'
  | 'council_runtime_unsupported'
  | 'council_launch_invalid'
  | 'repository_id_required';

export class CouncilError extends Error {
  constructor(readonly code: CouncilErrorCode, message: string) {
    super(message);
  }
}

/** Parse 1..3 distinct logical council members from `{fable, carbon, astra}` (ADR-0006 §4). */
export function parseCouncilMembers(raw: string): readonly CouncilMemberId[] {
  const parts = raw.split(',').map(part => part.trim());
  if (parts.length === 0 || parts.length > COUNCIL_MEMBER_IDS.length || parts.some(part => part === '')) {
    throw new CouncilError('council_members_invalid', `--members must list 1 to 3 distinct members from: ${COUNCIL_MEMBER_IDS.join(', ')}.`);
  }
  const seen = new Set<CouncilMemberId>();
  const members: CouncilMemberId[] = [];
  for (const part of parts) {
    if (!COUNCIL_MEMBER_IDS.includes(part as CouncilMemberId)) {
      throw new CouncilError('council_members_invalid', `Unknown council member ${JSON.stringify(part)}. Use only: ${COUNCIL_MEMBER_IDS.join(', ')}.`);
    }
    const member = part as CouncilMemberId;
    if (seen.has(member)) {
      throw new CouncilError('council_members_invalid', `Duplicate council member ${member}. Each member may appear at most once.`);
    }
    seen.add(member);
    members.push(member);
  }
  return members;
}

/** Resolve one council member's runtime, model, effort, tools, and fleet from `MODEL_CATALOG` for the active transport preset. */
export function resolveCouncilMemberConfig(
  member: CouncilMemberId,
  preset: TransportPreset,
  configuredCouncil: SeatConfigV1 | null,
): SeatConfigV1 {
  const resolved = resolveCatalogRoute(member, preset);
  if (resolved === null) {
    throw new CouncilError('council_runtime_unsupported', `Council member ${member} has no ${preset} route.`);
  }
  const isAgy = resolved.runtime === 'agy';
  return {
    runtime: resolved.runtime,
    model: resolved.model,
    advisor_model: null,
    effort: resolved.effort ?? null,
    tools: isAgy ? AGY_SEAT_TOOLS : (configuredCouncil?.tools ?? COUNCIL_TOOLS),
    fleet: isAgy ? [] : (configuredCouncil?.fleet ?? SEAT_ALLOWED_FLEET.council),
  };
}

export function defaultCouncilPlanPath(tmpDir: string, repoSlug: string, issue: number, member: CouncilMemberId, qualifier?: string): string {
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
      throw new CouncilError('council_path_inside_repo', `The council path ${outPath} is inside ${root}. Choose a path outside Git.`);
    }
  }
}

export function renderCouncilTask(input: {
  readonly issue: number;
  readonly member: CouncilMemberId;
  readonly runtime: SeatRuntime;
  readonly parent?: number;
  readonly outPath: string;
  readonly question?: string;
}): string {
  const outputInstruction = input.runtime === 'codex'
    ? `Your final response is written automatically to ${input.outPath} via codex -o. Return the full Markdown proposal as your final message.`
    : `Write your blind proposal only to ${input.outPath} via the shell (for example, cat <<'EOF' > ${input.outPath}). Do not edit repository files.`;
  return [
    `Convene council (member: ${input.member}) on issue #${input.issue}${input.parent === undefined ? '' : ` (parent #${input.parent})`}.`,
    ...(input.question === undefined ? [] : [`Focus question: ${input.question}`]),
    `Read the issue with \`gh issue view ${input.issue} --json title,body\` and \`gh issue view ${input.issue} --comments\`, then inspect the relevant code in this checkout.`,
    'Open with `RECOMMENDATION: <one sentence> — confidence: HIGH|MEDIUM|LOW`, followed by an implementation skeleton (affected files and interfaces), a delete list, a forbidden-additions list, and proof checks.',
    'Do not read other council members’ proposal files under /tmp/rh-council/.',
    `${outputInstruction} Do not change repository files, commit, push, or write to GitHub.`,
  ].join('\n');
}
