import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

type GitChildOutcome = {
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly overflow: boolean;
  readonly spawnError?: Error;
};

export function watchGitChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
  limits: { readonly timeoutMs: number; readonly killGraceMs: number; readonly outputBytes: number },
  abortSignal: AbortSignal | undefined,
  complete: (outcome: GitChildOutcome) => void,
): void {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let exited: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null = null;
  let timedOut = false;
  let aborted = false;
  let overflow = false;
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = () => {
    if (aborted && killTimer !== undefined) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), limits.killGraceMs);
  };
  const abort = () => { aborted = true; if (exited) finish(); else terminate(); };
  const finish = (spawnError?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    clearTimeout(killTimer);
    abortSignal?.removeEventListener('abort', abort);
    child.stdout.destroy();
    child.stderr.destroy();
    complete({
      stdout,
      stderr,
      status: exited?.code ?? null,
      signal: exited?.signal ?? null,
      timedOut,
      aborted,
      overflow,
      spawnError,
    });
  };
  const collect = (into: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > limits.outputBytes) {
      if (!overflow) { overflow = true; terminate(); }
      return;
    }
    into.push(chunk);
  };
  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));
  const deadline = setTimeout(() => {
    timedOut = true;
    // A process that exited but left its pipes open to a descendant has nothing left to kill.
    if (exited) finish();
    else terminate();
  }, limits.timeoutMs);
  child.on('error', (error) => { if (child.pid === undefined) finish(error); });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    if (timedOut || overflow || aborted) finish();
  });
  child.on('close', (code, signal) => {
    exited ??= { code, signal };
    finish();
  });
  abortSignal?.addEventListener('abort', abort, { once: true });
  if (abortSignal?.aborted) abort();
}
