// The launch of one seat in a Herdr pane (#1473): the argv for its runtime and
// the seat brief. Each limit names what the host does with it, so the output
// never claims a limit that the host cannot apply.
import { PANE_PREFIX } from '../terminal/pane-prefix';
import { AgySeatSettingsError, agyEffortValid, isCouncilSeat, isReviewSeat, isWorkerSeat, type LaunchSeatId, type SeatConfigV1, type SeatTool } from './seats-settings';
import { SEAT_EFFORT_ENV, SEAT_ENV, SEAT_MODEL_ENV, SEAT_REPOSITORY_ENV, isResetSeat } from './seat-reset';
import { brief } from './seat-launch-brief';
import { ADVISOR_GH_WRITE_COMMANDS, GITHUB_WRITE_COMMANDS, claudeLaunch, codexLaunch, piLaunch, seatEnv } from './seat-launch-runtimes';

/** `seats`: the stored section. `defaults`: no section, so `DEFAULT_SEATS_CONFIG`. */
export type SeatLaunchSource = 'seats' | 'defaults';

/**
 * - `enforced`: the argv blocks every path to the effect.
 * - `named_types_only`: the host refuses the agent types that the argv names; other types are not refused.
 * - `common_commands`: the argv blocks the direct tools, but a shell command or an MCP tool can still reach the same effect.
 * - `instructions_only`: written into the launch instructions only; the host does not refuse it.
 */
export type SeatLimitLevel = 'enforced' | 'named_types_only' | 'common_commands' | 'instructions_only';

/** A tool group that a seat can turn off. `read` is always on. */
type SeatGroup = Exclude<SeatTool, 'read'>;

export interface SeatLimitV1 {
  readonly subject: SeatGroup | 'fleet' | 'hook';
  readonly level: SeatLimitLevel;
}

export interface SeatLaunchV1 {
  readonly protocol: 1;
  readonly kind: 'seat_launch';
  readonly seat: LaunchSeatId;
  readonly runtime: SeatConfigV1['runtime'];
  readonly source: SeatLaunchSource;
  readonly argv: readonly string[];
  readonly brief: string;
  readonly limits: readonly SeatLimitV1[];
}

/** Built-in Claude Code agent types (Claude Code 2.1.316 and 2.1.317 init events and Agent tool), and `fork`. */
export const CLAUDE_BUILTIN_AGENT_TYPES = ['claude', 'claude-code-guide', 'Explore', 'fork', 'general-purpose', 'Plan', 'statusline-setup', 'web-fetch'] as const;

/** pi-subagents reads this variable per process for extra role directories. */
export const PI_EXTRA_AGENT_DIRS_ENV = 'PI_SUBAGENT_EXTRA_AGENT_DIRS';

/** The triage queue of the orchestrator seat keeps its name when the seat restarts (#1510). */
export const ORCHESTRATOR_TASK_LIST_ID = 'repo-harness-orchestrator';

/**
 * pi-subagents 0.87.0 ranks the extra role directory below the user and project role directories, so a
 * hand-written `explorer` there would shadow a generated one. The generated roles carry this prefix instead.
 */
export const piRoleName = (role: string): string => `rh-${role}`;

type RuntimeLaunch = Pick<SeatLaunchV1, 'argv' | 'brief' | 'limits'>;

const AGY_ORCHESTRATOR_COMMAND_PREFIXES: readonly string[] = [
  'rh board attention', 'rh board parents', 'rh board cluster', 'rh board triage-apply',
  'rh board dispatch', 'rh board review', 'rh board merge', 'rh board seats', 'rh board retro',
  'rh board closeout', 'rh board post', 'rh board migrate-dependencies',
  'rh seats argv', 'rh seats launch', 'rh seats council', 'rh seats pool', 'rh seats reset', 'rh seats handoff',
  'rh publication readiness', 'rh publication merge', 'rh review collect', 'rh review publish',
  'rh worktrees start', 'rh worktrees list', 'rh worktrees clean',
  'rh arch projection status', 'rh arch projection slice', 'rh arch projection publish', 'rh quota', 'rh doctor',
  'hc ls', 'hc get', 'hc read', 'hc wait', 'hc send', 'hc label', 'hc file read', 'herdr-app ls', 'herdr-app do',
  'gh issue view', 'gh issue list', 'gh issue create', 'gh issue comment', 'gh issue edit', 'gh issue close', 'gh issue reopen',
  'gh pr view', 'gh pr list', 'gh pr checks', 'gh pr diff', 'gh pr create', 'gh pr comment', 'gh pr edit', 'gh pr ready',
  'gh run view', 'gh run list', 'gh run watch', 'gh run rerun',
  'git fetch', 'git status', 'git worktree list',
];

