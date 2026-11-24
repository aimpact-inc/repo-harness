// The launch of one seat in a Herdr pane (#1473): the argv for its runtime and
// the seat brief. Each limit names what the host does with it, so the output
// never claims a limit that the host cannot apply.
import { PANE_PREFIX } from '../terminal/pane-prefix';
import { AgySeatSettingsError, agyEffortValid, isCouncilSeat, isReviewSeat, isWorkerSeat, seatTakesFleet, type LaunchSeatId, type SeatConfigV1, type SeatTool } from './seats-settings';
import { SEAT_EFFORT_ENV, SEAT_ENV, SEAT_MODEL_ENV, SEAT_REPOSITORY_ENV, isResetSeat } from './seat-reset';

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

/** A Claude seat in saving mode disables the advisor tool, which overrides the user's persistent `advisorModel` setting (#3091). */
const CLAUDE_DISABLE_ADVISOR_ENV = 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL';

/** The triage queue of the orchestrator seat keeps its name when the seat restarts (#1510). */
export const ORCHESTRATOR_TASK_LIST_ID = 'repo-harness-orchestrator';

/** GitHub write commands that a missing `gh` group refuses. Other commands, such as `gh api`, still run. */
const GITHUB_WRITE_COMMANDS = [
  'gh issue close', 'gh issue comment', 'gh issue create', 'gh issue edit',
  'gh pr close', 'gh pr comment', 'gh pr create', 'gh pr edit', 'gh pr merge', 'gh pr review',
  'gh release create', 'git push',
];

/** The only GitHub write commands that an advisor with `gh` granted may run (#3468). */
const ADVISOR_GH_WRITE_COMMANDS: readonly string[] = [
  'gh issue comment', 'gh pr comment', 'gh issue create',
];

function claudeDeniedGithubCommands(seat: LaunchSeatId, hasGh: boolean): readonly string[] {
  if (!hasGh) return GITHUB_WRITE_COMMANDS;
  return seat === 'advisor'
    ? GITHUB_WRITE_COMMANDS.filter(command => !ADVISOR_GH_WRITE_COMMANDS.includes(command))
    : [];
}

/**
 * The built-in Claude tools of each group, for the `--tools` allow list (owner decision M22). Every built-in tool
 * that no enabled group names is off, also a tool that a later host version adds. `gh` names no tool: it needs the
 * shell, and a seat without `gh` denies the GitHub write command prefixes of Bash. `--tools` does not filter MCP
 * tools, so a seat without `mcp` also passes `--strict-mcp-config` (init-event probe, #1473).
 */
const CLAUDE_GROUP_TOOLS: Readonly<Record<SeatTool, readonly string[]>> = {
  read: ['Read', 'Glob', 'Grep'],
  edit: ['Edit', 'Write', 'NotebookEdit'],
  shell: ['Bash', 'Monitor', 'TaskStop'],
  net: ['WebFetch', 'WebSearch'],
  tasks: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'],
  schedule: ['CronCreate', 'CronList', 'CronDelete'],
  mcp: ['ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool'],
  gh: [],
};

/** Groups whose effect a shell command or an MCP tool can also reach. */
const SIDE_PATH_GROUPS: ReadonlySet<SeatGroup> = new Set(['edit', 'gh', 'net']);

/**
 * The one level rule for every runtime: a group is `enforced` only when the argv blocks every path to it. When the
 * argv blocks the direct tools of `edit`, `gh` or `net` and a shell or MCP path stays open, it is `common_commands`.
 */
function pathLevel(group: SeatGroup, direct: SeatLimitLevel, sidePathOpen: boolean): SeatLimitLevel {
  return direct === 'enforced' && sidePathOpen && SIDE_PATH_GROUPS.has(group) ? 'common_commands' : direct;
}

const GROUP_TEXT: Readonly<Record<SeatGroup, string>> = {
  edit: 'Do not edit files.',
  shell: 'Do not run shell commands.',
  net: 'Do not use the network.',
  tasks: 'Do not use the task list tools.',
  schedule: 'Do not schedule recurring jobs.',
  mcp: 'Do not use MCP tools.',
  gh: 'Do not write to GitHub.',
};

/** `schedule` is Claude-only (Cron tools): Codex and Pi launches report no limit for it. */
const OFF_GROUPS = (config: SeatConfigV1): SeatGroup[] =>
  (['edit', 'shell', 'net', 'tasks', 'schedule', 'mcp', 'gh'] as const).filter(group => !config.tools.includes(group) && (group !== 'schedule' || config.runtime === 'claude'));

