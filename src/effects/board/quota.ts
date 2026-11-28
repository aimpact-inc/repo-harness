import type { AccountUsageSnapshot, InstallationSnapshot } from '@botiverse/oar/browser';
import { execFile, spawn } from 'node:child_process';
import { retryWindowsSharingRace } from '../atomic-append';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { version as PACKAGE_VERSION } from '../../../package.json';
import {
  buildQuotaReport,
  CLAUDE_QUOTA_CAPTURE_PATH,
  decodeClaudeQuotaCapture,
  decodeCodexRateLimitsResult,
  decodeMagpieCodexQuota,
  projectAgyQuota,
  unknownAgyQuota,
  unknownQuotaReading,
  type ClaudeQuotaCapture,
  type CodexCreditRouting,
  type QuotaReading,
  type QuotaReport,
} from '../../core/board/quota';
import { hasAgySeat, seatAccount } from '../../core/board/seat-routing';
import { SEAT_IDS } from '../../core/board/seats-settings';
import { readSeatsConfiguration, resolveAgyInstallation } from './seats-configuration';

const CODEX_READ_TIMEOUT_MS = 20_000;
const MAGPIE_READ_TIMEOUT_MS = 15_000;
const AGY_READ_TIMEOUT_MS = 20_000;

/**
 * Classify the provider readings at the caller's exhaustion line. The configured seats decide whether to query agy.
 */
export async function readQuotaReport(env: NodeJS.ProcessEnv, exhaustedAtOrAboveUsed: number): Promise<QuotaReport> {
  const { seats } = readSeatsConfiguration(env);
  const claude = readClaudeQuota(env);
  const [codex, agy] = await Promise.all([
    readCodexQuota(env, PACKAGE_VERSION, CODEX_READ_TIMEOUT_MS, seats.routing),
    hasAgySeat(seats) ? readAgyQuota(env) : [],
  ]);
  const readings = [claude, codex, ...agy];
  if (SEAT_IDS.some(id => seats[id] !== null && seatAccount(seats[id]) === 'gemini_app')) {
    readings.push(unknownQuotaReading('gemini_app', 'no Gemini App quota reader'));
  }
  return buildQuotaReport(readings, Date.now(), exhaustedAtOrAboveUsed);
}

/** Discard OAR account identity at the boundary. Only model-group quota windows leave it. */
export function decodeAgyQuota(snapshot: AccountUsageSnapshot, observedAt: string): QuotaReading[] {
  if (snapshot.kind === 'reauth_required') return unknownAgyQuota('agy is signed out');
  if (snapshot.kind !== 'available') return unknownAgyQuota('agy account quota is unavailable');
  return projectAgyQuota(snapshot.windows, observedAt);
}

/** Read both model groups through agy's own sign-in. */
export async function readAgyQuota(env: NodeJS.ProcessEnv, verified?: Promise<InstallationSnapshot>): Promise<QuotaReading[]> {
  try {
    const installation = await (verified ?? resolveAgyInstallation(env));
    if (installation.kind === 'not_found') return unknownAgyQuota('agy not installed');
    if (installation.kind !== 'available' || installation.via !== 'executable') return unknownAgyQuota('agy installation is unsupported');
    const { antigravityRuntime } = await import('@botiverse/oar/runtimes/antigravity');
    const environment = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? null] as const));
    const options = { env: environment, timeoutMs: AGY_READ_TIMEOUT_MS };
    return decodeAgyQuota(await antigravityRuntime.accountUsage(installation, options), new Date().toISOString());
  } catch (error) {
    // Use fixed reasons. An executable or library error can include private text.
    const message = error instanceof Error ? error.message : '';
    if (message === 'Antigravity account usage timed out') return unknownAgyQuota('agy quota read timed out after 20 s');
    if (message === 'Antigravity account usage: agy -p /usage failed (exit 2)') return unknownAgyQuota('agy /usage exited 2 without account quota');
    return unknownAgyQuota('agy quota reader failed');
  }
}

function claudeCapturePath(env: NodeJS.ProcessEnv): string {
  return join(env.HOME ?? homedir(), ...CLAUDE_QUOTA_CAPTURE_PATH);
}

/** Reads only the capture file that the Q2 status line route writes. */
export function readClaudeQuota(env: NodeJS.ProcessEnv = process.env): QuotaReading {
  const path = claudeCapturePath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return unknownQuotaReading('claude', code === 'ENOENT' ? 'no capture' : `capture unreadable (${code})`);
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return unknownQuotaReading('claude', 'capture is not JSON'); }
  return decodeClaudeQuotaCapture(value);
}

/**
 * Writes the status line `rate_limits` object, unchanged, with a new
 * `observed_at`. The reader's decoder checks the capture first: a capture
 * that it rejects is not written, and the old file stays. Concurrent sessions
 * each write a unique temp file and rename it, so a reader never sees a
 * partial file.
 */