const AGY_ORCHESTRATOR_DENIED_COMMANDS: readonly string[] = [
  'git reset --hard', 'git clean', 'gh release create', 'npm publish', 'bun publish',
];

const AGY_DENIED_RH_COMMANDS: readonly string[] = [
  'rh board attention start',
  'rh board merge', 'rh board dispatch', 'rh board review', 'rh board post',
  'rh board triage-apply', 'rh board closeout', 'rh board migrate-dependencies',
  'rh seats launch', 'rh seats reset', 'rh publication merge',
  'rh review collect', 'rh review publish',
];

export const AGY_READONLY_COMMAND_PREFIXES: readonly string[] = [
  'hc ls', 'hc get', 'hc read', 'hc file read', 'hc wait', 'hc send',
  'git log', 'git show', 'git diff', 'git status', 'git grep', 'git rev-parse', 'git ls-remote', 'git fetch',
  'gh pr view', 'gh pr list', 'gh pr checks', 'gh pr diff',
  'gh issue view', 'gh issue list', 'gh run view', 'gh run list',
  'rh board attention --parent', 'rh board parents', 'rh board cluster', 'rh board seats', 'rh board retro',
  'rh doctor', 'rh quota', 'rh seats pool',
  'rh arch projection status', 'rh arch debt',
  'rh arch refactor recommendations', 'rh arch refactor list', 'rh arch refactor show',
  'rh arch module list', 'rh arch module review-prompt',
  'rg', 'ls', 'cat',
];

export const AGY_READONLY_DENIED_COMMANDS: readonly string[] = [
  ...GITHUB_WRITE_COMMANDS,
  ...AGY_DENIED_RH_COMMANDS,
  'gh run rerun', 'git reset --hard', 'git clean',
];

export const AGY_WORKER_COMMAND_PREFIXES: readonly string[] = [
  'hc ls', 'hc get', 'hc read', 'hc wait', 'hc send',
  'git log', 'git show', 'git diff', 'git status', 'git grep', 'git rev-parse', 'git ls-remote', 'git fetch',
  'git add', 'git commit', 'git branch',
  'git worktree list',
  // Include the first path's ./ so even a string prefix cannot match an option after the `--`.
  'git merge-tree', 'git restore --staged -- ./', 'git mv -- ./',
  'git stash push', 'git stash list', 'git stash show',
  'gh pr view', 'gh pr list', 'gh pr checks', 'gh pr diff',
  'gh issue view', 'gh issue list', 'gh run view', 'gh run list',
  'rh arch projection status', 'rh arch projection slice', 'rh arch prepare', 'rh arch checkpoint',
  'rh arch complete', 'rh arch verify', 'rh arch debt', 'rh arch refactor verify', 'rh arch refactor resolve',
  'rh capability resolve', 'rh state', 'rh doctor', 'rh quota', 'rh seats pool', 'rh run',
  'bash scripts/check-ci.sh', 'bun', 'node', 'npm',
  'rg', 'ls', 'cat',
];

const AGY_WORKER_GH_COMMAND_PREFIXES: readonly string[] = [
  'git push', 'gh pr create', 'gh pr edit', 'gh pr comment', 'gh issue comment', 'gh run rerun',
];

export const AGY_WORKER_DENIED_COMMANDS: readonly string[] = [
  ...AGY_DENIED_RH_COMMANDS,
  'rh board', 'gh pr merge', 'gh release create', 'gh issue close',
  'git reset --hard', 'git clean',
];

const AGY_READONLY_AGENT_TOOLS = Object.freeze(['view_file', 'run_command', 'search_web'] as const);
const AGY_WORKER_AGENT_TOOLS = Object.freeze(['view_file', 'write_file', 'edit_file', 'run_command', 'search_web'] as const);

export function agySeatAgentName(seat: LaunchSeatId): string {
  if (seat === 'orchestrator') return 'rh-orchestrator';
  if (seat === 'advisor') return 'rh-advisor';
  if (seat === 'council') return 'rh-council';
  if (seat === 'gatekeeper') return 'rh-gatekeeper-fallback';
  if (isWorkerSeat(seat)) return 'rh-worker';
  throw new Error(`agy is not supported on seat ${seat}.`);
}