/**
 * pi-subagents 0.87.0 ranks the extra role directory below the user and project role directories, so a
 * hand-written `explorer` there would shadow a generated one. The generated roles carry this prefix instead.
 */
export const piRoleName = (role: string): string => `rh-${role}`;

type RoleName = (role: string) => string;
const roleList = (fleet: readonly string[], name: RoleName) => fleet.map(role => `\`${name(role)}\``).join(', ');

function advisorParagraphs(config: SeatConfigV1, fleet: readonly string[], name: RoleName): string[] {
  const evidence = fleet.length === 0
    ? 'You have no sub-agents. Collect evidence yourself.'
    : [
      `Collect evidence through your sub-agents: ${roleList(fleet, name)}. Split one research request into 2 to 4 read-only briefs with scopes that do not overlap, and send them in parallel.`,
      ...(fleet.includes('deep-reasoner') ? [`Use ${name('deep-reasoner')} only for an independent second judgment.`] : []),
      'Keep judgment, synthesis and the proposal for yourself. Run a check of one or two commands yourself.',
    ].join(' ');
  const ghRule = config.tools.includes('gh')
    ? 'You may write to GitHub only with `gh issue comment`, `gh pr comment`, and `gh issue create` (end each comment with `Seat: advisor <hc address>`). Do not commit, push, merge, close or reopen, label, edit issue or PR bodies, review, or release.'
    : 'You do not commit or write to GitHub.';
  return [
    `You are the advisor seat. You serve only the orchestrator. You do research and write proposals. ${ghRule} Edit files only for your proposals.`,
    'You may read the processes of worker seats (hc ls, hc get and hc read on seat-labeled terminals) for evidence. You do not send messages or keys to a worker. You report only to the orchestrator.',
    evidence,
  ];
}

function roleParagraphs(seat: LaunchSeatId, config: SeatConfigV1, fleet: readonly string[], name: RoleName): string[] {
  if (seat === 'orchestrator') {
    const queue = config.tools.includes('tasks')
      ? [config.runtime === 'agy'
        ? 'Keep worker notices in a triage queue in your own scratch files under /tmp. Answer the owner first, then take one queue item at a time by priority.'
        : 'Keep worker notices in a triage queue with TaskCreate, TaskUpdate, TaskList and TaskGet, as `references/orchestrator.md` §8.1 of repo-harness-issue-flow says: answer the owner first, then take one queue item at a time by priority.']
      : [];
    const dispatch = fleet.length === 0
      ? 'You do not dispatch sub-agents (the Agent tool) for execution. Dispatch work only to seats through Herdr.'
      : `You may call these read-only sub-agents: ${roleList(fleet, name)}. Call no other agent type. Writers and the Codex review run only in Herdr seats: dispatch them to seats through Herdr.`;
    return [
      `You are the orchestrator seat. You hold the coordinator and integrator seats of repo-harness-issue-flow. You dispatch, accept and merge. You do not edit product code, tests or configuration. You do not review a PR that you dispatched; route that review to another seat. You push only the branch of a Codex worker seat handoff: commit its worktree diff with its message and explicit paths only, push the branch, open the PR, and push each fix round. On the owner's explicit word for one release you run the command list of \`bash scripts/release-owner-steps.sh plan <version>\` from the release worktree; the owner confirms the npm login. Without that word you do not tag or publish. You do not delete, or change credentials or permissions yourself.`,
      `${dispatch} When \`publication.acceptance_merge\` is \`on\`, merge only with \`rh publication merge\`. When it is \`off\`, hand each ready PR to the owner.`,
      'Before each dispatch wave, run `rh quota`. Launch each task on the seat its route line names with `rh seats argv <seat>`; state the boundary in the task.',
      'Do not call a blocking question tool (`AskUserQuestion`, `ask_user_question`, or `request_user_input`). When one task waits on the owner, park only that task, ask the owner in plain text (or through the advisor), and end the turn so `hc` messages from other seats keep arriving.',
      ...queue,
    ];
  }
  if (seat === 'advisor') return advisorParagraphs(config, fleet, name);
  if (isCouncilSeat(seat)) {
    return [
      'You are a council seat. Read the issue and the relevant code. Research the architecture, weigh trade-offs, and give your independent judgment. Produce an implementation skeleton with the affected files and interfaces, a delete list, a forbidden-additions list, and checks that prove the result.',
      'Open the proposal with `RECOMMENDATION: <one sentence> — confidence: HIGH|MEDIUM|LOW`. Write the proposal only to the caller-provided scratch file outside every Git repository and worktree, such as `/tmp/rh-council/...`. Do not choose an output path yourself. Do not edit source, commit, push, write to GitHub, or message a worker.',
      fleet.length === 0 ? 'Gather evidence yourself. Do not call sub-agents.'
        : `Use the configured read-only sub-agents ${roleList(fleet, name)} in parallel to gather codebase context in distinct scopes. Keep judgment and synthesis for yourself. Call no other agent type.`,
    ];
  }
  if (isReviewSeat(seat)) {
    // The coordinator publishes the round with `rh review collect` from the receipt the seat prints (#2838).
    return [`You are the ${seat} seat. Perform a read-only review of the assigned PR. Do not edit files, commit, push, or write to GitHub. Report the verdict first, then the findings and evidence.`,
      fleet.length === 0 ? 'You have no sub-agents.' : `You may call these sub-agents: ${roleList(fleet, name)}. Call no other agent type.`];
  }
  return [
    'You are a worker seat. You deliver one issue or PR and report to the orchestrator.',
    fleet.length === 0 ? 'You have no sub-agents.' : `You may call these sub-agents: ${roleList(fleet, name)}. Call no other agent type.`,
    ...(config.runtime === 'codex' ? [
      'As a Codex worker seat in a linked contract worktree, edit files and run checks only. Do not run `git fetch`, `git commit` or `git push`. In your last message, give the commit subject and body, the PR title and body, and the check results. The orchestrator commits your worktree diff with that message and explicit paths only, pushes the branch and opens the PR. It is the head owner of record and pushes each fix round; no other agent pushes to that PR. You remain the content author and answer review threads through the orchestrator.',
    ] : []),
  ];
}

