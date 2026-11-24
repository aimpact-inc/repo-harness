/**
 * PreToolUse.question: deny blocking question modals in the orchestrator seat
 * so one owner wait cannot block asynchronous `hc` notices from other seats (#3466).
 */

import { SEAT_ENV } from '../../core/board/seat-reset';
import type { HookHandlerResult } from './handler-contract';
import { payloadString, type HookPayload } from './hook-input';

const BLOCKING_QUESTION_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ask_user_question',
]);

export const ORCHESTRATOR_QUESTION_DENIAL =
  '[OrchestratorQuestionGuard] Orchestrator seats cannot open blocking question modals. Ask the owner in plain text and end the turn.';

export interface QuestionGuardInput {
  readonly payload: HookPayload;
  readonly env: NodeJS.ProcessEnv;
}

export function runQuestionGuard(input: QuestionGuardInput): HookHandlerResult {
  if (input.env[SEAT_ENV] !== 'orchestrator') return { exitCode: 0 };
  const toolName = payloadString(input.payload, 'tool_name');
  if (!BLOCKING_QUESTION_TOOLS.has(toolName)) return { exitCode: 0 };
  return { exitCode: 2, diagnostics: `${ORCHESTRATOR_QUESTION_DENIAL}\n` };
}
