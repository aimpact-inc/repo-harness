export class BoardSourceError extends Error {
  constructor(message: string) {
    super(`board source invalid: ${message}`);
    this.name = 'BoardSourceError';
  }
}

export interface BoardCommentV1 {
  readonly url: string;
  readonly created_at: string;
  readonly author_association: string;
  readonly body: string;
}

/** The newest comments of a thread. `truncated` is true when older comments exist that the read did not return. */
export interface BoardCommentPageV1 {
  readonly truncated: boolean;
  readonly comments: readonly BoardCommentV1[];
}

/** Only an account with write access holds a seat (`board.md`, Claims); other protocol comments are requests. */
export const WRITE_ACCESS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** The comments of one protocol kind from accounts with write access. */
export function protocolComments(page: BoardCommentPageV1, header: string): BoardCommentV1[] {
  return page.comments.filter(comment => WRITE_ACCESS.has(comment.author_association)
    && comment.body.replace(/\r\n/gu, '\n').split('\n', 1)[0]!.trim() === header);
}

/** The newest comment of one protocol kind from an account with write access. */
export function newestProtocolComment(page: BoardCommentPageV1, header: string): BoardCommentV1 | null {
  return protocolComments(page, header).reduce<BoardCommentV1 | null>((newest, comment) => (newest === null || comment.created_at >= newest.created_at ? comment : newest), null);
}

export function field(body: string, name: string): string | null {
  const line = body.replace(/\r\n/gu, '\n').split('\n').find(entry => entry.startsWith(`${name}: `));
  return line === undefined ? null : line.slice(name.length + 2).trim();
}

/** The `Claim:` URL that an `issue claim status` comment names; null when it names none. */
export function claimStatusTarget(comment: BoardCommentV1): string | null {
  const value = field(comment.body, 'Claim');
  return value === null || value === '' ? null : value;
}

const CLAIM_HEADER = 'repo-harness issue claim';
const CLAIM_STATUS_HEADER = 'repo-harness issue claim status';
/** The first line of a boundary question to the coordinator (`templates.md`); `openQuestions` reads it. */
export const BOUNDARY_QUESTION_HEADER = 'repo-harness boundary question';

/** The claim URLs that an `issue claim status` with `done` or `released` closes. A status closes only the claim it names, even if it arrives late. */
export function closedClaimUrls(page: BoardCommentPageV1): Set<string | null> {
  return new Set(protocolComments(page, CLAIM_STATUS_HEADER).filter((comment) => {
    const status = parseClaimStatus(comment)?.status;
    return status === 'done' || status?.startsWith('released');
  }).map(claimStatusTarget));
}

export type IssueClaimV1 =
  /**
   * `bundle`: the issues of an `Issues:` line, the claim's own issue among them, when one writer and one pull request hold several
   * issues (`rh board dispatch --issues`); null for a claim of one issue. `branch`: the `Branch:` line, null when the claim has none.
   */
  | { readonly status: 'active'; readonly url: string; readonly created_at: string; readonly role: string | null; readonly bundle: readonly number[] | null; readonly branch: string | null }
  | { readonly status: 'none' }
  /** Older comments exist that the read did not return, and the newest ones hold no claim; or the newest claim has an `Issues:` line that does not parse or does not name its own issue. */
  | { readonly status: 'unknown' };

/** The `Issues:` line of a bundle claim: `#a, #b, #c`, two or more distinct issues. */
const BUNDLE_LINE = /^#[1-9][0-9]*(?:, #[1-9][0-9]*)+$/u;

/** The `Issues:` line of a bundle claim; `rh board dispatch --issues` writes it and `bundleOf` reads it. */
export function renderBundleLine(issues: readonly number[]): string {
  return `Issues: ${issues.map(number => `#${number}`).join(', ')}`;
}