const KEEP_YOURSELF = {
  common_commands: 'The host refuses only common commands for these limits. Keep them yourself.',
  instructions_only: 'These limits are instructions only; the host does not enforce them. Keep them yourself.',
} as const;

/**
 * `fleet` is the list that the brief names.
 * The council brief already defines its file write rule.
 */
function brief(seat: LaunchSeatId, config: SeatConfigV1, fleet: readonly string[], limits: readonly SeatLimitV1[], name: RoleName = role => role): string {
  const kept = (Object.keys(KEEP_YOURSELF) as (keyof typeof KEEP_YOURSELF)[]).flatMap((level) => {
    const groups = limits.flatMap(limit => (limit.level === level && limit.subject !== 'fleet' && limit.subject !== 'hook'
      && !((isCouncilSeat(seat) || (seat === 'orchestrator' && config.runtime === 'agy')) && limit.subject === 'edit') ? [GROUP_TEXT[limit.subject]] : []));
    return groups.length === 0 ? [] : [`${KEEP_YOURSELF[level]} ${groups.join(' ')}`];
  });
  return [...roleParagraphs(seat, config, fleet, name), ...kept].join('\n\n');
}

/**
 * Every launch starts with `env`: it unsets the seat identity that a seat parent passes down, so that only a reset
 * seat launch names a seat and its launch model to the hooks (#1972, #2633), and the Pi role directory, so that only a Pi seat with a fleet names one (#1977). `assignments` follow the unset options.
 */
function seatEnv(assignments: readonly string[]): string[] {
  return ['env', '-u', SEAT_ENV, '-u', SEAT_REPOSITORY_ENV, '-u', SEAT_MODEL_ENV, '-u', SEAT_EFFORT_ENV, '-u', PI_EXTRA_AGENT_DIRS_ENV, ...assignments];
}

