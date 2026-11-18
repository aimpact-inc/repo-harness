/**
 * The `TestBudget` rule: the test lines and test files that a PR adds, measured
 * from the merge-base to the head, against the parameters of the base policy.
 * The rule is telemetry: it reports on the PR and never blocks a merge (#3181).
 * The result document is the contract of ADR-0004
 * (`docs/adr/ADR-0004-test-budget-result-contract.md`).
 */
import { canonicalize } from '../evidence/canonical-json';
import { sha256Prefixed } from '../evidence/sha256';
import {
  POLICY_ABSENT,
  WORKFLOW_POLICY_KEYS,
  isPolicyObject,
  policyValue,
  type DecodedWorkflowPolicy,
} from '../workflow/policy-schema';
import { RULES, type TestBudgetParameters } from './rules';

export const TEST_BUDGET_RESULT_SCHEMA = 'repo-harness/test-budget-result/v1';
/**
 * Bump when a change to this file can change a result for the same inputs. The
 * telemetry change of #3181 keeps 1: the 0.34.0 readiness reads any other value
 * as a stale result and blocks the merge.
 */
export const TEST_BUDGET_IMPLEMENTATION_VERSION = 1;

// The policy key tree is the one list of keys; a key that the tree lacks fails the type check here.
const CONFIG_KEYS: Readonly<Record<'enabled' | keyof TestBudgetParameters, true>> = WORKFLOW_POLICY_KEYS.rules.TestBudget;

/** A disabled rule may carry no parameters; an enabled rule carries all of them. */
export type TestBudgetConfig =
  | ({ readonly enabled: true } & TestBudgetParameters)
  | ({ readonly enabled: false } & Partial<TestBudgetParameters>);

export type TestBudgetConfigRead =
  | { readonly status: 'absent' }
  | { readonly status: 'present'; readonly config: TestBudgetConfig }
  | { readonly status: 'invalid'; readonly message: string };

/** A path prefix: repository-relative segments, no glob or regular expression. */
const PATH_PREFIX = /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)*$/;

function invalid(message: string): TestBudgetConfigRead {
  return { status: 'invalid', message };
}

type Checked<Value> = { readonly value: Value } | string;

function pathList(key: string) {
  return (value: unknown): Checked<readonly string[]> => {
    if (!Array.isArray(value) || value.length === 0) return `rules.TestBudget.${key} must be a non-empty array of path prefixes`;
    for (const entry of value) {
      if (typeof entry !== 'string' || !PATH_PREFIX.test(entry)) {
        return `rules.TestBudget.${key} has an invalid path prefix ${JSON.stringify(entry)}`;
      }
    }
    if (new Set(value).size !== value.length) return `rules.TestBudget.${key} has a duplicate path prefix`;
    return { value: value as string[] };
  };
}

const PARAMETER_CHECKS: { readonly [Key in keyof TestBudgetParameters]: (value: unknown) => Checked<TestBudgetParameters[Key]> } = {
  ratio_cap: (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0
    ? { value } : 'rules.TestBudget.ratio_cap must be a positive number'),
  file_cap: (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { value } : 'rules.TestBudget.file_cap must be a non-negative integer'),
  test_paths: pathList('test_paths'),
  product_paths: pathList('product_paths'),
};

/**
 * The rule configuration in a decoded policy. An absent `rules.TestBudget` is
 * "no configuration". A present one needs `enabled`. Each parameter it states
 * is checked; an enabled rule needs every parameter.
 */
export function readTestBudgetConfig(document: DecodedWorkflowPolicy): TestBudgetConfigRead {
  let value: unknown;
  try {
    value = policyValue(document, 'rules.TestBudget');
  } catch (error) {
    return invalid((error as Error).message);
  }
  if (value === POLICY_ABSENT) return { status: 'absent' };
  if (!isPolicyObject(value)) return invalid('rules.TestBudget must be an object');
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(CONFIG_KEYS, key)).sort();
  if (unknown.length > 0) return invalid(`rules.TestBudget has unknown fields: ${unknown.join(', ')}`);
  if (typeof value.enabled !== 'boolean') return invalid('rules.TestBudget.enabled must be true or false');
  const parameters: { -readonly [Key in keyof TestBudgetParameters]?: TestBudgetParameters[Key] } = {};
  for (const key of Object.keys(RULES.TestBudget.parameters) as (keyof TestBudgetParameters)[]) {
    if (!Object.hasOwn(value, key)) continue;
    const checked = PARAMETER_CHECKS[key](value[key]);
    if (typeof checked === 'string') return invalid(checked);
    Object.assign(parameters, { [key]: checked.value });
  }
  if (!value.enabled) return { status: 'present', config: { enabled: false, ...parameters } };
  const missing = Object.keys(RULES.TestBudget.parameters).filter((key) => !Object.hasOwn(parameters, key));
  if (missing.length > 0) return invalid(`rules.TestBudget is enabled without: ${missing.join(', ')}`);
  return { status: 'present', config: { enabled: true, ...(parameters as TestBudgetParameters) } };
}

