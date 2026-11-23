import { lstatSync, realpathSync, statSync } from 'fs';
import { devNull } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { WORKFLOW_CONTRACT_MARKER_PATH } from '../../core/adoption/minimum-harness-version';
import { shellQuote } from '../../core/shell-quote';
import { ANTIGRAVITY_BRAIN_ROOTS } from '../../effects/board/antigravity-transcript';
import { HookPayloadError, parseHookPayload, payloadString, payloadValue, type HookPayload } from './hook-input';
import { HOST_RENDERERS, type HookOutcome, type HostOutput } from './hook-protocol';
import type { HookEvent, Route, RouteHost, RouteId } from './route-registry';

interface HostCapabilities {
  readonly handoff: 'compact-or-clear' | 'relaunch' | false;
  readonly sessionRecord: boolean;
  readonly ask: boolean;
  readonly inbox: boolean;
}

export interface HostAdapter {
  readonly decode: (input: string | Buffer | undefined, tuple: Pick<Route, 'event' | 'routeId'>) => HookPayload;
  readonly render: (outcome: HookOutcome) => HostOutput & { readonly exitCode: number };
  readonly capabilities: HostCapabilities;
}

const LEGACY_CAPABILITIES: HostCapabilities = { handoff: false, sessionRecord: false, ask: false, inbox: false };

function legacyAdapter(host: keyof typeof HOST_RENDERERS, capabilities: Partial<HostCapabilities>): HostAdapter {
  return {
    decode: parseHookPayload,
    render: outcome => ({ ...HOST_RENDERERS[host](outcome), exitCode: outcome.exitCode }),
    capabilities: { ...LEGACY_CAPABILITIES, ...capabilities },
  };
}

export const ANTIGRAVITY_GUARD_DENIAL = 'rh hook: the tool call is refused';
export { ANTIGRAVITY_BRAIN_ROOTS };

const ANTIGRAVITY_TOOLS = {
  bash: { run_command: 'Bash' },
  edit: { write_file: 'Write', edit_file: 'Edit' },
} as const;

type AntigravityGuardRoute = keyof typeof ANTIGRAVITY_TOOLS;

function isAntigravityGuard(tuple: Pick<Route, 'event' | 'routeId'>): tuple is { event: 'PreToolUse'; routeId: AntigravityGuardRoute } {
  return tuple.event === 'PreToolUse' && Object.hasOwn(ANTIGRAVITY_TOOLS, tuple.routeId);
}

export function antigravityHookMatcher(routeId: AntigravityGuardRoute): string {
  return Object.keys(ANTIGRAVITY_TOOLS[routeId]).join('|');
}

export class AntigravityToolInputError extends HookPayloadError {
  constructor(tool: 'run_command' | 'write_file' | 'edit_file') {
    super(`rh hook: malformed ${tool} input`);
  }
}

function decodeAntigravity(input: string | Buffer | undefined, tuple: Pick<Route, 'event' | 'routeId'>): HookPayload {
  const wire = parseHookPayload(input);
  const payload = { cwd: wire.cwd, session_id: wire.conversationId, transcript_path: wire.transcriptPath };
  if (isAntigravityGuard(tuple)) {
    const tool = payloadValue(wire, 'toolCall.name');
    if (tuple.routeId === 'bash' && tool === 'run_command') {
      const command = payloadValue(wire, 'toolCall.args.CommandLine');
      if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw new AntigravityToolInputError(tool);
      return { ...payload, tool_name: ANTIGRAVITY_TOOLS.bash[tool], tool_input: { command } };
    }
    if (tuple.routeId === 'edit' && (tool === 'write_file' || tool === 'edit_file')) {
      const path = payloadValue(wire, 'toolCall.args.Path');
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new AntigravityToolInputError(tool);
      return { ...payload, tool_name: ANTIGRAVITY_TOOLS.edit[tool], tool_input: { file_path: path } };
    }
    throw new HookPayloadError('tool does not match the route');
  }
  if (tuple.event === 'SessionStart') return { ...payload, source: 'startup' };
  if (tuple.event === 'Stop') return { ...payload, stop_hook_active: wire.executionNum !== 0 };
  // PreInvocation uses the common fields for the inbox route.
  return payload;
}