/** The issues of a claim's `Issues:` line; null when the claim has no such line, `invalid` when the line does not parse or omits the claim's own issue. */
function bundleOf(body: string, issue: number | null): readonly number[] | null | 'invalid' {
  const line = field(body, 'Issues');
  if (line === null) return null;
  if (!BUNDLE_LINE.test(line)) return 'invalid';
  const issues = line.split(', ').map(entry => Number(entry.slice(1)));
  return new Set(issues).size === issues.length && (issue === null || issues.includes(issue)) ? Object.freeze(issues) : 'invalid';
}

/**
 * The one decision of an active claim, for dispatch and for the board: the newest `issue claim` that no `done` or `released` status closes.
 * A claim whose `Issues:` line does not parse or omits `issue` is `unknown`: no reader can tell which issues it holds. `issue` is null for a parent thread.
 */
export function issueClaim(page: BoardCommentPageV1, issue: number | null): IssueClaimV1 {
  const claim = newestProtocolComment(page, CLAIM_HEADER);
  if (claim === null) return page.truncated ? { status: 'unknown' } : { status: 'none' };
  if (closedClaimUrls(page).has(claim.url)) return { status: 'none' };
  const bundle = bundleOf(claim.body, issue);
  if (bundle === 'invalid') return { status: 'unknown' };
  return { status: 'active', url: claim.url, created_at: claim.created_at, role: field(claim.body, 'Role'), bundle, branch: field(claim.body, 'Branch') };
}

/** The fields of one `boundary question` comment. `rh board post question` renders them. */
export interface BoundaryQuestionCommentFieldsV1 {
  /** The only addressee that `openQuestions` reads: the coordinator. */
  readonly to: 'coordinator';
  /** The comment URL of the writer's claim. */
  readonly claim: string;
  readonly blocker: string;
  readonly evidence: string;
  /** The choices, in the `A ... | B ...` form of `templates.md`. */
  readonly options: string;
  /** What the writer does not do until the answer arrives. */
  readonly holding: string;
}

/** One `boundary question` comment: the header, then the six field lines. */
export function renderBoundaryQuestionComment(fields: BoundaryQuestionCommentFieldsV1): string {
  return [
    BOUNDARY_QUESTION_HEADER,
    `To: ${fields.to}`,
    `Claim: ${fields.claim}`,
    `Blocker: ${fields.blocker}`,
    `Evidence: ${fields.evidence}`,
    `Options: ${fields.options}`,
    `Holding: ${fields.holding}`,
  ].join('\n');
}

export type OpenQuestionsV1 =
  | { readonly status: 'observed'; readonly questions: readonly { readonly url: string; readonly created_at: string }[] }
  /** Older comments exist that the read did not return. */
  | { readonly status: 'unknown' };

/**
 * The `boundary question` comments to the coordinator (`templates.md`) with no answer: no later comment of the thread has a `Re:`
 * line that names the question. One `Re:` line can answer several questions. URLs compare by comment id, so a `pull` and an `issues`
 * path of one comment match.
 */
export function openQuestions(page: BoardCommentPageV1): OpenQuestionsV1 {
  if (page.truncated) return { status: 'unknown' };
  const questions = protocolComments(page, BOUNDARY_QUESTION_HEADER).filter(comment => field(comment.body, 'To') === 'coordinator');
  const open = questions.filter((question) => {
    const id = commentId(question.url);
    return id === null || !page.comments.some(comment => comment !== question && comment.created_at >= question.created_at
      && (field(comment.body, 'Re') ?? '').split(/\s+/u).some(word => commentId(word) === id));
  });
  return { status: 'observed', questions: Object.freeze(open.map(question => Object.freeze({ url: question.url, created_at: question.created_at }))) };
}

export interface ClaimStatusV1 {
  readonly url: string;
  readonly created_at: string;
  /** The `Status:` value, for example `ready for review; claim remains active` or `done`. */
  readonly status: string;
  readonly pr: number | null;
  readonly head_sha: string | null;
}

