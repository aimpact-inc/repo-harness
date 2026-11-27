/**
 * The four boss commands (#1757, owner M71): preset texts to the advisor seat
 * only. The client sends the id; the server fills `{parent}` and owns the
 * cooldown. The ids are the `RH_CMD_KEYS` of the approved mockup (#1737).
 */
export const ADVISOR_BOSS_COMMANDS = ['rage', 'carrot', 'mine', 'valve'] as const;
export type AdvisorBossCommand = typeof ADVISOR_BOSS_COMMANDS[number];

export const ADVISOR_BOSS_COMMAND_TABLE: Readonly<Record<AdvisorBossCommand, { readonly cooldown_seconds: number; readonly text: string }>> = Object.freeze({
  rage: {
    cooldown_seconds: 30 * 60,
    text: '【大棒】检查 parent #{parent} 下的执行席和审查席：列出超过时限、没有新提交、推送、评论或 CI 变化的席位，每个给一条处理建议（催一下、重派或停掉）。催一下的直接交给编排席；重派和停掉先回复我，等我确认。',
  },
  carrot: {
    cooldown_seconds: 60 * 60,
    text: '【萝卜】按当前席位上限和配额状态，为 parent #{parent} 提出下一批可并行派工的 issue、写入范围和顺序。只回复方案，等我批准后再交给编排席。',
  },
  mine: {
    cooldown_seconds: 30 * 60,
    text: '【排雷】对比 parent #{parent} 在跑和排队任务的写入范围，列出每个冲突（文件、涉及的 issue）和消除冲突的顺序。只回复结果，不派工。',
  },
  valve: {
    cooldown_seconds: 60 * 60,
    text: '【收放】按配额报告（`rh quota`）和 parent #{parent} 的队列长度，提议新的执行席上限（例如 6 → 5）和理由。只回复方案，等我批准。',
  },
});

export function advisorBossCommandText(command: AdvisorBossCommand, parent: number): string {
  return ADVISOR_BOSS_COMMAND_TABLE[command].text.replace('{parent}', String(parent));
}

/** The whole seconds left in the cooldown of one command after its counted sends; 0 when none is inside it. */
export function advisorBossCooldownSeconds(command: AdvisorBossCommand, sentAtMs: readonly number[], nowMs: number): number {
  const window = ADVISOR_BOSS_COMMAND_TABLE[command].cooldown_seconds * 1000;
  return sentAtMs.reduce((remaining, at) => Math.max(remaining, Math.ceil((at + window - nowMs) / 1000)), 0);
}
