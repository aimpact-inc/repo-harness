import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'fs';
import { basename } from 'path';
import {
  RESET_SEATS, seatExitCommand, seatNoResetMessage, seatResetCommand, SEAT_RESET_RETRIES, handoffIdentity, seatResetClaimPath,
  seatResetLogPath, seatResetRequestPath, seatResetDirectory, seatResetRelaunchPath, seatResumePrompt, seatRewriteMessage,
  type InteractiveResetHost, type SeatLaunchModel, type SeatResetAction, type SeatResetIdentity,
} from '../../core/board/seat-reset';
import { seatHostId, type SeatRuntime } from '../../core/board/seats-settings';
import { HerdrCoreError, RH_LABEL, hcGet, hcKeys, hcList, hcSend, hcWait, type HcLabels, type HcTerminal, type HcWaitResult, type HerdrCoreOptions } from '../terminal/herdr-core';
import { readNotifyConfig } from '../terminal/notify-read';
import {
  handoffProblem, newSession, readRequest, readResumeTranscript, readSeatSession, seatResetEventCount, seatResetRequestState, sentResumed,
  type NewSession, type SeatRequest, type SeatSessionRecord,
} from './seat-reset-store';

export {
  readTranscriptUsage, writeSeatHandoff, writeSeatResetRequest, seatResetRequestState, recordSeatSession, readSeatSession,
  type TranscriptUsage, type SeatResetRequestRecord, type SeatSessionRecord,
} from './seat-reset-store';

/** `nothing_sent`: no terminal got a message. `uncertain`: the requester may already be cleared, or got part of a message. */
export type SeatResetOutcome = 'nothing_sent' | 'rewrite_requested' | 'no_reset' | 'uncertain';

export type SeatResetCode = 'handoff_path_invalid' | 'handoff_missing' | 'request_missing' | 'handoff_stale' | 'handoff_sha256_mismatch'
  | 'handoff_sections_missing' | 'already_claimed' | 'claim_failed' | 'caller_unknown' | 'requester_not_found' | 'requester_busy' | 'message_not_sent'
  | 'hc_failed' | 'requester_status_untracked' | 'requester_exited' | 'resume_not_sent' | 'request_invalid' | 'request_closed' | 'request_released'
  | 'seat_reset_runtime_unsupported' | 'seat_reset_destination_unavailable' | 'seat_reset_runtime_changed' | 'seat_reset_session_unconfirmed';

const RESET_FOREGROUNDS: Readonly<Record<InteractiveResetHost, string>> = { claude: 'claude', pi: 'pi', antigravity: 'agy' };
const WAITING_SHELLS: ReadonlySet<string> = new Set(['sh', 'zsh', 'bash', 'dash', 'ksh', 'ash']);
const INTERACTIVE_SHELL_ARG = /^(?:-[il]+|--login|--interactive)$/u;

function shellBasename(value: string): string {
  return basename(value).replace(/^-/u, '');
}

/** True when the terminal returned to its root shell or a waiting interactive shell after the seat exited. */
function isShellReady(terminal: HcTerminal, parentPid: number, agentPid: number): boolean {
  const { foreground } = terminal;
  if (foreground === null) return false;
  if (foreground.pid === parentPid) return true;
  if (foreground.pid === agentPid) return false;
  const command = foreground.argv[0];
  if (command === undefined) return false;
  if (!WAITING_SHELLS.has(shellBasename(command)) || !WAITING_SHELLS.has(shellBasename(foreground.name))) return false;
  return foreground.argv.slice(1).every(arg => INTERACTIVE_SHELL_ARG.test(arg));
}

export class SeatResetError extends Error {
  constructor(readonly code: SeatResetCode, readonly outcome: SeatResetOutcome, message: string, readonly logErrors: readonly string[] = []) {
    super(message);
  }
}

/** The characters that `hc keys` takes as single-character key names, and the space key. */
const TYPABLE = /^[A-Za-z0-9 /.-]+$/u;

/**
 * Types one line and Enter with `hc keys`. `hc send` wraps its text in an envelope, so Claude reads a sent slash
 * command as chat text and a shell reads a sent line as a parse error.
 */