function writeClaudeQuotaCapture(rateLimits: unknown, now: Date, env: NodeJS.ProcessEnv = process.env): QuotaReading {
  const capture = { observed_at: now.toISOString(), rate_limits: rateLimits };
  const reading = decodeClaudeQuotaCapture(capture);
  if (reading.reason !== null) return reading;
  // The decoder accepted the object, so it has the ClaudeQuotaCapture shape.
  const accepted = capture as ClaudeQuotaCapture;
  const path = claudeCapturePath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(accepted)}\n`, { mode: 0o600, flag: 'wx' });
    retryWindowsSharingRace(() => renameSync(temp, path));
  } finally {
    rmSync(temp, { force: true });
  }
  return reading;
}

const STATUS_LINE_LABELS: Readonly<Record<string, string>> = { five_hour: '5h', seven_day: '7d' };

export interface ClaudeStatusLineResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The `repo-harness-hook statusline` handler for the Claude Code status line
 * stdin `rate_limits` value (https://code.claude.com/docs/en/statusline). It
 * prints each window with a reading, for example `5h 12% · 7d 30%`; an absent
 * window is left out. Without `rate_limits` it writes nothing, keeps the old
 * capture and prints an empty line.
 */
export function runClaudeStatusLine(rateLimits: unknown, env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): ClaudeStatusLineResult {
  if (rateLimits === undefined) return { exitCode: 0, stdout: '\n', stderr: '' };
  const reading = writeClaudeQuotaCapture(rateLimits, now, env);
  if (reading.reason !== null) {
    return { exitCode: 1, stdout: '', stderr: `repo-harness-hook statusline: capture not written: ${reading.reason}\n` };
  }
  const line = reading.windows
    .filter(window => window.used_percent !== null)
    .map(window => `${STATUS_LINE_LABELS[window.window]} ${Math.round(window.used_percent!)}%`)
    .join(' · ');
  return { exitCode: 0, stdout: `${line}\n`, stderr: '' };
}

/** Keep the native account authoritative when it returns a quota signal. */
export async function readCodexQuota(env: NodeJS.ProcessEnv, clientVersion: string, timeoutMs = CODEX_READ_TIMEOUT_MS,
  routing?: CodexCreditRouting): Promise<QuotaReading> {
  const native = await readCodexAppServerQuota(env, clientVersion, timeoutMs);
  const nativeAnswered = native.reason === null && (native.codex?.credits != null
    || native.codex?.rate_limit_reached_type != null || native.windows.some(window => window.used_percent !== null && window.resets_at !== null));
  const reading = nativeAnswered ? native : (await readMagpieCodexQuota(env)) ?? native;
  if (!reading.codex?.credits) return reading;
  const { codex_credit_mode, codex_credit_floor } = routing ?? readSeatsConfiguration(env).seats.routing;
  return { ...reading, credit_routing: { codex_credit_mode, codex_credit_floor } };
}

function readMagpieCodexQuota(env: NodeJS.ProcessEnv): Promise<QuotaReading | null> {
  return new Promise(resolve => {
    execFile('magpie', ['quota', 'codex', '--json'], { env, timeout: MAGPIE_READ_TIMEOUT_MS, killSignal: 'SIGKILL' }, (error, stdout) => {
      if (error) { resolve(null); return; }
      let value: unknown;
      try { value = JSON.parse(stdout); } catch { resolve(null); return; }
      resolve(decodeMagpieCodexQuota(value));
    });
  });
}

/**
 * One active read through `codex app-server`: `initialize`, then
 * `account/rateLimits/read`. It starts no thread and no model turn, and reads
 * no Codex rollout log. Every failure is an `unknown` reading with its reason.
 */
function readCodexAppServerQuota(env: NodeJS.ProcessEnv, clientVersion: string, timeoutMs: number): Promise<QuotaReading> {
  return new Promise(resolve => {
    const child = spawn('codex', ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false;
    const finish = (reading: QuotaReading) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      resolve(reading);
    };
    const fail = (reason: string) => finish(unknownQuotaReading('chatgpt', reason));
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => fail(`codex app-server did not answer in ${timeoutMs / 1000} s`), timeoutMs);
    child.once('error', error => fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'codex not on PATH' : `codex app-server did not start (${(error as NodeJS.ErrnoException).code})`));
    // `close` follows the last stdout line, so a response written just before exit still counts.
    child.once('close', (code, signal) => fail(`codex app-server exited (${signal ?? code}) before the response`));
    // A broken pipe shows as the exit above; the reason names the exit, not the write.
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(line); } catch { fail('codex app-server wrote a line that is not JSON'); return; }
      // Notifications and server requests carry a method. This read answers neither.
      if (!message || typeof message !== 'object' || 'method' in message) return;
      const error = message.error as { message?: unknown } | undefined;
      if (message.id === 0) {
        if (error) { fail(`initialize error: ${String(error.message)}`); return; }
        send({ method: 'initialized' });
        send({ method: 'account/rateLimits/read', id: 1 });
      } else if (message.id === 1) {
        if (error) fail(`account/rateLimits/read error: ${String(error.message)}`);
        else finish(decodeCodexRateLimitsResult(message.result, new Date().toISOString()));
      }
    });
    send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'repo-harness', version: clientVersion } } });
  });
}