/** An `issue claim status` comment (`templates.md`). A comment without a `Status:` line is not a status. */
export function parseClaimStatus(comment: BoardCommentV1): ClaimStatusV1 | null {
  const status = field(comment.body, 'Status');
  if (status === null || status === '') return null;
  const pr = /^#([1-9][0-9]*)(?:\s+head\s+([0-9a-f]{7,40}))?/u.exec(field(comment.body, 'PR') ?? '');
  return Object.freeze({
    url: comment.url,
    created_at: comment.created_at,
    status,
    pr: pr === null ? null : Number(pr[1]),
    head_sha: pr?.[2] ?? null,
  });
}

export interface AcceptanceRowV1 {
  readonly round: number;
  readonly subject_sha: string;
  readonly verdict: 'PASS' | 'FAIL';
  /** The review seat from the record's `Seat:` line or explicit Role cell (`gatekeeper` or `reviewer`); null when absent on legacy records. */
  readonly seat: 'gatekeeper' | 'reviewer' | null;
  /** The review runtime that the Role cell starts with (`review publish` writes `<harness> (<model>), read-only`); null when the cell names no known runtime. */
  readonly harness: 'claude' | 'codex' | 'pi' | null;
  /** The model in the Role cell's parentheses; null when the cell names none or `unobserved`. */
  readonly model: string | null;
  /** The issue comment id of the record's `Claim:` URL, which identifies one review; null when the line is missing or is not a comment URL. */
  readonly claim: string | null;
  /** True only when the record's `Model relation:` line is `different-family`: the reviewer's recorded `modelRelation` verdict against the writer. */
  readonly different_family: boolean;
}