function typeLine(terminal: string, line: string, options: HerdrCoreOptions): void {
  if (!TYPABLE.test(line)) throw new Error(`${JSON.stringify(line)} has a character that hc keys cannot type`);
  hcKeys(terminal, [...[...line].map(character => (character === ' ' ? 'space' : character)), 'enter'], options);
}

/** An error message without its final period, for use inside a sentence. */
const sentence = (error: unknown): string => (error as Error).message.replace(/\.$/u, '');

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export interface SeatResetTimeouts {
  readonly signalMs: number;
  /** The signal budget after `/compact`: a compaction in this repository took 71 s median and 237 s max. */
  readonly compactSignalMs: number;
  readonly evidenceMs: number;
  readonly exitMs: number;
  readonly pollMs: number;
}

const TIMEOUTS: SeatResetTimeouts = { signalMs: 60_000, compactSignalMs: 300_000, evidenceMs: 120_000, exitMs: 60_000, pollMs: 1_000 };
const WAIT_SECONDS = 600;

/** The notice port of the reset: one bot event to the configured notify channels; a failure is a result. */
export type SeatResetNotify = (env: NodeJS.ProcessEnv, event: {
  readonly repository: string | null; readonly kind: string; readonly data: Record<string, unknown>; readonly text: string;
}) => Promise<'sent' | 'failed' | 'not_configured'>;

/**
 * The launch of `rh seats argv <seat> --repository-id <id>` under the current quota: its argv and its effective
 * model and effort. `modeKnown` is false when the seat account has no fresh weekly reading, so the mode is unknown.
 */
export interface SeatRelaunch extends SeatLaunchModel {
  readonly argv: readonly string[];
  readonly runtime: SeatRuntime;
  readonly modeKnown: boolean;
}

export interface SeatResetTarget {
  readonly runtime: SeatRuntime;
  readonly model: () => Promise<SeatLaunchModel & { readonly modeKnown: boolean }>;
}

export interface SeatResetOptions extends HerdrCoreOptions {
  /** Resolve the configured runtime and, only when requested, the quota-selected model. */
  readonly resolveLaunch: (identity: SeatResetIdentity) => SeatResetTarget;
  /** Prepare the destination using normal launch checks, with startup evidence for a runtime change. */
  readonly relaunch: (identity: SeatResetIdentity, checkout: string, crossRuntime: boolean) => Promise<SeatRelaunch>;
  /** Tests only: shorter waits. */
  readonly timeouts?: SeatResetTimeouts;
  /** Posts one notice. Only the peer-runtime plugin supplies it; without it every failure records `not_configured`. */
  readonly notify?: SeatResetNotify;
}

type PreparedRelaunch = { readonly runtime: SeatRuntime; readonly host: InteractiveResetHost; readonly script: string } | { readonly problem: string };

export interface SeatResetResult {
  readonly requester: string;
  readonly seat: string;
  readonly relaunched: boolean;
  /** Reset log lines that could not be written; the reset went on without them. */
  readonly logErrors: readonly string[];
}

/** The notices of one run get this much time in total at the end of the run. */
const NOTICE_SETTLE_MS = 5_000;

/**
 * The peer seat runs this on a `RESET-REQUEST`. It finds the requester by its seat labels. A failed handoff check
 * asks for a rewrite, at most 3 times per request, and then tells the requester to continue without a reset. A
 * valid handoff gets the recorded action, `/compact` or `/clear`; the resume prompt goes out only after the
 * new-session signal. A missing signal after `/clear` types `/clear` again; a missing signal after `/compact` ends
 * the run, and auto-compaction stays as the net. A missing answer to the prompt sends it again. After 3 retries in
 * total the requester starts again from its seat argv in the same terminal. Antigravity and a `reset` that changes
 * the model or effort relaunch directly. A runtime change relaunches only with destination startup evidence.
 */
