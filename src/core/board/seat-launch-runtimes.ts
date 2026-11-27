import { isCouncilSeat, isReviewSeat, seatTakesFleet, type LaunchSeatId, type SeatConfigV1, type SeatTool } from './seats-settings';
import { SEAT_EFFORT_ENV, SEAT_ENV, SEAT_MODEL_ENV, SEAT_REPOSITORY_ENV, isResetSeat } from './seat-reset';
import { brief, type RoleName } from './seat-launch-brief';
import type { SeatLaunchV1, SeatLimitLevel, SeatLimitV1 } from './seat-launch';

type SeatGroup = Exclude<SeatTool, 'read'>;
type RuntimeLaunch = Pick<SeatLaunchV1, 'argv' | 'brief' | 'limits'>;

/** A Claude seat in saving mode disables the advisor tool, which overrides the user's persistent `advisorModel` setting (#3091). */
const CLAUDE_DISABLE_ADVISOR_ENV = 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL';

/** GitHub write commands that a missing `gh` group refuses. Other commands, such as `gh api`, still run. */
export const GITHUB_WRITE_COMMANDS = [
  'gh issue close', 'gh issue comment', 'gh issue create', 'gh issue edit',
  'gh pr close', 'gh pr comment', 'gh pr create', 'gh pr edit', 'gh pr merge', 'gh pr review',
  'gh release create', 'git push',
];

/** The only GitHub write commands that an advisor with `gh` granted may run (#3468). */
export const ADVISOR_GH_WRITE_COMMANDS: readonly string[] = [
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

/** `schedule` is Claude-only (Cron tools): Codex and Pi launches report no limit for it. */
const OFF_GROUPS = (config: SeatConfigV1): SeatGroup[] =>
  (['edit', 'shell', 'net', 'tasks', 'schedule', 'mcp', 'gh'] as const).filter(group => !config.tools.includes(group) && (group !== 'schedule' || config.runtime === 'claude'));

/**
 * Every launch starts with `env`: it unsets the seat identity that a seat parent passes down, so that only a reset
 * seat launch names a seat and its launch model to the hooks (#1972, #2633), and the Pi role directory, so that only a Pi seat with a fleet names one (#1977). `assignments` follow the unset options.
 */
export function seatEnv(assignments: readonly string[], piExtraAgentDirsEnv: string): string[] {
  return ['env', '-u', SEAT_ENV, '-u', SEAT_REPOSITORY_ENV, '-u', SEAT_MODEL_ENV, '-u', SEAT_EFFORT_ENV, '-u', piExtraAgentDirsEnv, ...assignments];
}

export function claudeLaunch(
  seat: LaunchSeatId,
  config: SeatConfigV1,
  agentTypes: readonly string[],
  name: string | undefined,
  repositoryId: string | undefined,
  claudeSaving: boolean,
  orchestratorTaskListId: string,
  piExtraAgentDirsEnv: string,
): RuntimeLaunch {
  const on = (group: SeatTool) => config.tools.includes(group);
  // `--tools` cannot name agent types (`Agent(<type>)` there removes the Agent tool), so a fleet keeps the Agent
  // tool and denies every other known type by name. Orchestrator and advisor seats keep `Skill` when `shell` is on so
  // `Skill(herdr)` stays callable without opening a shell-preprocessing side path on read-only seats.
  const tools = [
    ...config.tools.flatMap(group => CLAUDE_GROUP_TOOLS[group]),
    ...(config.fleet.length > 0 ? ['Agent'] : []),
    ...((seat === 'orchestrator' || seat === 'advisor') && on('shell') ? ['Skill'] : []),
  ];
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
    ...(seat === 'orchestrator' && on('tasks') ? [`CLAUDE_CODE_TASK_LIST_ID=${orchestratorTaskListId}`] : []),
    ...(isResetSeat(seat) && repositoryId !== undefined ? [`${SEAT_ENV}=${seat}`, `${SEAT_REPOSITORY_ENV}=${repositoryId}`,
      ...(config.model === null ? [] : [`${SEAT_MODEL_ENV}=${config.model}`]), ...(config.effort === null ? [] : [`${SEAT_EFFORT_ENV}=${config.effort}`])] : []),
  ];
  return {
    argv: [
      ...seatEnv(env, piExtraAgentDirsEnv),
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

export function codexLaunch(seat: LaunchSeatId, config: SeatConfigV1, piExtraAgentDirsEnv: string): RuntimeLaunch {
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
      ...seatEnv([], piExtraAgentDirsEnv),
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

export function piLaunch(
  seat: LaunchSeatId,
  config: SeatConfigV1,
  roleDirectory: string | undefined,
  hookExtension: string | undefined,
  repositoryId: string | undefined,
  piExtraAgentDirsEnv: string,
  roleName: RoleName,
): RuntimeLaunch {
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
  const text = brief(seat, config, config.fleet, limits, roleName);
  const slash = config.model?.indexOf('/') ?? -1;
  const env = [
    ...(isResetSeat(seat) && repositoryId !== undefined ? [
      `${SEAT_ENV}=${seat}`,
      `${SEAT_REPOSITORY_ENV}=${repositoryId}`,
      ...(config.model === null ? [] : [`${SEAT_MODEL_ENV}=${config.model}`]),
      ...(config.effort === null ? [] : [`${SEAT_EFFORT_ENV}=${config.effort}`]),
    ] : []),
    ...(roleDirectory === undefined ? [] : [`${piExtraAgentDirsEnv}=${roleDirectory}`]),
  ];
  return {
    argv: [...seatEnv(env, piExtraAgentDirsEnv), 'pi', ...(config.model === null ? [] : ['--provider', config.model.slice(0, slash), '--model', config.model.slice(slash + 1)]),
      ...(config.effort === null ? [] : ['--thinking', config.effort]),
      ...(excludedTools.length > 0 ? ['--exclude-tools', excludedTools.join(',')] : []),
      ...(review ? ['--no-extensions',
      ...(hookExtension === undefined ? [] : ['-e', hookExtension]), '--no-skills',
      '--no-prompt-templates', '--no-context-files', '--no-mcp'] : []), '--append-system-prompt', text],
    brief: text, limits,
  };
}