// The subject cell holds the SHA bare or in paired backticks (the receipt tool and the round-4 records differ).
const RECORD_TABLE_ROW = /^\|\s*([1-9][0-9]*)\b[^|]*\|([^|]*)\|\s*(`?)([0-9a-f]{40})\3\s*\|\s*(PASS|FAIL)\b/u;

const COMMENT_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:pull|issues)\/[1-9][0-9]*#issuecomment-([1-9][0-9]*)$/u;

/** The id of a GitHub issue comment URL: the one identity of a comment, whatever its `pull` or `issues` path. Null for any other text. */
export function commentId(url: string): string | null {
  return COMMENT_URL.exec(url)?.[1] ?? null;
}

/**
 * The rows of an `acceptance record` comment: the table rows that `review
 * publish` writes. Null when the record has no table row, carries an invalid
 * `Seat:` line, or carries conflicting `Seat:` and Role-cell seat labels; the
 * caller reports `acceptance_record_unparsed` and does not guess a verdict.
 */
export function parseAcceptanceRecord(comment: BoardCommentV1): readonly AcceptanceRowV1[] | null {
  const rawSeat = field(comment.body, 'Seat');
  if (rawSeat !== null && rawSeat !== 'gatekeeper' && rawSeat !== 'reviewer') return null;
  const rows: AcceptanceRowV1[] = [];
  const claim = commentId(field(comment.body, 'Claim') ?? '');
  const different_family = field(comment.body, 'Model relation') === 'different-family';
  for (const line of comment.body.replace(/\r\n/gu, '\n').split('\n')) {
    const table = RECORD_TABLE_ROW.exec(line);
    if (table) {
      const roleCell = table[2]!;
      const roleSeat = /^\s*(gatekeeper|reviewer)\b/u.exec(roleCell)?.[1] as 'gatekeeper' | 'reviewer' | undefined;
      if (rawSeat !== null && roleSeat !== undefined && rawSeat !== roleSeat) return null;
      const seat: AcceptanceRowV1['seat'] = (rawSeat as 'gatekeeper' | 'reviewer' | null) ?? roleSeat ?? null;
      const role = /^\s*(?:(claude|codex|pi)|(?:gatekeeper|reviewer))\b(?: \(([^)]*)\))?/u.exec(roleCell);
      const model = role?.[2]?.trim() ?? '';
      rows.push(Object.freeze({
        round: Number(table[1]),
        subject_sha: table[4]!,
        verdict: table[5] as 'PASS' | 'FAIL',
        seat,
        harness: (role?.[1] as AcceptanceRowV1['harness']) ?? null,
        model: model === '' || model === 'unobserved' ? null : model,
        claim,
        different_family,
      }));
    }
  }
  return rows.length === 0 ? null : Object.freeze(rows);
}

// A finding bullet of `review publish`: `- <severity> <id> at <path>:<line>: ...`, or `- P3 <id>: ...` for a NIT.
const RECORD_FINDING = /^- P[0-3] ([^\s:]+)(?: at |: )/u;

/**
 * The finding IDs of an `acceptance record`, from the lines after its `Findings:` line. Every non-empty line must be a finding bullet
 * of the `review publish` shape. A missing section, no line, or any other line (another bullet marker, indentation, a continuation)
 * returns null: a finding that cannot be read cannot be named by a disposition, so the record stays unresolvable.
 */
export function parseRecordFindings(comment: BoardCommentV1): readonly string[] | null {
  const lines = comment.body.replace(/\r\n/gu, '\n').split('\n');
  const start = lines.findIndex(line => line.trim() === 'Findings:');
  if (start < 0) return null;
  const ids = lines.slice(start + 1).filter(line => line.trim() !== '').map(line => RECORD_FINDING.exec(line)?.[1]);
  return ids.length === 0 || ids.some(id => id === undefined) ? null : Object.freeze(ids as string[]);
}

export interface AcceptanceDispositionV1 {
  /** The comment id of the FAIL record that the disposition names. */
  readonly record: string;
  readonly subject_sha: string;
  readonly findings: readonly string[];
}

/** The first line of an acceptance disposition on a pull request (`templates.md`); `parseAcceptanceDisposition` reads it. */
export const ACCEPTANCE_DISPOSITION_HEADER = 'repo-harness acceptance disposition';

/** The fields of one `acceptance disposition` comment. `rh board post disposition` renders them. */
export interface AcceptanceDispositionCommentFieldsV1 {
  /** The comment URL of the FAIL acceptance record. */
  readonly record: string;
  /** The 40-hex subject SHA of the FAIL row. */
  readonly subject: string;
  readonly findings: readonly string[];
  /** The comment URL of the decision that resolves the findings. */
  readonly decision: string;
}

/** One `acceptance disposition` comment: the header, then the four field lines. */
export function renderAcceptanceDispositionComment(fields: AcceptanceDispositionCommentFieldsV1): string {
  return [
    ACCEPTANCE_DISPOSITION_HEADER,
    `Record: ${fields.record}`,
    `Subject: ${fields.subject}`,
    `Findings: ${fields.findings.join(', ')}`,
    `Decision: ${fields.decision}`,
  ].join('\n');
}

/**
 * An `acceptance disposition` comment (`templates.md`): the coordinator resolves named findings of one FAIL record at one subject
 * with a recorded decision. Null unless `Record:` and `Decision:` are comment URLs, `Subject:` is a full SHA and `Findings:` lists IDs.
 */
export function parseAcceptanceDisposition(comment: BoardCommentV1): AcceptanceDispositionV1 | null {
  const record = commentId(field(comment.body, 'Record') ?? '');
  const decision = commentId(field(comment.body, 'Decision') ?? '');
  const subject = /^[0-9a-f]{40}$/u.exec(field(comment.body, 'Subject') ?? '')?.[0];
  const findings = (field(comment.body, 'Findings') ?? '').split(',').map(id => id.trim()).filter(id => id !== '');
  if (record === null || decision === null || subject === undefined || findings.length === 0) return null;
  return Object.freeze({ record, subject_sha: subject, findings: Object.freeze(findings) });
}