export async function runSeatReset(path: string, sha256: string, options: SeatResetOptions): Promise<SeatResetResult> {
  const identity = handoffIdentity(path);
  if (identity === null) throw new SeatResetError('handoff_path_invalid', 'nothing_sent', `${path} is not the handoff path of the orchestrator or advisor seat.`);
  const run = new SeatResetRun(identity, path, options);
  try {
    return { ...await run.reset(sha256), logErrors: run.logErrors };
  } catch (error) {
    if (error instanceof SeatResetError) throw new SeatResetError(error.code, error.outcome, error.message, run.logErrors);
    throw error;
  } finally {
    await run.settleNotices();
  }
}

/** One run of `seats reset` for a valid handoff path: the log, the notices and the reset steps. */
class SeatResetRun {
  readonly logErrors: string[] = [];
  private readonly notices: Promise<unknown>[] = [];
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeouts: SeatResetTimeouts;
  private readonly logPath: string;
  private request: SeatRequest | null = null;
  private requester = '';
  private requesterCheckout: string | null = null;
  private caller = '';
  private prompt = '';
  private attemptedKeys = false;

  constructor(private readonly identity: SeatResetIdentity, private readonly path: string, private readonly options: SeatResetOptions) {
    this.env = options.env ?? process.env;
    this.timeouts = options.timeouts ?? TIMEOUTS;
    this.logPath = seatResetLogPath(identity);
  }

  /** Appends one log entry first, then dispatches its notice without waiting. A failed write is kept for the result. */
  private record(kind: string, detail: string, extra: Record<string, unknown> = {}): void {
    const notify = this.options.notify;
    let notice: 'none' | 'dispatched' | 'not_configured' | 'config_invalid' = 'none';
    if (kind !== 'reset' && notify === undefined) notice = 'not_configured';
    else if (kind !== 'reset') {
      try { notice = readNotifyConfig(this.env) === null ? 'not_configured' : 'dispatched'; } catch { notice = 'config_invalid'; }
    }
    try {
      appendFileSync(this.logPath, `${JSON.stringify({ at: new Date().toISOString(), requested_at: this.request?.requestedAt ?? null, kind, detail, notice, ...extra })}\n`);
    } catch (error) {
      this.logErrors.push(`${kind}: ${sentence(error)}`);
    }
    if (notice !== 'dispatched' || notify === undefined) return;
    this.notices.push(notify(this.env, {
      repository: this.identity.repository, kind: 'seat.reset_failed', data: { seat: this.identity.seat, failure: kind, detail, handoff: this.path },
      text: `seat reset ${kind}: ${this.identity.seat} (${detail})`,
    }));
  }

  /** Records the failure and returns the error to throw. */
  private refuse(code: SeatResetCode, outcome: SeatResetOutcome, message: string, kind: string = code): SeatResetError {
    this.record(kind, code === kind ? message : code);
    return new SeatResetError(code, outcome, message);
  }

  private count(kind: string): number {
    return seatResetEventCount(this.identity, this.request!.requestedAt, kind);
  }

  async settleNotices(): Promise<void> {
    await Promise.race([Promise.allSettled(this.notices), new Promise(resolve => setTimeout(resolve, NOTICE_SETTLE_MS).unref())]);
  }