export function antigravityEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['HOME', 'PATH', 'TMPDIR', 'BUN_INSTALL', 'HOOK_HOST']);
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    allowed.has(key) || key === 'REPO_HARNESS_SEAT' || key.startsWith('REPO_HARNESS_SEAT_')));
}

type AntigravityRepository =
  | { readonly status: 'opted-in'; readonly cwd: string; readonly repoRoot: string }
  | { readonly status: 'not-in-git-repo' | 'non-opt-in'; readonly repoRoot: string | null };

/** Resolve the tool's working directory. The hook process runs in the config directory. */
export function resolveAntigravityRepository(payload: HookPayload): AntigravityRepository {
  const supplied = payloadString(payload, 'cwd');
  if (!isAbsolute(supplied)) throw new HookPayloadError('cwd must be absolute');
  const cwd = realpathSync(supplied);
  if (!statSync(cwd).isDirectory()) throw new HookPayloadError('cwd must be a directory');
  for (let dir = cwd; ; dir = dirname(dir)) {
    const git = lstatSync(join(dir, '.git'), { throwIfNoEntry: false });
    if (git) {
      if (!git.isDirectory() && !git.isFile()) throw new HookPayloadError('invalid .git entry');
      return lstatSync(join(dir, WORKFLOW_CONTRACT_MARKER_PATH), { throwIfNoEntry: false })
        ? { status: 'opted-in', cwd, repoRoot: dir }
        : { status: 'non-opt-in', repoRoot: dir };
    }
    if (dirname(dir) === dir) return { status: 'not-in-git-repo', repoRoot: null };
  }
}

function renderAntigravity(outcome: HookOutcome): ReturnType<HostAdapter['render']> {
  const emit = (value: Record<string, unknown>) => ({ stdout: `${JSON.stringify(value)}\n`, stderr: '', exitCode: 0 });
  if (outcome.reason === 'unknown-route' || outcome.reason === 'unsupported-host-route') {
    return { stdout: '', stderr: 'repo-harness-hook: invalid Antigravity route\n', exitCode: outcome.exitCode };
  }
  if (isAntigravityGuard(outcome)) {
    if (outcome.reason === 'invalid-payload' && outcome.permission?.decision === 'deny') {
      return emit({ decision: 'deny', reason: outcome.permission.reason });
    }
    if (outcome.reason === 'blocked' || outcome.permission?.decision === 'deny') {
      return emit({ decision: 'deny', reason: ANTIGRAVITY_GUARD_DENIAL });
    }
    if (outcome.exitCode !== 0) return emit({ decision: 'deny', reason: `rh hook failed: ${outcome.routeId}; the call is refused` });
    // force_ask prompts even when Antigravity has a cached approval for this tool.
    if (outcome.permission?.decision === 'ask') return emit({ decision: 'force_ask', reason: outcome.permission.reason });
  }
  if (outcome.event === 'Stop' && outcome.reason === 'blocked') {
    return emit({ decision: 'continue', reason: outcome.diagnostics.trimEnd() });
  }
  if ((outcome.event === 'SessionStart' || outcome.event === 'UserPromptSubmit') && outcome.exitCode === 0) {
    const context = [outcome.additionalContext, outcome.systemMessage].filter(Boolean).join('\n');
    if (context) return emit({ injectSteps: [{ systemMessage: { systemMessage: context } }] });
  }
  // Empty tool and Stop responses leave permission and termination to Antigravity.
  return { stdout: '', stderr: '', exitCode: 0 };
}

export const HOST_ADAPTERS: Readonly<Record<RouteHost, HostAdapter>> = Object.freeze({
  claude: legacyAdapter('claude', { handoff: 'compact-or-clear', sessionRecord: true, ask: true }),
  codex: legacyAdapter('codex', { inbox: true }),
  pi: legacyAdapter('pi', { handoff: 'compact-or-clear', sessionRecord: true, inbox: true }),
  antigravity: {
    decode: decodeAntigravity,
    render: renderAntigravity,
    capabilities: { handoff: 'relaunch', sessionRecord: true, ask: true, inbox: true },
  },
});

/** Command used for one Antigravity handler in hooks.json. */
export function renderAntigravityHookCommand(bun: string, entry: string, event: HookEvent, routeId: RouteId): string {
  return `HOOK_HOST=antigravity exec ${shellQuote(bun)} --no-env-file --config=${shellQuote(devNull)} ${shellQuote(entry)} ${event} --route ${routeId}`;
}
