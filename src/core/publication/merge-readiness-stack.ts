export const STACK_STATUSES = [
  'not_member', 'complete', 'depth_exceeded', 'cycle', 'base_pr_missing', 'base_pr_not_open', 'foreign_pr', 'unobserved',
] as const;

type ObservedStackStatus = (typeof STACK_STATUSES)[number];

type StackFailureBlockerCode =
  | 'stack_depth_exceeded'
  | 'stack_cycle'
  | 'stack_base_pr_missing'
  | 'stack_base_pr_not_open'
  | 'stack_foreign_pr';

interface ObservedStackEntry {
  readonly pr_number: number;
  readonly head_ref: string;
  readonly head_sha: string;
  readonly base_ref: string;
  readonly base_sha: string;
}

interface ObservedStackDetail {
  readonly member: boolean;
  readonly depth: number;
  readonly chain: readonly ObservedStackEntry[];
  readonly final_base_sha: string | null;
  readonly status: ObservedStackStatus;
}

/** Each observed chain failure keeps its own typed blocker. */
export const STACK_FAILURE_BLOCKERS: Partial<Record<ObservedStackStatus, StackFailureBlockerCode>> = {
  depth_exceeded: 'stack_depth_exceeded',
  cycle: 'stack_cycle',
  base_pr_missing: 'stack_base_pr_missing',
  base_pr_not_open: 'stack_base_pr_not_open',
  foreign_pr: 'stack_foreign_pr',
};

export function validSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) && value !== '0'.repeat(40);
}

function stackEntry(value: unknown): ObservedStackEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (!Number.isSafeInteger(entry.pr_number) || Number(entry.pr_number) < 1
    || typeof entry.head_ref !== 'string' || entry.head_ref.trim() === '' || !validSha(entry.head_sha)
    || typeof entry.base_ref !== 'string' || entry.base_ref.trim() === '' || !validSha(entry.base_sha)) return null;
  return Object.freeze({
    pr_number: Number(entry.pr_number), head_ref: entry.head_ref, head_sha: entry.head_sha,
    base_ref: entry.base_ref, base_sha: entry.base_sha,
  });
}

/**
 * The projection accepts chain bytes only as observed evidence. It re-binds the
 * first link to the expected head/base, requires every link to name the next
 * base branch, and rejects a member whose chain does not prove its base edge.
 * A member still cannot become ready, even when the whole chain is valid.
 */
export function observedStack(
  value: unknown,
  expectedHeadSha: string,
  expectedBaseSha: string,
): ObservedStackDetail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const detail = value as Record<string, unknown>;
  const status = detail.status as ObservedStackStatus;
  if (!STACK_STATUSES.includes(status) || typeof detail.member !== 'boolean'
    || !Number.isSafeInteger(detail.depth) || Number(detail.depth) < 0 || !Array.isArray(detail.chain)
    || (detail.final_base_sha !== null && !validSha(detail.final_base_sha))) return null;
  const chain: ObservedStackEntry[] = [];
  for (const raw of detail.chain) {
    const entry = stackEntry(raw);
    if (entry === null) return null;
    chain.push(entry);
  }
  const depth = Number(detail.depth);
  const finalBaseSha = detail.final_base_sha as string | null;
  if (!detail.member) {
    if ((status !== 'not_member' && status !== 'unobserved') || depth !== 0 || chain.length !== 0 || finalBaseSha !== null) return null;
    return Object.freeze({ member: false, depth: 0, chain: Object.freeze([]), final_base_sha: null, status });
  }
  if (status === 'not_member' || chain.length === 0 || depth !== chain.length - 1) return null;
  if (chain[0]!.head_sha !== expectedHeadSha || chain[0]!.base_sha !== expectedBaseSha) return null;
  const numbers = new Set<number>();
  const refs = new Set<string>();
  for (const entry of chain) {
    if (numbers.has(entry.pr_number) || refs.has(entry.head_ref)) return null;
    numbers.add(entry.pr_number);
    refs.add(entry.head_ref);
  }
  for (let index = 0; index + 1 < chain.length; index++) {
    if (chain[index]!.base_ref !== chain[index + 1]!.head_ref) return null;
  }
  if (status === 'complete') {
    if (depth < 1 || finalBaseSha === null || finalBaseSha !== chain[chain.length - 1]!.base_sha) return null;
  } else if (finalBaseSha !== null) return null;
  return Object.freeze({ member: true, depth, chain: Object.freeze(chain), final_base_sha: finalBaseSha, status });
}