  async reset(sha256: string): Promise<Omit<SeatResetResult, 'logErrors'>> {
    mkdirSync(seatResetDirectory(this.identity), { recursive: true, mode: 0o700 });
    let claimed: string | null = null;
    try {
      const requestPath = seatResetRequestPath(this.identity);
      this.request = readRequest(this.identity);
      if (this.request === null && !existsSync(requestPath)) {
        throw this.refuse('request_missing', 'nothing_sent', `${requestPath} is missing: the Stop hook did not ask for this reset.`);
      }
      if (this.request === null) {
        // An old request without an action, or a damaged one: no action is invented. The Stop hook does not count it
        // as open, so the next crossing writes a fresh request.
        this.findRequester();
        throw this.release('request_invalid', `${requestPath} has no valid time or action, so nothing was typed`);
      }
      // A claimed request gets no message at all, not even REWRITE or NO-RESET.
      const claim = seatResetClaimPath(this.identity, this.request.requestedAt);
      if (existsSync(claim)) throw this.alreadyClaimed();
      this.findRequester();
      this.requireResettableRequester(this.trackedRequester());
      this.prompt = seatResumePrompt(this.identity, this.caller, this.request.action);
      this.claim(claim);
      claimed = claim;
      this.checkHandoff(sha256);
      const turn = this.wait();
      return await this.resetAndResume(turn, sha256);
    } catch (error) {
      if (error instanceof SeatResetError) throw error;
      if (!this.attemptedKeys) throw this.refuse('hc_failed', 'nothing_sent', `Reset failed before the first typed command: ${sentence(error)}.`);
      throw this.refuse('resume_not_sent', 'uncertain', `${this.requester} may have been reset: ${sentence(error)}. Send the resume prompt by hand: ${this.prompt}`);
    } finally {
      if (claimed !== null && !this.attemptedKeys) {
        try { unlinkSync(claimed); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.logErrors.push(`Remove the unused claim ${claimed} before retrying: ${sentence(error)}`);
        }
      }
    }
  }

  private get keyOutcome(): 'nothing_sent' | 'uncertain' {
    return this.attemptedKeys ? 'uncertain' : 'nothing_sent';
  }

  private type(line: string): void {
    // hc may fail after delivering part of the line. Keep the claim once a key command has been attempted.
    this.attemptedKeys = true;
    typeLine(this.requester, line, this.options);
  }

  private requireOpenRequest(session = readSeatSession(this.identity)): void {
    const request = this.request!;
    const status = seatResetRequestState(this.identity, request, session);
    if (status.state === 'open') return;
    if (status.state === 'released') {
      throw this.refuse('request_released', this.keyOutcome, `The peer already sent NO-RESET for the request of ${request.requestedAt}.`);
    }
    if (status.reason === 'session_started') {
      // A recovery relaunch can use the segment created by this run's earlier keys.
      if (this.attemptedKeys) return;
      throw this.release('request_closed', `a session segment started after the reset request of ${request.requestedAt}, so nothing was typed`);
    }
    throw this.refuse('request_closed', this.keyOutcome, `The reset request of ${request.requestedAt} is no longer current.`);
  }

  private alreadyClaimed(): SeatResetError {
    return this.refuse('already_claimed', 'nothing_sent', `The reset request of ${this.request!.requestedAt} is already claimed by an earlier run.`);
  }

