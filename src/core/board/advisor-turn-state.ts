import { hcStatusClass, type HcStatusClass } from './desk';

/**
 * The advisor turn as the read-back `status` (the hc status word) proves it.
 * A boss command goes only to a seat whose turn is over: an allow list, so a
 * missing or new status word never sends. With `blocked` the text and Enter
 * could answer a pending prompt.
 */
const ADVISOR_TURN: Readonly<Record<HcStatusClass, 'over' | 'running' | 'unknown'>> = {
  idle: 'over', done: 'over', working: 'running', blocked: 'running', error: 'unknown', unreported: 'unknown', other: 'unknown',
};

export function advisorTurnState(status: string | null): 'over' | 'running' | 'unknown' {
  return ADVISOR_TURN[hcStatusClass(status)];
}