function claudeLaunch(seat: LaunchSeatId, config: SeatConfigV1, agentTypes: readonly string[], name: string | undefined, repositoryId: string | undefined, claudeSaving: boolean): Omit<SeatLaunchV1, 'protocol' | 'kind' | 'seat' | 'runtime' | 'source'> {
  const on = (group: SeatTool) => config.tools.includes(group);
  // `--tools` cannot name agent types (`Agent(<type>)` there removes the Agent tool), so a fleet keeps the Agent
  // tool and denies every other known type by name.
  const tools = [...config.tools.flatMap(group => CLAUDE_GROUP_TOOLS[group]), ...(config.fleet.length > 0 ? ['Agent'] : [])];
  const denied = [
    ...(on('shell') ? claudeDeniedGithubCommands(seat, on('gh')).map(command => `Bash(${command} *)`) : []),
    ...(config.fleet.length > 0 ? [...new Set(agentTypes)].filter(type => !config.fleet.includes(type)).sort().map(type => `Agent(${type})`) : []),
  ];
  const limits: SeatLimitV1[] = [
    // A shell can schedule jobs (crontab, launchctl) and an MCP tool may, so the Cron tools are not the only path to this group.
    ...OFF_GROUPS(config).map(group => ({
      subject: group,
      level: group === 'schedule' && (on('shell') || on('mcp')) ? 'instructions_only' : pathLevel(group, 'enforced', on('shell') || on('mcp')),
    })),
    { subject: 'fleet', level: config.fleet.length === 0 ? 'enforced' : 'named_types_only' },
  ];
  const text = brief(seat, config, config.fleet, limits);
  // The Stop hook resets only a session whose env names its seat and repository (#1972). The launch model lets a
  // tier-2 reset see a mode change (#2633).
  const env = [
    // Saving mode must also stop the advisor that a persistent `advisorModel` setting turns on; the absent `--advisor`
    // flag leaves that setting in effect (#3091).
    ...(claudeSaving ? [`${CLAUDE_DISABLE_ADVISOR_ENV}=1`] : []),
    ...(seat === 'orchestrator' && on('tasks') ? [`CLAUDE_CODE_TASK_LIST_ID=${ORCHESTRATOR_TASK_LIST_ID}`] : []),
    ...(isResetSeat(seat) && repositoryId !== undefined ? [`${SEAT_ENV}=${seat}`, `${SEAT_REPOSITORY_ENV}=${repositoryId}`,
      ...(config.model === null ? [] : [`${SEAT_MODEL_ENV}=${config.model}`]), ...(config.effort === null ? [] : [`${SEAT_EFFORT_ENV}=${config.effort}`])] : []),
  ];
  return {
    argv: [
      ...seatEnv(env),
      'claude',
      ...(name === undefined ? [] : ['-n', name]),
      ...(config.model === null ? [] : ['--model', config.model]),
      ...(config.advisor_model === null ? [] : ['--advisor', config.advisor_model]),
      ...(config.effort === null ? [] : ['--effort', config.effort]),
      '--tools', ...tools,
      ...(on('mcp') ? [] : ['--strict-mcp-config']),
      ...(denied.length === 0 ? [] : ['--disallowedTools', ...denied]),
      '--append-system-prompt', text,
    ],
    brief: text,
    limits,
  };
}

function codexLaunch(seat: LaunchSeatId, config: SeatConfigV1): Omit<SeatLaunchV1, 'protocol' | 'kind' | 'seat' | 'runtime' | 'source'> {
  const off = OFF_GROUPS(config);
  const writable = config.tools.includes('edit');
  const network = config.tools.includes('net');
  // The sandbox blocks shell writes without `edit` and shell network access without `net`; `web_search="disabled"` removes web search.
  // No `-c` override disables every inherited MCP server (probe, #1473): `mcp_servers={}` merges into the table, and
  // `mcp_servers.<name>.enabled=false` needs every server name. So an MCP path to `edit` and `net` always stays open.
  const direct = (group: SeatGroup): SeatLimitLevel => (group === 'edit' || group === 'net' ? 'enforced' : 'instructions_only');
  const limits: SeatLimitV1[] = [
    ...off.map(group => ({ subject: group, level: pathLevel(group, direct(group), true) })),
    { subject: 'fleet', level: 'instructions_only' },
  ];
  const text = brief(seat, config, config.fleet, limits);
  return {
    argv: [
      ...seatEnv([]),
      'codex',
      ...(config.model === null ? [] : ['-m', config.model]),
      ...(config.effort === null ? [] : ['-c', `model_reasoning_effort=${JSON.stringify(config.effort)}`]),
      '-s', writable ? 'workspace-write' : 'read-only',
      ...(writable ? ['-c', `sandbox_workspace_write.network_access=${network}`] : []),
      ...(network ? [] : ['-c', 'web_search="disabled"']),
      // A JSON string is a TOML basic string, so `-c` reads it back as the same text.
      '-c', `developer_instructions=${JSON.stringify(text)}`,
    ],
    brief: text,
    limits,
  };
}