/** The digest of the effective configuration; "no configuration" digests `null`. */
export function testBudgetPolicyDigest(read: Exclude<TestBudgetConfigRead, { status: 'invalid' }>): string {
  return sha256Prefixed(canonicalize(read.status === 'present' ? read.config : null));
}

/**
 * One path of `git diff -M <merge-base> <head>`. The endpoints decide the
 * status: a file deleted and created again between them is `modified`.
 * `added_lines` is null for a binary file.
 */
export interface TestBudgetDiffEntry {
  readonly status: 'added' | 'modified' | 'renamed' | 'deleted';
  readonly path: string;
  readonly previous_path: string | null;
  readonly added_lines: number | null;
}

export interface TestBudgetMeasured {
  readonly added_test_lines: number;
  readonly added_product_lines: number;
  readonly added_test_files: number;
  /** Test lines per product line, rounded to two decimals; null when no product line is added. */
  readonly ratio: number | null;
  readonly ratio_cap: number;
  readonly file_cap: number;
}

function under(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * A test path wins over a product path. A binary file adds no line. A test file
 * counts as added when it is new, or renamed from a path outside the test paths.
 */
function measureTestBudget(entries: readonly TestBudgetDiffEntry[], config: TestBudgetParameters): TestBudgetMeasured {
  let testLines = 0;
  let productLines = 0;
  let testFiles = 0;
  for (const entry of entries) {
    if (entry.status === 'deleted') continue;
    const lines = entry.added_lines ?? 0;
    if (under(entry.path, config.test_paths)) {
      testLines += lines;
      const movedIn = entry.status === 'renamed' && !under(entry.previous_path!, config.test_paths);
      if (entry.status === 'added' || movedIn) testFiles += 1;
    } else if (under(entry.path, config.product_paths)) {
      productLines += lines;
    }
  }
  return {
    added_test_lines: testLines,
    added_product_lines: productLines,
    added_test_files: testFiles,
    ratio: productLines === 0 ? null : Math.round((testLines / productLines) * 100) / 100,
    ratio_cap: config.ratio_cap,
    file_cap: config.file_cap,
  };
}

/** Over the line budget (any test line without a product line counts), or over the file cap. */
function overTestBudget(measured: TestBudgetMeasured): boolean {
  const linesOver = measured.added_product_lines === 0
    ? measured.added_test_lines > 0
    : measured.added_test_lines > measured.ratio_cap * measured.added_product_lines;
  return linesOver || measured.added_test_files > measured.file_cap;
}

export interface TestBudgetBound {
  readonly head_sha: string;
  readonly diff_start: string;
  readonly policy_digest: string;
  readonly implementation_version: number;
  /**
   * Always null. The merge readiness of repo-harness 0.34.0 compares this field
   * with the exception section of the live PR body, so the v1 document keeps it
   * until no released readiness reads it.
   */
  readonly exception_digest: null;
}

/**
 * The rule reports and never fails a check: over budget is `pass` with
 * `over_budget: true`. `measured` and `over_budget` are null for `skipped`
 * (nothing is measured) and for `error`. An `error` result keeps null for each
 * bound input that the rule could not compute.
 */
export type TestBudgetResult =
  | {
    readonly schema: typeof TEST_BUDGET_RESULT_SCHEMA;
    readonly state: 'pass';
    readonly bound: TestBudgetBound;
    readonly measured: TestBudgetMeasured;
    readonly over_budget: boolean;
    readonly error: null;
  }
  | {
    readonly schema: typeof TEST_BUDGET_RESULT_SCHEMA;
    readonly state: 'skipped';
    readonly bound: TestBudgetBound;
    readonly measured: null;
    readonly over_budget: null;
    readonly error: null;
  }
  | {
    readonly schema: typeof TEST_BUDGET_RESULT_SCHEMA;
    readonly state: 'error';
    readonly bound: { readonly [Key in keyof TestBudgetBound]: TestBudgetBound[Key] | null };
    readonly measured: null;
    readonly over_budget: null;
    readonly error: { readonly code: string; readonly message: string };
  };

/** A disabled rule is `skipped` and measures nothing. */
export function evaluateTestBudget(input: {
  readonly head_sha: string;
  readonly diff_start: string;
  readonly config: Exclude<TestBudgetConfigRead, { status: 'invalid' }>;
  readonly entries: readonly TestBudgetDiffEntry[];
}): TestBudgetResult {
  const bound: TestBudgetBound = {
    head_sha: input.head_sha,
    diff_start: input.diff_start,
    policy_digest: testBudgetPolicyDigest(input.config),
    implementation_version: TEST_BUDGET_IMPLEMENTATION_VERSION,
    exception_digest: null,
  };
  if (input.config.status === 'absent' || !input.config.config.enabled) {
    return { schema: TEST_BUDGET_RESULT_SCHEMA, state: 'skipped', bound, measured: null, over_budget: null, error: null };
  }
  const measured = measureTestBudget(input.entries, input.config.config);
  return { schema: TEST_BUDGET_RESULT_SCHEMA, state: 'pass', bound, measured, over_budget: overTestBudget(measured), error: null };
}

export function testBudgetError(
  bound: { readonly [Key in keyof TestBudgetBound]: TestBudgetBound[Key] | null },
  code: string,
  message: string,
): TestBudgetResult {
  return { schema: TEST_BUDGET_RESULT_SCHEMA, state: 'error', bound, measured: null, over_budget: null, error: { code, message } };
}

const NO_CONFIGURATION_DIGEST = testBudgetPolicyDigest({ status: 'absent' });

/** A `skipped` result binds the digest of `null` for no configuration and of the config for an explicit off. */
function skippedCause(result: Extract<TestBudgetResult, { state: 'skipped' }>): string {
  return result.bound.policy_digest === NO_CONFIGURATION_DIGEST
    ? 'no configuration: the base policy has no rules.TestBudget'
    : 'rule off: rules.TestBudget.enabled is false in the base policy';
}

/** A fenced block keeps any text literal; the fence is longer than each backtick run in the text. */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** The job summary (Markdown) of one result document; a projection of the document only. */
export function renderTestBudgetSummary(result: TestBudgetResult): string {
  if (result.state === 'error') {
    const title = result.error.code === 'policy_invalid' ? 'invalid configuration' : `error ${result.error.code}`;
    return `### TestBudget: not checked (${title})\n\nNothing is measured.\n\n${fenced(result.error.message)}\n`;
  }
  if (result.state === 'skipped') return `### TestBudget: skipped (${skippedCause(result)})\n\nNothing is measured.\n`;
  const { measured } = result;
  const ratio = measured.ratio === null ? 'none (no added product line)' : String(measured.ratio);
  return [
    `### TestBudget: ${result.over_budget ? 'over budget (report only)' : 'within budget'}`,
    '',
    '| | Added test lines | Added product lines | Added test files |',
    '| --- | --- | --- | --- |',
    `| Measured | ${measured.added_test_lines} | ${measured.added_product_lines} | ${measured.added_test_files} |`,
    '',
    `Ratio ${ratio}, cap ${measured.ratio_cap}. Test files cap ${measured.file_cap}. Head \`${result.bound.head_sha}\`, diff start \`${result.bound.diff_start}\`.`,
    '',
  ].join('\n');
}

/** Human lines for the job log. */
export function describeTestBudget(result: TestBudgetResult): string[] {
  if (result.state === 'error') return [`TestBudget error (${result.error.code}): ${result.error.message}`];
  if (result.state === 'skipped') return [`TestBudget skipped: ${skippedCause(result)}.`];
  const { measured } = result;
  return [`TestBudget ${result.over_budget ? 'over budget (report only)' : 'within budget'}: ${measured.added_test_lines} added test lines, `
    + `${measured.added_product_lines} added product lines, ${measured.added_test_files} added test files `
    + `(ratio cap ${measured.ratio_cap}, file cap ${measured.file_cap}).`];
}

/** A GitHub Actions workflow command for one `notice` annotation; the escapes keep it one command line. */
export function githubNoticeCommand(title: string, message: string): string {
  const data = (value: string) => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const property = (value: string) => data(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return `::notice title=${property(title)}::${data(message)}`;
}
