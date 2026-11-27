import { spawnSync } from 'child_process';
import type { RequiredCheckTestExecutionV1 } from '../../core/evidence/test-execution-evidence';
import { readTestExecutionEvidence } from './test-execution-evidence';

export type ReadinessErrorCode =
  | 'provider_unavailable'
  | 'provider_data_incomplete';

export type ReadinessFail = (
  code: ReadinessErrorCode,
  message: string,
  cause?: unknown,
  detail?: string,
) => never;

export interface ProviderTestExecutionRequest {
  readonly repository: string;
  readonly run_id: number;
  readonly attempt: number;
}

export interface ProviderTransportInput {
  readonly repo_root: string;
  readonly repository?: string;
  readonly gh_bin?: string;
  readonly gh_runner?: (args: readonly string[]) => { readonly status: number; readonly stdout: string; readonly stderr?: string };
  readonly test_execution_reader?: (request: ProviderTestExecutionRequest) => RequiredCheckTestExecutionV1;
  readonly fatal_read_error?: (error: unknown) => boolean;
}

export interface ProviderIdentityData {
  readonly provider_repo_id: string;
  readonly repo_name_with_owner: string;
  readonly pr_number: number;
  readonly pr_url: string;
  readonly state: string;
  readonly is_draft: boolean;
  readonly head_sha: string;
  readonly head_ref: string;
  readonly base_sha: string;
  readonly base_ref: string;
  readonly body: string;
  readonly review_decision: string | null;
  readonly changed_files: number;
  readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
}

export interface ProviderRequest {
  /** Provider read arguments. Exactly one of args and test_execution is set. */
  readonly args?: readonly string[];
  /** Best-effort evidence: a missing annotation feed is not a provider outage. */
  readonly optional?: boolean;
  /** Read test-level execution evidence for one attempt; the transport answers it. */
  readonly test_execution?: ProviderTestExecutionRequest;
}

export type ProviderJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ProviderJsonValue[]
  | { readonly [key: string]: ProviderJsonValue };

export interface ProviderReader {
  readonly fail: ReadinessFail;
  readonly object: (value: unknown, label: string) => Record<string, unknown>;
  readonly string: (value: unknown, label: string) => string;
  readonly gh: (args: readonly string[], accepted?: readonly number[]) => ProviderJsonValue;
  readonly ghOptional: (args: readonly string[]) => ProviderJsonValue | null;
  readonly driveRequests: <T>(protocol: Generator<ProviderRequest, T, unknown>) => T;
}

const PROVIDER_SYNCHRONOUS_TIMEOUT_MS = 30_000;

export function validSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) && value !== '0'.repeat(40);
}

function githubArguments(input: ProviderTransportInput, args: readonly string[]): readonly string[] {
  if (args[0] === 'api') return [...args, '--hostname', 'github.com'];
  if (input.repository) {
    const repository = `github.com/${input.repository}`;
    if (args[0] === 'repo' && args[1] === 'view') return [...args.slice(0, 2), repository, ...args.slice(2)];
    if (args[0] === 'pr') return [...args, '--repo', repository];
  }
  return args;
}

interface GhObservation {
  readonly status: number;
  readonly value: ProviderJsonValue;
}

function ghObserve(
  input: ProviderTransportInput,
  args: readonly string[],
  accepted: readonly number[],
  fail: ReadinessFail,
): GhObservation {
  args = githubArguments(input, args);
  const injected = input.gh_runner?.(args);
  const result = injected ?? spawnSync(input.gh_bin ?? process.env.REPO_HARNESS_GH_BIN ?? 'gh', [...args], {
    cwd: input.repo_root,
    env: { ...process.env, GH_HOST: 'github.com' },
    encoding: 'utf-8',
    timeout: PROVIDER_SYNCHRONOUS_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (('error' in result && result.error) || result.status === null || !accepted.includes(result.status)) {
    const cause = 'error' in result ? result.error : undefined;
    fail(
      'provider_unavailable',
      `provider observation failed: gh ${args.join(' ')}: ${(result.stderr || cause?.message || `exit ${result.status}`).trim()}`,
      cause,
    );
  }
  try {
    return { status: result.status, value: JSON.parse(result.stdout) };
  } catch (error) {
    fail(
      'provider_data_incomplete',
      `provider returned invalid JSON: gh ${args.join(' ')}`,
      error,
      'provider response is not valid JSON',
    );
  }
}

function readTestExecutionSync(
  input: ProviderTransportInput,
  request: ProviderTestExecutionRequest,
): RequiredCheckTestExecutionV1 {
  try {
    if (input.test_execution_reader !== undefined) return input.test_execution_reader(request);
    return readTestExecutionEvidence({
      repository: request.repository,
      run_id: request.run_id,
      attempt: request.attempt,
      repo_root: input.repo_root,
      gh_bin: input.gh_bin,
    });
  } catch {
    // Test-level evidence is best effort: a failed read is unavailable, never a pass.
    return Object.freeze({ status: 'unavailable' });
  }
}

export function createProviderReader(input: ProviderTransportInput, fail: ReadinessFail): ProviderReader {
  const object = (value: unknown, label: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('provider_data_incomplete', `${label} must be an object`);
    }
    return value as Record<string, unknown>;
  };

  const string = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || value.trim() === '') {
      fail('provider_data_incomplete', `${label} is required`);
    }
    return value;
  };

  const gh = (args: readonly string[], accepted: readonly number[] = [0]): ProviderJsonValue => {
    const observed = ghObserve(input, args, accepted, fail);
    if (args[0] === 'api' && accepted.includes(1)) {
      if (observed.status !== 0 && (observed.value as { status?: unknown } | null)?.status !== '404') {
        fail('provider_unavailable', 'rollback reporter activation unavailable');
      }
      if (observed.status === 0 && (observed.value as { status?: unknown } | null)?.status === '404') {
        fail('provider_data_incomplete', 'rollback reporter activation HTTP status is inconsistent');
      }
    }
    return observed.value;
  };

  /** A provider read where 404 is a real answer: a missing policy file, not a provider outage. */
  const ghOptional = (args: readonly string[]): ProviderJsonValue | null => {
    const observed = ghObserve(input, args, [0, 1], fail);
    if (observed.status === 0) {
      if ((observed.value as { status?: unknown } | null)?.status === '404') {
        fail('provider_data_incomplete', 'provider returned a 404 with a success status');
      }
      return observed.value;
    }
    if ((observed.value as { status?: unknown } | null)?.status === '404') return null;
    fail('provider_unavailable', `provider observation failed: gh ${args.join(' ')}: HTTP ${observed.status}`);
  };

  /** The one read driver: a protocol yields requests, the transport answers them. */
  const driveRequests = <T>(protocol: Generator<ProviderRequest, T, unknown>): T => {
    let request = protocol.next();
    while (!request.done) {
      let value: unknown = null;
      try {
        value = request.value.test_execution !== undefined
          ? readTestExecutionSync(input, request.value.test_execution)
          : gh(request.value.args!);
      } catch (error) {
        if (!request.value.optional || input.fatal_read_error?.(error)) throw error;
      }
      request = protocol.next(value);
    }
    return request.value;
  };

  return { fail, object, string, gh, ghOptional, driveRequests };
}
