import { execFileSync } from 'child_process';

export type ExternalSourceFailureClass =
  | 'authentication'
  | 'rate_limit'
  | 'network'
  | 'invalid_response'
  | 'pagination_limit'
  | 'issue_limit'
  | 'body_limit'
  | 'payload_limit'
  | 'deadline'
  | 'repository_identity'
  | 'policy'
  | 'persistence';

export interface GithubRepositoryIdentityV1 {
  readonly provider_repository_id: string;
  readonly display_ref: string;
  readonly url: string;
}

export interface GithubCommandResult {
  readonly stdout: string;
  readonly stderr?: string;
}

export type GithubCommandRunner = (args: readonly string[], options: { readonly timeout_ms: number; readonly max_buffer: number }) => GithubCommandResult;

export class GithubAdapterError extends Error {
  constructor(
    readonly failure_class: ExternalSourceFailureClass,
    message: string,
    readonly outcome: 'incomplete' | 'unavailable' = 'unavailable',
    readonly repository: GithubRepositoryIdentityV1 | null = null,
    readonly pages_fetched = 0,
    readonly issues_seen = 0,
  ) {
    super(message);
    this.name = 'GithubAdapterError';
  }
}

export function runGithubCommand(args: readonly string[], options: { readonly timeout_ms: number; readonly max_buffer: number }): GithubCommandResult {
  try {
    return { stdout: execFileSync('gh', args, { encoding: 'utf8', timeout: options.timeout_ms, maxBuffer: options.max_buffer, stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    const detail = error as NodeJS.ErrnoException & { stderr?: Buffer | string; killed?: boolean };
    const stderr = detail.stderr ? String(detail.stderr).trim() : '';
    const message = `${detail.message}${stderr ? `: ${stderr}` : ''}`;
    if (detail.code === 'ETIMEDOUT' || detail.killed) throw new GithubAdapterError('deadline', message, 'unavailable');
    if (detail.code === 'ENOBUFS') throw new GithubAdapterError('payload_limit', message, 'incomplete');
    if (/(?:429|rate limit)/iu.test(message)) throw new GithubAdapterError('rate_limit', message, 'unavailable');
    if (/(?:401|403|auth|authentication|login)/iu.test(message)) throw new GithubAdapterError('authentication', message, 'unavailable');
    if (detail.code === 'ENOENT' || /network|ENOTFOUND|ECONN/u.test(message)) throw new GithubAdapterError('network', message, 'unavailable');
    throw new GithubAdapterError('invalid_response', message, 'unavailable');
  }
}
