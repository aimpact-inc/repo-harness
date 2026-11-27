import { isCouncilSeat, isReviewSeat, type LaunchSeatId, type SeatConfigV1, type SeatTool } from './seats-settings';
import type { SeatLimitV1 } from './seat-launch';

type SeatGroup = Exclude<SeatTool, 'read'>;

const GROUP_TEXT: Readonly<Record<SeatGroup, string>> = {
  edit: 'Do not edit files.',
  shell: 'Do not run shell commands.',
  net: 'Do not use the network.',
  tasks: 'Do not use the task list tools.',
  schedule: 'Do not schedule recurring jobs.',
  mcp: 'Do not use MCP tools.',
  gh: 'Do not write to GitHub.',
};

export type RoleName = (role: string) => string;
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
    'Load the `herdr` skill at session start before any `hc` or `herdr-app` read, send, or pane operation. You may read the processes of worker seats (hc ls, hc get and hc read on seat-labeled terminals) for evidence. You do not send messages or keys to a worker. You report only to the orchestrator.',
    evidence,
    'Start from raw source files and live command output rather than summaries, probe experiment-settleable choices before proposing, distinguish candidate problems by observable signs when a request is ambiguous, and cut unverified citations or links.',
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
      'Load the `herdr` skill at session start before any `hc` or `herdr-app` read, send, or pane operation.',
      'Before each dispatch wave, run `rh quota`. Open each worker or reviewer tab on the seat its route line names with `rh seats launch <seat>` or `rh board dispatch`; state the boundary in the task. When calling `herdr-app do pane.split` directly, resolve an explicit `--pane <id>` with `herdr-app ls` and never rely on `pane.focus` with an untargeted `pane.split`.',
      'Do not call a blocking question tool (`AskUserQuestion`, `ask_user_question`, or `request_user_input`). When one task waits on the owner, park only that task, ask the owner in plain text (or through the advisor), and end the turn so `hc` messages from other seats keep arriving.',
      ...queue,
    ];
  }
  if (seat === 'advisor') return advisorParagraphs(config, fleet, name);
  if (isCouncilSeat(seat)) {
    return [
      'You are a council seat. Read the issue and the relevant code. Research the architecture, weigh trade-offs, and give your independent judgment. Produce an implementation skeleton with the affected files and interfaces, a delete list, a forbidden-additions list, and checks that prove the result. For any borrowed pattern from another system or field, state what carries over and where the analogy breaks, and name at least one external check beyond the writer and reviewer that proves the result.',
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
export function brief(seat: LaunchSeatId, config: SeatConfigV1, fleet: readonly string[], limits: readonly SeatLimitV1[], name: RoleName = role => role): string {
  const kept = (Object.keys(KEEP_YOURSELF) as (keyof typeof KEEP_YOURSELF)[]).flatMap((level) => {
    const groups = limits.flatMap(limit => (limit.level === level && limit.subject !== 'fleet' && limit.subject !== 'hook'
      && !((isCouncilSeat(seat) || (seat === 'orchestrator' && config.runtime === 'agy')) && limit.subject === 'edit') ? [GROUP_TEXT[limit.subject]] : []));
    return groups.length === 0 ? [] : [`${KEEP_YOURSELF[level]} ${groups.join(' ')}`];
  });
  return [...roleParagraphs(seat, config, fleet, name), ...kept].join('\n\n');
}