export function agySeatAgentTools(seat: LaunchSeatId, config: SeatConfigV1): readonly string[] {
  if (isWorkerSeat(seat)) return AGY_WORKER_AGENT_TOOLS;
  if (seat === 'advisor') return [
    ...(config.tools.includes('edit') ? AGY_WORKER_AGENT_TOOLS : AGY_READONLY_AGENT_TOOLS),
    ...(config.tools.includes('schedule') ? ['schedule'] : []),
  ];
  if (seat === 'orchestrator' || seat === 'council' || seat === 'gatekeeper') return AGY_READONLY_AGENT_TOOLS;
  throw new Error(`agy is not supported on seat ${seat}.`);
}

export function agySeatCommandRules(seat: LaunchSeatId, config: SeatConfigV1): { readonly allow: readonly string[]; readonly deny: readonly string[] } {
  if (seat === 'orchestrator') return { allow: AGY_ORCHESTRATOR_COMMAND_PREFIXES, deny: AGY_ORCHESTRATOR_DENIED_COMMANDS };
  if (isWorkerSeat(seat)) {
    const hasGh = config.tools.includes('gh');
    return {
      allow: hasGh ? [...AGY_WORKER_COMMAND_PREFIXES, ...AGY_WORKER_GH_COMMAND_PREFIXES] : AGY_WORKER_COMMAND_PREFIXES,
      deny: hasGh ? AGY_WORKER_DENIED_COMMANDS : [...new Set([...AGY_WORKER_DENIED_COMMANDS, ...GITHUB_WRITE_COMMANDS, 'gh run rerun'])],
    };
  }
  if (seat === 'advisor') {
    const hasGh = config.tools.includes('gh');
    return {
      allow: [
        ...AGY_READONLY_COMMAND_PREFIXES,
        'rh seats council', 'rh seats reset', 'rh seats handoff', 'rh arch refactor decide',
        ...(hasGh ? ADVISOR_GH_WRITE_COMMANDS : []),
      ],
      deny: AGY_READONLY_DENIED_COMMANDS.filter(command =>
        command !== 'rh seats reset' && (!hasGh || !ADVISOR_GH_WRITE_COMMANDS.includes(command))),
    };
  }
  if (seat === 'council' || seat === 'gatekeeper') {
    return { allow: AGY_READONLY_COMMAND_PREFIXES, deny: [...AGY_READONLY_DENIED_COMMANDS, 'rh arch refactor decide'] };
  }
  throw new Error(`agy is not supported on seat ${seat}.`);
}

const AGY_OFF_GROUPS = (config: SeatConfigV1): SeatGroup[] =>
  (['edit', 'shell', 'net', 'tasks', 'schedule', 'mcp', 'gh'] as const).filter(group => !config.tools.includes(group));

// Under --dangerously-skip-permissions (agy 1.5.16, #3487/#3489) there is no in-session approval prompt:
// --settings.permissions.deny still enforces denied command prefixes (edit/gh remain common_commands because
// shell and MCP paths stay open), and PreToolUse hooks enforce I1 deny and I2 deny on guarded tools
// (hook stays common_commands while read_file, MCP tools, and live disable remain outside the matcher per #3251 R1-R3).
// MCP and fleet omission must still be confirmed in a native agy session before reporting enforcement.
export function agySeatLimits(_seat: LaunchSeatId, config: SeatConfigV1): readonly SeatLimitV1[] {
  return [
    ...AGY_OFF_GROUPS(config).map((group): SeatLimitV1 => ({
      subject: group,
      level: group === 'edit' || group === 'gh' ? 'common_commands' : 'instructions_only',
    })),
    { subject: 'fleet', level: 'instructions_only' },
    { subject: 'hook', level: 'common_commands' },
  ];
}

export function agySeatBrief(seat: LaunchSeatId, config: SeatConfigV1): string {
  const limits = agySeatLimits(seat, config);
  return [
    brief(seat, config, [], limits),
    'Never read auth or credential files.',
    ...(seat === 'orchestrator' ? [
      'Write only your own scratch files under /tmp and outside every repository and worktree. Never edit repository files.',
    ] : []),
    ...(seat === 'advisor' ? [
      'Edit only your own files under /tmp/rh-triage/ and your scratch proposal or retro files outside every repository. Never edit repository source.',
      'Record a refactor decision only after the owner gives it.',
      'Follow the handoff steps printed by the Stop hook or rh seats handoff to request an in-pane relaunch from the orchestrator.',
    ] : []),
  ].join('\n\n');
}