  /** The exclusive create is the claim: a concurrent run gets EEXIST. Any other failure types nothing. */
  private claim(path: string): void {
    try {
      closeSync(openSync(path, 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw this.alreadyClaimed();
      throw this.refuse('claim_failed', 'nothing_sent', `${path} could not be created: ${sentence(error)}.`);
    }
  }

  private findRequester(): void {
    const caller = this.env.HC_TERMINAL_ID;
    if (!caller) throw this.refuse('caller_unknown', 'nothing_sent', 'HC_TERMINAL_ID is not set: run the reset from the peer seat terminal.');
    const terminals = hcList({ [RH_LABEL.seat]: this.identity.seat, [RH_LABEL.repository]: this.identity.repository }, this.options);
    if (terminals.length !== 1) {
      throw this.refuse('requester_not_found', 'nothing_sent', `${terminals.length} live terminals carry repo-harness.seat=${this.identity.seat} and repo-harness.repository=${this.identity.repository}; the reset needs exactly one.`);
    }
    this.requester = terminals[0]!.address;
    if (this.requester === caller) throw this.refuse('caller_unknown', 'nothing_sent', `The ${this.identity.seat} seat cannot reset itself: run the reset from the peer seat.`);
    const peer = RESET_SEATS.find(seat => seat !== this.identity.seat)!;
    let labels: HcLabels;
    try {
      labels = hcGet(caller, this.options).labels;
    } catch (error) {
      if (!(error instanceof HerdrCoreError) || error.reason !== 'unowned') throw error;
      throw this.refuse('caller_unknown', 'nothing_sent', `${caller} has no repo-harness label; the reset of ${this.identity.seat} requires ${RH_LABEL.repository}=${this.identity.repository} and ${RH_LABEL.seat}=${peer}.`);
    }
    for (const [key, expected] of [[RH_LABEL.repository, this.identity.repository], [RH_LABEL.seat, peer]] as const) {
      if (labels[key] !== expected) {
        throw this.refuse('caller_unknown', 'nothing_sent', `${caller} carries ${key}=${labels[key] ?? '(missing)'}; the reset of ${this.identity.seat} requires the caller to carry ${key}=${expected}.`);
      }
    }
    this.caller = caller;
  }

  private requireResettableRequester(terminal: HcTerminal): void {
    const expected = RESET_FOREGROUNDS[this.request!.host];
    const foreground = terminal.foreground?.argv[0];
    if (foreground === undefined || basename(foreground) !== expected) {
      throw this.refuse('seat_reset_runtime_unsupported', this.keyOutcome,
        `The ${this.identity.seat} reset requires a live ${expected} foreground in ${this.requester}.`);
    }
  }

  /** Sends one message to the requester and records it once; a refused send records only the failure. */
  private tell(kind: string, message: string, detail: string, problem: string): void {
    try {
      hcSend(this.requester, message, this.options);
    } catch (error) {
      throw this.refuse('message_not_sent', 'uncertain', `The ${kind} message to ${this.requester} failed: ${sentence(error)}. ${problem}`);
    }
    this.record(kind, detail);
  }

  private interactiveHost(): InteractiveResetHost {
    return this.request?.host ?? 'claude';
  }

  /** Releases the requester with NO-RESET: it continues, and no slash command is typed. */
  private release(code: 'request_invalid' | 'request_closed', reason: string): SeatResetError {
    this.tell('no_reset', seatNoResetMessage(reason, this.interactiveHost()), code, `${reason}.`);
    return new SeatResetError(code, 'no_reset', `${reason}. No reset: the requester continues.`);
  }

  /** A failed check asks for a rewrite, at most 3 times per request; then the requester continues without a reset. */
  private checkHandoff(sha256: string): void {
    this.requireOpenRequest();
    const problem = handoffProblem(this.path, sha256, this.request!);
    if (problem === null) return;
    const rewrites = this.count('rewrite');
    const [kind, message, outcome, result] = rewrites < SEAT_RESET_RETRIES
      ? ['rewrite', seatRewriteMessage(this.identity, problem.message, rewrites + 1, this.interactiveHost()), 'rewrite_requested' as const, `Rewrite ${rewrites + 1}/${SEAT_RESET_RETRIES} asked.`]
      : ['no_reset', seatNoResetMessage('the handoff failed every rewrite', this.interactiveHost()), 'no_reset' as const, 'The rewrites are used up: no reset; the requester continues.'];
    this.tell(kind, message, problem.code, problem.message);
    throw new SeatResetError(problem.code, outcome, `${problem.message} ${result}`);
  }

  private requireLiveRequester(terminal: HcTerminal): void {
    if (terminal.state === 'finished') {
      const recovery = this.attemptedKeys ? ` Start the seat and send: ${this.prompt}` : '';
      throw this.refuse('requester_exited', this.keyOutcome, `${this.requester} exited.${recovery}`);
    }
  }

  private trackedRequester(): HcTerminal {
    const terminal = hcGet(this.requester, this.options);
    this.requireLiveRequester(terminal);
    if (terminal.status === null) {
      throw this.refuse('requester_status_untracked', this.keyOutcome,
        `${this.requester} has untracked hc status (status: null, foreground: ${terminal.foreground?.name ?? 'unknown'}). Check the seat, then use hc keys ${this.requester} by hand or restart it with \`rh seats argv ${this.identity.seat} --repository-id ${this.identity.repository}\`.`);
    }
    return terminal;
  }

  /** A message to the waiting seat ends its wait (#2305). Continue for the rest of the same budget. */
  private waitForTurn(): HcWaitResult {
    const terminal = this.trackedRequester();
    this.requesterCheckout ??= terminal.cwd ?? null;
    const deadline = Date.now() + WAIT_SECONDS * 1000;
    let result = hcWait(this.requester, WAIT_SECONDS, this.options);
    while (!result.ended && result.reason === 'message') {
      const seconds = Math.ceil((deadline - Date.now()) / 1000);
      if (seconds < 1) break;
      result = hcWait(this.requester, seconds, this.options);
    }
    return result;
  }

  /** Only a requester that still works after the whole budget is busy. */
  private wait(): HcWaitResult {
    const result = this.waitForTurn();
    if (result.ended) return result;
    this.requireLiveRequester(hcGet(this.requester, this.options));
    throw this.refuse('requester_busy', this.keyOutcome, `${this.requester} did not end its turn in ${WAIT_SECONDS} s (${result.reason}).`);
  }

  private launchDirectory(): string {
    if (!this.requesterCheckout) throw new Error(`hc did not report the launch directory of ${this.requester}.`);
    return this.requesterCheckout;
  }

  private async poll<T>(read: () => T | null, ms: number): Promise<T | null> {
    for (const deadline = Date.now() + ms; ; await new Promise(resolve => setTimeout(resolve, this.timeouts.pollMs))) {
      const value = read();
      if (value !== null || Date.now() >= deadline) return value;
    }
  }

  private waitForSession(since: number, action: SeatResetAction | 'startup', host: InteractiveResetHost): Promise<NewSession | null> {
    const ms = action === 'compact' ? this.timeouts.compactSignalMs : this.timeouts.signalMs;
    return this.poll(() => newSession(this.identity, since, this.request!.transcriptPath, host, action), ms);
  }

  /** Sends the prompt unless launch already passed it; true when RESUMED succeeds in the new transcript. */
  private async promptAnswered(session: NewSession, sendPrompt = true): Promise<boolean> {
    const read = readResumeTranscript(session, this.env);
    if (sendPrompt) hcSend(this.requester, this.prompt, this.options);
    return await this.poll(() => (sentResumed(read(), this.prompt, this.caller, session.host) ? true : null), this.timeouts.evidenceMs) !== null;
  }

  private done(session: NewSession, detail: 'compacted' | 'cleared' | 'relaunched' | 'restarted'): Omit<SeatResetResult, 'logErrors'> {
    this.record('reset', detail, { session_id: session.sessionId });
    return { requester: this.requester, seat: this.identity.seat, relaunched: detail === 'relaunched' || detail === 'restarted' };
  }

  private requirePlannedRuntime(runtime: SeatRuntime): void {
    const configured = this.options.resolveLaunch(this.identity).runtime;
    if (configured === runtime) return;
    const reason = `The reset selected ${runtime}, but ${this.identity.seat} is now configured for ${configured}`;
    throw this.refuse('seat_reset_runtime_changed', this.keyOutcome, `${reason}. Run ${this.launchCommand()} to get the configured runtime's launch command.`);
  }

  private launchCommand(): string {
    return `\`rh seats argv ${this.identity.seat} --repository-id ${this.identity.repository}\``;
  }

  /** A model check can fail and still leave the current runtime available for an in-process reset. */
  private async modelChanged(action: SeatResetAction, target: SeatResetTarget): Promise<boolean> {
    const session = readSeatSession(this.identity);
    if (action !== 'reset' || session?.model == null) return false;
    try {
      const model = await target.model();
      if (!model.modeKnown) {
        this.record('model_check_failed', 'quota_unknown: the seat account has no fresh weekly quota reading, so the seat keeps its model');
        return false;
      }
      return model.model !== session.model || model.effort !== session.effort;
    } catch (error) {
      this.record('model_check_failed', `relaunch_argv_failed: ${sentence(error)}`);
      return false;
    }
  }

  /**
   * Types the recorded action once. No signal after `/clear` types it again; no signal after `/compact` ends the run
   * (a second `/compact` would compact a summary). No answer sends the prompt again. After 3 retries the requester is
   * relaunched.
   */
  private async resetAndResume(turn: HcWaitResult, sha256: string): Promise<Omit<SeatResetResult, 'logErrors'>> {
    const { action, host, transcriptPath } = this.request!;
    const target = this.options.resolveLaunch(this.identity);
    if (host === 'antigravity' || seatHostId(target.runtime) !== host) {
      return this.relaunch(turn, sha256, 'relaunched', transcriptPath, target.runtime);
    }
    if (await this.modelChanged(action, target)) return this.relaunch(turn, sha256, 'restarted', transcriptPath, target.runtime);
    let { since } = this.typeResetCommand(seatResetCommand(action, host), turn, sha256, target.runtime);
    let session: NewSession | null = null;
    // The log counts across runs; the run counts too, so an unwritable log still ends the retries.
    for (let failures = 1; ; failures += 1) {
      session ??= await this.waitForSession(since, action, host);
      const failure = session === null ? 'no_signal' : await this.promptAnswered(session) ? null : 'no_evidence';
      if (failure === null) return this.done(session!, action === 'compact' ? 'compacted' : 'cleared');
      this.record('resume', failure);
      if (failure === 'no_signal' && action === 'compact') {
        const autoHost = host === 'pi' ? 'Pi' : 'Claude Code';
        throw new SeatResetError('resume_not_sent', 'uncertain', `${this.requester} got /compact, but no compact session record came in ${this.timeouts.compactSignalMs / 1000} s. No second /compact: the seat continues and ${autoHost} auto-compaction stays as the net. If it compacts later, send: ${this.prompt}`);
      }
      if (failures > SEAT_RESET_RETRIES || this.count('resume') > SEAT_RESET_RETRIES) {
        return this.relaunch(this.wait(), sha256, 'relaunched', session?.transcript ?? transcriptPath, target.runtime);
      }
      if (failure === 'no_signal') {
        since = Date.now();
        const terminal = hcGet(this.requester, this.options);
        this.requireLiveRequester(terminal);
        this.requireResettableRequester(terminal);
        this.type(seatResetCommand('reset', host));
      }
    }
  }

  /** Under the claim, check the original settled turn and the request immediately before typing. */
  private typeResetCommand(command: string, turn: HcWaitResult, sha256: string, runtime: SeatRuntime,
    relaunch?: { readonly transcriptPath: string | null; readonly launch: PreparedRelaunch }) {
    const terminal = this.trackedRequester();
    this.requireResettableRequester(terminal);
    const settled = (state: string | undefined) => state === 'idle' || state === 'done';
    if (!settled(turn.status?.state) || !settled(terminal.status?.state) || terminal.turn !== turn.turn) {
      throw this.refuse('requester_busy', this.keyOutcome, `${this.requester} did not stay on the settled turn after hc wait.`);
    }
    if (!this.attemptedKeys) {
      const problem = handoffProblem(this.path, sha256, this.request!);
      if (problem !== null) throw this.refuse(problem.code, this.keyOutcome, problem.message);
    }
    const session = readSeatSession(this.identity);
    this.requireOpenRequest(session);
    this.requirePlannedRuntime(runtime);
    let launch: (Exclude<PreparedRelaunch, { problem: string }> & { readonly parentPid: number; readonly agentPid: number }) | undefined;
    if (relaunch !== undefined) {
      const prepared = relaunch.launch;
      if ('problem' in prepared) throw this.relaunchFailed(prepared.problem, true, seatHostId(runtime) !== this.request!.host);
      if (prepared.runtime !== runtime) throw this.relaunchFailed('the prepared runtime differs from the selected runtime');
      const pids = this.requireRelaunchReady(terminal, session, relaunch.transcriptPath);
      launch = { ...prepared, ...pids };
    }
    const since = Date.now();
    this.type(command);
    return { since, launch };
  }

  private requireRelaunchReady(terminal: HcTerminal, session: SeatSessionRecord | null, transcriptPath: string | null): { readonly parentPid: number; readonly agentPid: number } {
    if (terminal.pid === null || terminal.foreground === null || terminal.foreground.pid === terminal.pid) {
      throw this.relaunchFailed('requester_has_no_parent_shell');
    }
    if (session?.host !== this.request!.host || session.transcriptPath !== transcriptPath || terminal.cwd !== this.requesterCheckout) {
      throw this.refuse('seat_reset_session_unconfirmed', this.keyOutcome,
        `The running ${this.identity.seat} in ${this.requester} has no matching SessionStart record for this relaunch. Check the seat and run rh seats handoff again.`);
    }
    return { parentPid: terminal.pid, agentPid: terminal.foreground.pid };
  }

  private relaunchFailed(detail: string, beforeExit = true, crossRuntime = false): SeatResetError {
    let next = '';
    if (!beforeExit) next = ` Start it from ${this.launchCommand()} and send: ${this.prompt}`;
    else if (this.attemptedKeys) next = ` Send the resume prompt by hand: ${this.prompt}`;
    else if (crossRuntime) next = ` Run ${this.launchCommand()} to get the configured runtime's launch command.`;
    this.record('relaunch_failed', detail);
    return new SeatResetError(this.attemptedKeys ? 'resume_not_sent' : 'seat_reset_destination_unavailable', this.keyOutcome,
      `The relaunch of ${this.requester} failed (${detail}).${next}`);
  }

  private async prepareRelaunch(runtime: SeatRuntime): Promise<PreparedRelaunch> {
    const crossRuntime = seatHostId(runtime) !== this.request!.host;
    if (crossRuntime && runtime !== 'claude') {
      return { problem: `${runtime} provides no pre-exit SessionStart readiness evidence` };
    }
    const script = seatResetRelaunchPath(this.identity, this.request!.requestedAt);
    if (!TYPABLE.test(script) || script.includes(' ')) return { problem: 'relaunch_path_untypable' };
    try {
      const checkout = this.launchDirectory();
      const plan = await this.options.relaunch(this.identity, checkout, crossRuntime);
      if (plan.runtime === 'codex') return { problem: 'the prepared runtime has no SessionStart record' };
      const host = plan.runtime === 'agy' ? 'antigravity' : plan.runtime;
      // agy 1.5.16 fires SessionStart only on the first prompt, so pass the resume prompt via -i at launch.
      const argv = plan.runtime === 'agy' ? [...plan.argv, '-i', this.prompt] : plan.argv;
      const command = `exec ${argv.map(shellQuote).join(' ')}\n`;
      // The script runs the probed launch in the same checkout even if the parent shell has a different cwd.
      writeFileSync(script, crossRuntime ? `cd ${shellQuote(checkout)} && ${command}` : command, { mode: 0o700 });
      return { runtime: plan.runtime, host, script };
    } catch (error) {
      return { problem: `relaunch_argv_failed: ${sentence(error)}` };
    }
  }

  private async relaunch(turn: HcWaitResult, sha256: string, detail: 'relaunched' | 'restarted', transcriptPath: string | null,
    runtime: SeatRuntime): Promise<Omit<SeatResetResult, 'logErrors'>> {
    const host = this.request!.host;
    this.prompt = seatResumePrompt(this.identity, this.caller, 'reset');
    const prepared = await this.prepareRelaunch(runtime);
    const { launch } = this.typeResetCommand(seatExitCommand(host), turn, sha256, runtime, { transcriptPath, launch: prepared });
    const { script, host: destination, parentPid, agentPid } = launch!;
    const shellReady = await this.poll(() => {
      const current = hcGet(this.requester, this.options);
      this.requireLiveRequester(current);
      return isShellReady(current, parentPid, agentPid) ? true : null;
    }, this.timeouts.exitMs);
    if (shellReady === null) throw this.relaunchFailed(`${RESET_FOREGROUNDS[host]}_did_not_exit`, false);
    const startedAt = Date.now();
    this.type(`sh ${script}`);
    const session = await this.waitForSession(startedAt, 'startup', destination);
    if (session === null) throw this.relaunchFailed('no_signal', false);
    if (!await this.promptAnswered(session, destination !== 'antigravity')) throw this.relaunchFailed('no_evidence', false);
    return this.done(session, detail);
  }
}
