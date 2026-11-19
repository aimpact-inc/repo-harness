import { acceptanceReviewRound, type ReviewPublishSeverity } from '../review/review-publish';

type Severity = ReviewPublishSeverity;
type Check = 'architecture' | 'type' | 'check' | 'test';
type Fix = { state: 'confirmed'; sha: string } | { state: 'claimed' } | { state: 'none' };

interface Location {
  readonly path: string | null;
  readonly line: number | null;
}

type Marker = { theme_key: string; check: Check } & (
  { finding_id: string } | { path: string; line: number }
);

export interface RuleObservation extends Location {
  readonly theme_key: string | null;
  readonly pull_request: number;
  readonly finding_id: string | null;
  readonly severity: Severity | null;
  readonly source: 'review_thread' | 'review_body' | 'pr_body' | 'bot';
  readonly check: Check | null;
  readonly fix: Fix;
}

type ReviewFinding = RuleObservation & { readonly finding_id: string };

export interface RuleProposal {
  readonly theme_key: string;
  readonly pull_requests: readonly number[];
  readonly in_ledger: boolean;
}

export interface RuleReviewThread extends Location {
  readonly body: string;
  readonly bot: boolean;
  readonly replies: readonly string[];
}

export interface RuleProposalPull {
  readonly number: number;
  readonly body: string;
  readonly reviews: readonly string[];
  readonly threads: readonly RuleReviewThread[];
}

export interface RuleProposalFilters {
  readonly includeLow?: boolean;
  readonly includeBot?: boolean;
}

export interface RuleProposalReport {
  readonly experimental: true;
  readonly range: { from: string; to: string; pull_requests: number };
  readonly truncated: { unread_from: string } | null;
  readonly malformed: number;
  readonly observations: readonly RuleObservation[];
  readonly proposals: readonly RuleProposal[];
}

/** Undefined is ordinary prose. Null is a marker with an invalid field. */
export function parseRuleOpportunity(line: string, context: 'review_body' | 'pr_body'): Marker | null | undefined {
  const text = line.trim();
  if (!text.startsWith('Rule-opportunity:')) return undefined;
  const match = /^Rule-opportunity: ([a-z0-9]+(?:-[a-z0-9]+)*) \| (finding|example): (.+?) \| check: (architecture|type|check|test) — \S.*$/u.exec(text);
  if (!match) return null;
  const [, theme_key, reference, value, check] = match;
  const marker = { theme_key, check: check as Check };
  if (context === 'review_body' && reference === 'finding' && value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value)) {
    return { ...marker, finding_id: value };
  }
  if (context !== 'pr_body' || reference !== 'example') return null;
  const location = /^(.+):([1-9]\d*)$/u.exec(value);
  if (!location) return null;
  const [, path, lineNumber] = location;
  const row = Number(lineNumber);
  if (!Number.isSafeInteger(row) || /[\\\x00-\x1f\x7f]|:\/\/|^[a-z]:\//iu.test(path)
    || path.split('/').some(part => part === '' || part === '.' || part === '..')) return null;
  return { ...marker, path, line: row };
}