/** Allowed directory names under `~/.gemini/config/agents` for repo-harness seat definitions. */
export const AGY_SEAT_AGENT_DIR_PATTERN = /^rh-(?:orchestrator|advisor|council|gatekeeper-fallback|worker)-[0-9a-f]{12}$/u;

interface AgyLaunchInputs {
  readonly executable: string;
  readonly agentName: string;
  readonly cwd: string;
}

function agyLaunch(seat: LaunchSeatId, config: SeatConfigV1, repositoryId: string | undefined, input: AgyLaunchInputs): RuntimeLaunch {
  const model = config.model;
  if (model === null) throw new Error('agy requires an explicit model.');
  if (!agyEffortValid(model, config.effort)) throw new AgySeatSettingsError('seat_effort_invalid', seat, 'effort');
  if (isWorkerSeat(seat) && !config.tools.includes('edit')) {
    throw new Error(`The ${seat} agy worker seat is configured read-only (missing edit). Enable edit for seats.${seat}.tools in Settings before launching it.`);
  }
  const env = isResetSeat(seat) && repositoryId !== undefined
    ? [`${SEAT_ENV}=${seat}`, `${SEAT_REPOSITORY_ENV}=${repositoryId}`, `${SEAT_MODEL_ENV}=${model}`,
      ...(config.effort === null ? [] : [`${SEAT_EFFORT_ENV}=${config.effort}`])]
    : [];
  const rules = agySeatCommandRules(seat, config);
  const settings = JSON.stringify({
    trustedWorkspaces: [input.cwd],
    permissions: {
      allow: rules.allow.map(command => `command(${command})`),
      deny: rules.deny.map(command => `command(${command})`),
    },
  });
  const limits = agySeatLimits(seat, config);
  return {
    argv: [
      ...seatEnv(env, PI_EXTRA_AGENT_DIRS_ENV), input.executable, '--dangerously-skip-permissions', '--model', model,
      ...(config.effort === null ? [] : ['--effort', config.effort]),
      '--agent', input.agentName, '--settings', settings,
    ],
    brief: agySeatBrief(seat, config),
    limits,
  };
}

export interface SeatLaunchOptions {
  readonly paneName?: string;
  readonly repositoryId?: string;
  readonly piRoleDirectory?: string;
  readonly piHookExtension?: string;
  readonly claudeSaving?: boolean;
  readonly agy?: AgyLaunchInputs;
}

function runtimeLaunch(runtime: SeatConfigV1['runtime'], seat: LaunchSeatId, config: SeatConfigV1, claudeAgentTypes: readonly string[], options: SeatLaunchOptions): RuntimeLaunch {
  switch (runtime) {
    case 'claude': return claudeLaunch(seat, config, claudeAgentTypes, options.paneName, options.repositoryId, options.claudeSaving ?? false, ORCHESTRATOR_TASK_LIST_ID, PI_EXTRA_AGENT_DIRS_ENV);
    case 'codex': return codexLaunch(seat, config, PI_EXTRA_AGENT_DIRS_ENV);
    case 'pi': return piLaunch(seat, config, options.piRoleDirectory, options.piHookExtension, options.repositoryId, PI_EXTRA_AGENT_DIRS_ENV, piRoleName);
    case 'agy': {
      if (options.agy === undefined) throw new Error('agy requires verified launch inputs.');
      return agyLaunch(seat, config, options.repositoryId, options.agy);
    }
    default: throw new Error(`Unsupported seat runtime ${runtime satisfies never}.`);
  }
}

export function buildSeatLaunch(seat: LaunchSeatId, config: SeatConfigV1, source: SeatLaunchSource, claudeAgentTypes: readonly string[], options: SeatLaunchOptions = {}): SeatLaunchV1 {
  return { protocol: 1, kind: 'seat_launch', seat, runtime: config.runtime, source, ...runtimeLaunch(config.runtime, seat, config, claudeAgentTypes, options) };
}