function piLaunch(seat: LaunchSeatId, config: SeatConfigV1, roleDirectory: string | undefined, hookExtension: string | undefined, repositoryId: string | undefined): Omit<SeatLaunchV1, 'protocol' | 'kind' | 'seat' | 'runtime' | 'source'> {
  const review = isReviewSeat(seat);
  const excludeEdits = review || isCouncilSeat(seat);
  const excludedTools = [
    ...(excludeEdits ? ['edit', 'write'] : []),
    ...(seat === 'orchestrator' ? ['ask_user_question'] : []),
  ];
  // Pi's denylist blocks the edit/write tools; shell paths stay open. pi-subagents does not refuse a role outside the fleet.
  const limits: SeatLimitV1[] = [
    ...OFF_GROUPS(config).map(group => ({
      subject: group,
      level: excludeEdits && group === 'edit' ? pathLevel(group, 'enforced', true) : 'instructions_only' as const,
    })),
    ...(seatTakesFleet(config) ? [{ subject: 'fleet' as const, level: 'instructions_only' as const }] : []),
    // `--no-extensions` drops the rh hook bridge; the explicit `-e` brings it back, so the PreToolUse routes run in the seat.
    ...(review ? [{ subject: 'hook' as const, level: 'enforced' as const }] : []),
  ];
  const text = brief(seat, config, config.fleet, limits, piRoleName);
  const slash = config.model?.indexOf('/') ?? -1;
  const env = [
    ...(isResetSeat(seat) && repositoryId !== undefined ? [
      `${SEAT_ENV}=${seat}`,
      `${SEAT_REPOSITORY_ENV}=${repositoryId}`,
      ...(config.model === null ? [] : [`${SEAT_MODEL_ENV}=${config.model}`]),
      ...(config.effort === null ? [] : [`${SEAT_EFFORT_ENV}=${config.effort}`]),
    ] : []),
    ...(roleDirectory === undefined ? [] : [`${PI_EXTRA_AGENT_DIRS_ENV}=${roleDirectory}`]),
  ];
  return {
    argv: [...seatEnv(env), 'pi', ...(config.model === null ? [] : ['--provider', config.model.slice(0, slash), '--model', config.model.slice(slash + 1)]),
      ...(config.effort === null ? [] : ['--thinking', config.effort]),
      ...(excludedTools.length > 0 ? ['--exclude-tools', excludedTools.join(',')] : []),
      ...(review ? ['--no-extensions',
      ...(hookExtension === undefined ? [] : ['-e', hookExtension]), '--no-skills',
      '--no-prompt-templates', '--no-context-files', '--no-mcp'] : []), '--append-system-prompt', text],
    brief: text, limits,
  };
}

type RuntimeLaunch = Pick<SeatLaunchV1, 'argv' | 'brief' | 'limits'>;

const AGY_ORCHESTRATOR_COMMAND_PREFIXES: readonly string[] = [
  'rh board attention', 'rh board parents', 'rh board cluster', 'rh board triage-apply',
  'rh board dispatch', 'rh board review', 'rh board merge', 'rh board seats', 'rh board retro',
  'rh board closeout', 'rh board post', 'rh board migrate-dependencies',
  'rh seats argv', 'rh seats launch', 'rh seats council', 'rh seats pool', 'rh seats reset', 'rh seats handoff',
  'rh publication readiness', 'rh publication merge', 'rh review collect', 'rh review publish',
  'rh worktrees start', 'rh worktrees list', 'rh worktrees clean',
  'rh arch projection status', 'rh arch projection slice', 'rh arch projection publish', 'rh quota', 'rh doctor',
  'hc ls', 'hc get', 'hc read', 'hc wait', 'hc send', 'hc label', 'hc file read', 'herdr-app do',
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

// MCP and fleet omission must be confirmed in a native agy session before reporting enforcement.
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
      ...seatEnv(env), input.executable, '--mode', 'accept-edits', '--model', model,
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
    case 'claude': return claudeLaunch(seat, config, claudeAgentTypes, options.paneName, options.repositoryId, options.claudeSaving ?? false);
    case 'codex': return codexLaunch(seat, config);
    case 'pi': return piLaunch(seat, config, options.piRoleDirectory, options.piHookExtension, options.repositoryId);
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

/**
 * The Herdr.app tab of a new seat pane, before the fullness suffix: the orchestrator tab, the worker tab of its parent
 * issue (`other` without one), the council tab, or the review tab. A full tab gets the next number, for example `#1000 2`.
 */
export function seatTabName(seat: LaunchSeatId, parent?: string): string {
  if (parent !== undefined && !POSITIVE.test(parent)) throw new SeatPaneNameError('Tab name: the parent must be a positive decimal integer.');
  if (isCouncilSeat(seat)) return 'council';
  if (isReviewSeat(seat)) return 'review';
  if (isWorkerSeat(seat)) return parent === undefined ? 'other' : `#${parent}`;
  return 'orch';
}