const NO_FIX = { state: 'none' } as const;
const UNLOCATED = { path: null, line: null } as const;
const CONFIRMED = /^repo-harness review reply\r?\nAgent: [^\r\n]+, read-only\r?\nDisposition: confirmed fixed in round [1-9]\d* on ([0-9a-f]{40}|[0-9a-f]{64})\r?\nWhy: [^\r\n]+/u;
const CLAIMED = /\bfixed\s+(?:(?:in|by|at)\s+)?(?:commit\s+)?`?[0-9a-f]{7,64}\b/iu;

function threadFix(replies: readonly string[]): Fix {
  for (const reply of replies) {
    const confirmed = CONFIRMED.exec(reply);
    if (confirmed) return { state: 'confirmed', sha: confirmed[1] };
  }
  return replies.some(reply => CLAIMED.test(reply)) ? { state: 'claimed' } : NO_FIX;
}

function observation(pull_request: number, source: RuleObservation['source'], location: Location): RuleObservation {
  return { theme_key: null, pull_request, finding_id: null, severity: null, ...location, source, check: null, fix: NO_FIX };
}

function threadFinding(number: number, thread: RuleReviewThread, includeBot: boolean): RuleObservation | null {
  const heading = thread.body.split(/\r?\n/u, 1)[0];
  const location = { path: thread.path, line: thread.line };
  if (thread.bot) {
    if (!includeBot) return null;
    const badge = /!\[(P[0-3]) Badge\]/u.exec(heading);
    return { ...observation(number, 'bot', location), severity: badge ? badge[1] as Severity : null, fix: threadFix(thread.replies) };
  }
  const finding = /^\*\*(P[0-2]) (.+)\*\*$/u.exec(heading);
  if (!finding) return null;
  return { ...observation(number, 'review_thread', location), finding_id: finding[2], severity: finding[1] as Severity, fix: threadFix(thread.replies) };
}

/** The publisher emits only P3 under NITs. Outside-diff rows carry their severity and location. */
function reviewFindings(number: number, body: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  let section = '';
  for (const line of body.split(/\r?\n/u)) {
    if (line.startsWith('## ')) section = line;
    if (section === '## NITs') {
      const nit = /^- (.+?): \S/u.exec(line);
      if (nit) findings.push({ ...observation(number, 'review_body', UNLOCATED), finding_id: nit[1], severity: 'P3' });
    } else if (section === '## Findings outside the diff') {
      const finding = /^- (P[0-2]) (.+?) at (.+?):([1-9]\d*): \S/u.exec(line);
      if (finding) {
        findings.push({ ...observation(number, 'review_body', { path: finding[3], line: Number(finding[4]) }),
          finding_id: finding[2], severity: finding[1] as Severity });
      }
    }
  }
  return findings;
}

export function observeRuleProposals(pull: RuleProposalPull, filters: RuleProposalFilters = {}): {
  observations: RuleObservation[];
  malformed: number;
} {
  const byFinding = new Map<string, RuleObservation>();
  const extra: RuleObservation[] = [];
  let malformed = 0;
  const reviews = pull.reviews.filter(body => acceptanceReviewRound(body.replace(/\r\n/gu, '\n')) !== null);
  for (const thread of pull.threads) {
    const finding = threadFinding(pull.number, thread, filters.includeBot === true);
    if (!finding) continue;
    if (finding.finding_id === null) {
      extra.push(finding);
    } else {
      const previous = byFinding.get(finding.finding_id);
      if (!previous) byFinding.set(finding.finding_id, finding);
      else if (finding.fix.state === 'confirmed' || (finding.fix.state === 'claimed' && previous.fix.state === 'none')) {
        byFinding.set(finding.finding_id, { ...previous, fix: finding.fix });
      }
    }
  }
  for (const body of reviews) {
    for (const finding of reviewFindings(pull.number, body)) {
      if (!byFinding.has(finding.finding_id)) byFinding.set(finding.finding_id, finding);
    }
  }
  const readMarkers = (body: string, source: 'pr_body' | 'review_body') => {
    for (const line of body.split(/\r?\n/u)) {
      const marker = parseRuleOpportunity(line, source);
      if (marker === undefined) continue;
      if (marker === null) {
        malformed += 1;
        continue;
      }
      const { theme_key, check } = marker;
      if ('finding_id' in marker) {
        const { finding_id } = marker;
        const finding = byFinding.get(finding_id) ?? { ...observation(pull.number, source, UNLOCATED), finding_id };
        if (finding.theme_key === null) byFinding.set(finding_id, { ...finding, theme_key, check });
      } else {
        extra.push({ ...observation(pull.number, source, { path: marker.path, line: marker.line }), theme_key, check });
      }
    }
  };
  for (const body of reviews) readMarkers(body, 'review_body');
  readMarkers(pull.body, 'pr_body');
  const findings = [...byFinding.values()].filter(row => row.theme_key !== null || filters.includeLow || row.severity === 'P0' || row.severity === 'P1');
  return { observations: [...findings, ...extra], malformed };
}

export function groupRuleProposals(observations: readonly RuleObservation[], ledgerThemes: ReadonlySet<string>): RuleProposal[] {
  const byTheme = new Map<string, Set<number>>();
  for (const row of observations) {
    if (row.theme_key === null) continue;
    let pulls = byTheme.get(row.theme_key);
    if (!pulls) byTheme.set(row.theme_key, pulls = new Set());
    pulls.add(row.pull_request);
  }
  return [...byTheme]
    .filter(([, pulls]) => pulls.size >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([theme_key, pulls]) => ({ theme_key, pull_requests: [...pulls].sort((a, b) => a - b), in_ledger: ledgerThemes.has(theme_key) }));
}

export function describeRuleProposals(report: RuleProposalReport): string[] {
  const { from, to, pull_requests } = report.range;
  return [
    `Experimental rule proposals ${from}..${to}`,
    `PRs ${pull_requests} · observations ${report.observations.length} · proposals ${report.proposals.length} · malformed markers ${report.malformed}`,
    ...(report.truncated ? [`First unread commit ${report.truncated.unread_from}`] : []),
    ...report.proposals.map(row => `${row.theme_key} in ${row.pull_requests.map(number => `#${number}`).join(', ')}${row.in_ledger ? ' (in ledger)' : ''}`),
  ];
}