const PANE_ROLE = { orchestrator: 'orch', advisor: 'adv', council: 'cn', worker: 'w', 'worker-deep': 'w', 'worker-opus': 'w', 'worker-neon': 'w', 'worker-neon-deep': 'w', 'worker-light': 'w', gatekeeper: 'gk', reviewer: 'rv' } as const;
const PANE_NAME_MAX = 32;
const POSITIVE = /^[1-9][0-9]*$/u;
const WORD = /^[a-z][a-z0-9]*$/u;

export class SeatPaneNameError extends Error {
  readonly code = 'pane_name_invalid';
}

export interface SeatPaneNameInput {
  /** The `panePrefix` of the repository's registry entry (#1544). */
  readonly prefix: string;
  readonly seat: LaunchSeatId;
  readonly issue?: string;
  readonly pr?: string;
  /** The digits of a release item, for example `0252`. */
  readonly release?: string;
  readonly qualifier?: string;
}

/**
 * The hc `--name` and Claude `-n` of a seat pane: `<prefix>-<role>[-<item>][-<qualifier>]`. The worker item is its
 * issue or `rel<digits>`; the council item is its issue; the reviewer item is its PR.
 */
export function seatPaneName(input: SeatPaneNameInput): string {
  const fail = (why: string): never => { throw new SeatPaneNameError(`Pane name: ${why}.`); };
  const { prefix, seat, issue, pr, release, qualifier } = input;
  if (!PANE_PREFIX.test(prefix)) fail(`prefix ${JSON.stringify(prefix)} must match ${PANE_PREFIX.source}`);
  const role: string | undefined = PANE_ROLE[seat];
  if (role === undefined) fail(`unknown seat ${JSON.stringify(seat)}`);
  let item: string | undefined;
  if (isWorkerSeat(seat)) {
    if ((issue === undefined) === (release === undefined)) fail('a worker needs exactly one of an issue and a release item');
    if (pr !== undefined) fail('a worker takes no PR');
    if (issue !== undefined && !POSITIVE.test(issue)) fail('the issue must be a positive decimal integer');
    if (release !== undefined && !/^[0-9]+$/u.test(release)) fail('the release item must be digits');
    item = issue ?? `rel${release}`;
  } else if (isReviewSeat(seat)) {
    if (pr === undefined || !POSITIVE.test(pr)) fail(`a ${seat} needs a PR, a positive decimal integer`);
    if (issue !== undefined || release !== undefined) fail(`a ${seat} takes only a PR`);
    item = pr;
  } else if (isCouncilSeat(seat)) {
    if (issue === undefined || !POSITIVE.test(issue)) fail('a council seat needs an issue, a positive decimal integer');
    if (pr !== undefined || release !== undefined) fail('a council seat takes only an issue');
    item = issue;
  } else if (issue !== undefined || pr !== undefined || release !== undefined || qualifier !== undefined) {
    fail(`the ${seat} pane takes no item and no qualifier`);
  }
  if (qualifier !== undefined && !WORD.test(qualifier)) fail(`qualifier ${JSON.stringify(qualifier)} must match ${WORD.source}`);
  const name = [prefix, role, item, qualifier].filter(part => part !== undefined).join('-');
  if (name.length > PANE_NAME_MAX) fail(`${name} is longer than ${PANE_NAME_MAX} characters`);
  return name;
}

export interface SeatTabNameInput {
  readonly issue?: string;
  readonly pr?: string;
}

/**
 * The Herdr.app base tab name of a seat pane, before any fullness suffix (` 2`, ` 3`):
 * - worker seats: `#<issue>` when `--issue` is provided, else `other`
 * - review seats (`gatekeeper`, `reviewer`): fallback `PR#<pr>` when `--pr` is provided, else `review`
 * - council seats: `council`
 * - orchestrator / advisor: `orch`
 */
export function seatTabName(seat: LaunchSeatId, item: SeatTabNameInput = {}): string {
  if (item.issue !== undefined && !POSITIVE.test(item.issue)) throw new SeatPaneNameError('Tab name: the issue must be a positive decimal integer.');
  if (item.pr !== undefined && !POSITIVE.test(item.pr)) throw new SeatPaneNameError('Tab name: the PR must be a positive decimal integer.');
  if (isCouncilSeat(seat)) return 'council';
  if (isReviewSeat(seat)) return item.pr === undefined ? 'review' : `PR#${item.pr}`;
  if (isWorkerSeat(seat)) return item.issue === undefined ? 'other' : `#${item.issue}`;
  return 'orch';
}
