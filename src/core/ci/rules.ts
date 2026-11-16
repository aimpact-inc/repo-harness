/**
 * The rule registry: one entry per rule with its stable id, its parameter
 * defaults and the repair hint that a failing check prints. The id has the same
 * spelling in `.ai/harness/policy.json` (`rules.<id>`) and in each result.
 */
export interface RuleEntry<Parameters> {
  readonly id: string;
  readonly parameters: Parameters;
  readonly repair: string;
}

export interface TestBudgetParameters {
  readonly ratio_cap: number;
  readonly file_cap: number;
  readonly test_paths: readonly string[];
  readonly product_paths: readonly string[];
}

export const RULES = {
  TestBudget: {
    id: 'TestBudget',
    parameters: { ratio_cap: 2, file_cap: 1, test_paths: ['tests'], product_paths: ['src', 'scripts'] },
    repair: 'Remove added test lines or test files, or add a "## Test budget exception" section to the PR body with the lines '
      + '"Added test lines: <n>", "Added product lines: <n>" and "Added test files: <n>" (the measured numbers) and the reason '
      + 'that no existing test can cover the behavior.',
  },
} as const satisfies { readonly TestBudget: RuleEntry<TestBudgetParameters> };
