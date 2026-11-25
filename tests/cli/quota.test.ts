import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildQuotaReport,
  classifyQuotaReading,
  decodeClaudeQuotaCapture,
  decodeCodexRateLimitsResult,
  decodeQuotaReport,
  formatQuotaReport,
  type QuotaReport,
} from '../../src/core/board/quota';
import { effectiveSeatConfig, formatSeatModes, formatSeatRoutes, seatAccount, seatAccountQuotas, selectSeatRoute } from '../../src/core/board/seat-routing';
import { AGY_HYDROGEN_VARIANTS, LOGICAL_MODEL_IDS, MODEL_CATALOG, catalogEntry, isCatalogModelPermittedOnSeat, resolveCatalogRoute } from '../../src/core/board/model-catalog';
import { SHIPPED_MODEL_IDS } from '../../src/core/board/recommended-models';
import { decodeSeatPool, seatRuntimeBlock } from '../../src/core/board/seat-pool';
import { DEFAULT_SEATS_CONFIG, NATIVE_SEATS_PRESET, type CodexCreditMode, type SeatConfigV1 } from '../../src/core/board/seats-settings';
import { decodeAgyQuota } from '../../src/effects/board/quota';
import { agyCatalogScript, type AgyCatalogFixture } from '../helpers/agy-cli-fixture';

const ROOT = join(import.meta.dir, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');
const HOOK_ENTRY = join(ROOT, 'src/cli/hook-entry.ts');
const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const HOUR = 3_600_000;
const fixtures: string[] = [];

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A seven_day window `resetsInHours` before its reset with `used` percent used: elapsed = 100 × (1 − h/168). */
function claude(windows: Record<string, unknown>, observedAt = new Date(NOW).toISOString()) {
  return classifyQuotaReading(decodeClaudeQuotaCapture({ observed_at: observedAt, rate_limits: windows }), NOW);
}
const week = (used: number, resetsInHours: number) => ({ used_percentage: used, resets_at: (NOW + resetsInHours * HOUR) / 1000 });

describe('seat quota routing', () => {
  test.each([
    [80, 'normal', 'worker-opus', false],
    [81, 'saving', 'worker-neon', true],
    [95, 'saving', 'worker-neon', true],
  ] as const)('Claude %s%% used derives %s', (used, mode, selected, reserved) => {
    const seats = { ...DEFAULT_SEATS_CONFIG, orchestrator: { ...DEFAULT_SEATS_CONFIG.orchestrator, model: 'sonnet', effort: 'low' } };
    const account = claude({ seven_day: week(used, 84) });
    const agyNormal = classifyQuotaReading({
      account: 'agy_gemini', source: 'agy_account_usage', observed_at: new Date(NOW).toISOString(), reason: null,
      windows: [{ window: 'weekly', window_minutes: 10080, used_percent: 40, resets_at: (NOW + 84 * HOUR) / 1000, absent: false, reason: null }],
    }, NOW);
    const quota = seatAccountQuotas([account, agyNormal], seats.routing);
    // All three readings are pace-based tight or exhausted. Only the remaining threshold reserves Claude.
    expect(quota.claude.mode).toBe(mode);
    const lines = formatSeatRoutes(seats, quota).split('\n');
    expect(lines.find(line => line.startsWith('route important_deep:'))).toContain(`${reserved ? 'worker-neon-deep' : selected} (`);
    for (const task of ['important_fast', 'frontend']) {
      expect(lines.find(line => line.startsWith(`route ${task}:`))).toContain(`${selected} (`);
    }
    expect(lines).toContain(reserved ? `explorer: haiku high (claude ${account.state === 'exhausted' ? 'exhausted' : mode}; pass model haiku when you call the explorer)` : 'explorer: default');
    expect(effectiveSeatConfig('advisor', DEFAULT_SEATS_CONFIG, quota)).toEqual(DEFAULT_SEATS_CONFIG.advisor);
    expect(effectiveSeatConfig('orchestrator', seats, quota)).toEqual(reserved
      ? { ...seats.orchestrator, model: 'opus', effort: 'high' } : seats.orchestrator);
    if (reserved) expect(lines).toContain(`reviewer: none (claude ${account.state}, reserved for advisor and orchestrator)`);
    expect(lines.some(line => line.includes('fallback'))).toBe(false);
  });

  test.each([81, 95])('Neon keeps important and frontend routes active with Claude %s%% used; agy_saving_below_remaining reserves agy workers for advisor', used => {
    const seats = DEFAULT_SEATS_CONFIG;
    const neon = seats['worker-neon'];
    const neonDeep = seats['worker-neon-deep'];
    const agyReading = (remaining: number) => classifyQuotaReading({
      account: 'agy_gemini', source: 'agy_account_usage', observed_at: new Date(NOW).toISOString(), reason: null,
      windows: [{ window: 'weekly', window_minutes: 10080, used_percent: 100 - remaining, resets_at: (NOW + 84 * HOUR) / 1000, absent: false, reason: null }],
    }, NOW);
    const codexNormal = classifyQuotaReading(decodeCodexRateLimitsResult({
      rateLimits: { primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: (NOW + 84 * HOUR) / 1000 } },
    }, new Date(NOW).toISOString()), NOW);
    const quota = seatAccountQuotas([claude({ seven_day: week(used, 84) }), agyReading(60), codexNormal], seats.routing);
    for (const task of ['important_deep', 'simple_deep'] as const) {
      expect(selectSeatRoute(task, seats, quota)).toMatchObject({ id: 'worker-neon-deep', seat: neonDeep });
    }
    for (const task of ['important_fast', 'frontend'] as const) {
      expect(selectSeatRoute(task, seats, quota)).toMatchObject({ id: 'worker-neon', seat: neon });
    }
    const agySaving = seatAccountQuotas([claude({ seven_day: week(used, 84) }), agyReading(24), codexNormal], seats.routing);
    expect(agySaving.agy_gemini).toMatchObject({ mode: 'saving', state: 'tight', remaining: 24 });
    expect(selectSeatRoute('important_deep', seats, agySaving)).toMatchObject({ id: 'worker-deep' });
    expect(selectSeatRoute('important_fast', seats, agySaving)).toMatchObject({ id: 'worker' });
    expect(selectSeatRoute('simple_deep', seats, agySaving)).toMatchObject({ id: 'worker-deep' });
    expect(selectSeatRoute('frontend', seats, agySaving).line)
      .toBe(`route frontend: none (claude ${used === 95 ? 'exhausted' : 'tight'}, reserved for advisor and orchestrator; agy_gemini tight, reserved for advisor; frontend waits for claude or neon)`);
    expect(formatSeatRoutes(seats, agySaving).split('\n').at(-1))
      .toBe('advisor: advisor (pi magpie/agy-cli/gemini-4-neon xhigh; agy_gemini tight)');

    const agyAtFloor = seatAccountQuotas([claude({ seven_day: week(used, 84) }), agyReading(25), codexNormal], seats.routing);
    expect(agyAtFloor.agy_gemini.mode).toBe('normal');
    expect(selectSeatRoute('frontend', seats, agyAtFloor)).toMatchObject({ id: 'worker-neon' });

    const exhausted = { ...quota, agy_gemini: { state: 'exhausted' as const, mode: 'saving' as const, remaining: 0 } };
    const unavailable = { ...seats, routing: { ...seats.routing, unavailable_pi_providers: ['magpie/agy-cli'] } };
    expect(selectSeatRoute('important_deep', seats, exhausted).id).toBe('worker-deep');
    expect(selectSeatRoute('important_fast', seats, exhausted).id).toBe('worker');
    expect(selectSeatRoute('important_deep', unavailable, quota).id).toBe('worker-deep');
    expect(selectSeatRoute('important_deep', seats, quota, seat => seat !== neonDeep).id).toBe('worker-deep');
    expect(selectSeatRoute('important_deep', seats, quota, undefined, id => id === 'worker-neon-deep' ? 'model unavailable' : null).id).toBe('worker-deep');
    expect(selectSeatRoute('frontend', seats, exhausted).line).toEndWith('agy_gemini exhausted, reserved for advisor; frontend waits for claude or neon)');
    const neonOnly = { ...seats, routing: { ...seats.routing, frontend: ['worker-neon'] as const } };
    expect(selectSeatRoute('frontend', neonOnly, exhausted).line).toBe('route frontend: none (agy_gemini exhausted, reserved for advisor; frontend waits for neon)');
  });

  test('left-to-right routing evaluates routes without jumping to worker-light and reports missing seats', () => {
    const seats = { ...DEFAULT_SEATS_CONFIG, 'worker-light': null,
      routing: { ...DEFAULT_SEATS_CONFIG.routing, important_fast: ['worker-opus', 'worker-neon', 'worker'] as const, simple_fast: ['worker'] as const } };
    const quota = seatAccountQuotas([claude({ seven_day: week(81, 84) })], seats.routing);
    const lines = formatSeatRoutes(seats, quota).split('\n');
    expect(lines).toContain('route important_deep: worker-neon-deep (pi magpie/agy-cli/gemini-4-neon xhigh; agy_gemini unknown); skipped worker-opus: claude tight, reserved for advisor and orchestrator');
    expect(lines).toContain('route important_fast: worker-neon (pi magpie/agy-cli/gemini-4-neon high; agy_gemini unknown); skipped worker-opus: claude tight, reserved for advisor and orchestrator');
    const claudeOnly = { ...seats, routing: { ...seats.routing, frontend: ['worker-opus'] as const } };
    expect(selectSeatRoute('frontend', claudeOnly, quota).line)
      .toBe('route frontend: none (claude tight, reserved for advisor and orchestrator; frontend waits for claude)');
  });

  test('saving reads an important route without a Claude-account seat as stored (#2679)', () => {
    const pi: SeatConfigV1 = { ...DEFAULT_SEATS_CONFIG['worker-light']!, model: 'magpie/anthropic/claude-opus-5-5', effort: 'high' };
    const seats = { ...DEFAULT_SEATS_CONFIG, 'worker-opus': pi, 'worker-light': null,
      routing: { ...DEFAULT_SEATS_CONFIG.routing, important_fast: ['worker-opus', 'worker-neon', 'worker'] as const, simple_fast: ['worker'] as const } };
    const lines = formatSeatRoutes(seats, seatAccountQuotas([claude({ seven_day: week(95, 84) })], seats.routing)).split('\n');
    expect(lines).toContain('route important_deep: worker-opus (pi seats.worker-opus.model high)');
    expect(lines).toContain('route important_fast: worker-opus (pi seats.worker-opus.model high)');
  });

  test('routing skips a Pi seat on an owner-listed unavailable provider and names it (#2769)', () => {
    const pi: SeatConfigV1 = { ...DEFAULT_SEATS_CONFIG['worker-light']!, model: 'magpie/anthropic/claude-opus-5-5', effort: 'high' };
    const seats = { ...DEFAULT_SEATS_CONFIG, 'worker-opus': pi, 'worker-light': pi,
      routing: { ...DEFAULT_SEATS_CONFIG.routing, unavailable_pi_providers: ['magpie/anthropic'],
        important_deep: ['worker-opus', 'worker-deep'] as const, important_fast: ['worker-light'] as const } };
    const lines = formatSeatRoutes(seats, seatAccountQuotas([claude({ seven_day: week(95, 84) })], seats.routing)).split('\n');
    expect(lines.filter(line => line.startsWith('route important_'))).toEqual([
      'route important_deep: worker-deep (pi magpie/codex/gpt-6.2-sol high; chatgpt unknown); skipped worker-opus: pi provider magpie/anthropic unavailable',
      'route important_fast: none (pi provider magpie/anthropic unavailable)',
    ]);
  });

  test('a listed provider matches only at a / boundary, and a Pi seat without a model is unavailable while the list is set (#2769)', () => {
    const pi = (model: string | null): SeatConfigV1 => ({ ...DEFAULT_SEATS_CONFIG['worker-light']!, model });
    const review = { ...pi(null), tools: DEFAULT_SEATS_CONFIG.reviewer.tools };
    const seats = { ...DEFAULT_SEATS_CONFIG, 'worker-deep': pi('magpie/cursorx/m'), 'worker-neon-deep': pi('magpie/cursorx/m'), worker: pi(null), 'worker-light': pi(null),
      gatekeeper: review, reviewer: review, advisor: { ...pi(null), tools: DEFAULT_SEATS_CONFIG.advisor.tools, fleet: DEFAULT_SEATS_CONFIG.advisor.fleet },
      routing: { ...DEFAULT_SEATS_CONFIG.routing, unavailable_pi_providers: ['magpie/cursor'] } };
    const unknown = 'pi default provider unknown: give the seat an explicit model or empty seats.routing.unavailable_pi_providers';
    const lines = formatSeatRoutes(seats, seatAccountQuotas([claude({ seven_day: week(10, 84) })], seats.routing)).split('\n');
    expect(lines.filter(line => /^(route simple_|gatekeeper:|reviewer:|advisor:)/u.test(line))).toEqual([
      'route simple_deep: worker-neon-deep (pi seats.worker-neon-deep.model)',
      `route simple_fast: none (${unknown})`,
      `gatekeeper: none (${unknown})`, `reviewer: none (${unknown})`, `advisor: none (${unknown})`,
    ]);
    const empty = { ...seats, routing: { ...seats.routing, unavailable_pi_providers: [] } };
    expect(formatSeatRoutes(empty, seatAccountQuotas([claude({ seven_day: week(10, 84) })], empty.routing))).toContain('reviewer: reviewer (pi default)');
  });

  test.each([10, 50, 51, 90])('Codex %s%% used preserves configured seat models and efforts', used => {
    const account = classifyQuotaReading(decodeCodexRateLimitsResult({ rateLimits: {
      primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: (NOW + 84 * HOUR) / 1000 },
    } }, new Date(NOW).toISOString()), NOW);
    const seats = { ...DEFAULT_SEATS_CONFIG,
      advisor: { ...DEFAULT_SEATS_CONFIG.advisor, runtime: 'pi' as const, model: 'magpie/codex/gpt-6-astra', effort: null },
      reviewer: { ...DEFAULT_SEATS_CONFIG.reviewer, runtime: 'pi' as const, model: 'magpie/codex/gpt-6.1-sol', effort: 'medium' },
      routing: { ...DEFAULT_SEATS_CONFIG.routing, simple_fast: ['worker'] as const } };
    const quota = seatAccountQuotas([account], seats.routing);
    expect(quota.chatgpt.mode).toBe('normal');
    for (const id of ['worker', 'worker-deep', 'worker-light', 'gatekeeper', 'reviewer', 'advisor'] as const)
      expect(effectiveSeatConfig(id, seats, quota)).toEqual(seats[id]);
    expect(formatSeatModes(seats, quota)).toContain(`codex mode: normal (${100 - used}% left)`);
    expect(formatSeatRoutes(seats, quota)).toContain(`route simple_fast: worker (pi ${seats.worker.model} high`);
  });

  test.each([
    [50, 'hyper', 'claude mode: hyper (50% left >= 50%)', 'fable'],
    [49, 'normal', 'claude mode: normal (49% left >= 20% and < 50%)', 'opus'],
  ] as const)('Claude %s%% left derives %s; only hyper gives a Claude advisor its config entry (#2633)', (left, mode, modeLine, advisor) => {
    const seats = { ...DEFAULT_SEATS_CONFIG,
      advisor: { ...DEFAULT_SEATS_CONFIG.advisor, runtime: 'claude' as const, model: 'fable', effort: 'high', tools: ['mcp', 'net', 'read', 'shell'] as const } };
    const quota = seatAccountQuotas([claude({ seven_day: week(100 - left, 84) })], seats.routing);
    expect(quota.claude.mode).toBe(mode);
    expect(formatSeatModes(seats, quota).split('\n')[0]).toBe(modeLine);
    const lines = formatSeatRoutes(seats, quota).split('\n');
    expect(lines.at(-1)).toBe(`advisor: advisor (claude ${advisor} high)`);
    // The orchestrator entry and the worker routes do not change with hyper.
    expect(effectiveSeatConfig('orchestrator', seats, quota)).toEqual(seats.orchestrator);
    expect(lines.find(line => line.startsWith('route important_deep:'))).toStartWith('route important_deep: worker-opus (claude opus high');
  });

  test.each([
    [50, 81, 'carbon'],
    [49, 10, 'neon'],
    [null, 10, 'neon'],
  ] as const)('agy advisor with %s%% Gemini weekly remaining and %s%% Claude used runs %s', (remaining, claudeUsed, model) => {
    const advisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: 'pi' as const, model: 'magpie/agy-cli/gemini-4-carbon', effort: 'medium' };
    const seats = { ...DEFAULT_SEATS_CONFIG, advisor };
    const gemini = classifyQuotaReading({ account: 'agy_gemini', source: 'agy_account_usage', observed_at: new Date(NOW).toISOString(), reason: null,
      windows: remaining === null ? [] : [{ window: 'weekly', window_minutes: 10080, used_percent: 100 - remaining,
        resets_at: (NOW + 84 * HOUR) / 1000, absent: false, reason: null }],
    }, NOW);
    const quota = seatAccountQuotas([gemini, claude({ seven_day: week(claudeUsed, 84) })], seats.routing);
    expect(effectiveSeatConfig('advisor', seats, quota)).toEqual({ ...advisor, model: `magpie/agy-cli/gemini-4-${model}` });
    const other = { ...advisor, model: 'magpie/codex/gpt-6-astra' };
    expect(effectiveSeatConfig('advisor', { ...seats, advisor: other }, quota)).toEqual(other);
    const nativeCarbon = { ...NATIVE_SEATS_PRESET.advisor, model: 'gemini-4-carbon-high', effort: 'high' };
    expect(effectiveSeatConfig('advisor', { ...seats, advisor: nativeCarbon }, quota)).toEqual(model === 'carbon'
      ? nativeCarbon : { ...nativeCarbon, model: 'gemini-4-neon-high', effort: null });
    const nativeOther = { ...nativeCarbon, model: 'claude-opus-5-5-high' };
    expect(effectiveSeatConfig('advisor', { ...seats, advisor: nativeOther }, quota)).toEqual(nativeOther);
  });

  test('model-catalog maps logical lines to Magpie/Native routes, quota accounts, and permitted planes', () => {
    expect(LOGICAL_MODEL_IDS).toContain('hydrogen');
    expect(LOGICAL_MODEL_IDS).not.toContain('terra');
    expect(DEFAULT_SEATS_CONFIG.worker).toMatchObject({ runtime: 'pi', model: 'magpie/codex/gpt-6.2-sol', effort: 'high' });
    expect(NATIVE_SEATS_PRESET.worker).toMatchObject({ runtime: 'codex', model: 'gpt-6.2-sol', effort: 'high' });
    expect(resolveCatalogRoute('hydrogen', 'native')).toEqual({ runtime: 'agy', model: 'gemini-4-hydrogen-high', effort: null });
    expect(NATIVE_SEATS_PRESET['worker-light']?.model).toBe('gemini-4-hydrogen-high');
    expect(AGY_HYDROGEN_VARIANTS.map(entry => entry.model)).toEqual(['low', 'medium', 'high', 'xhigh'].map(effort => `gemini-4-hydrogen-${effort}`));
    expect(resolveCatalogRoute('hydrogen', 'magpie')).toEqual({ runtime: 'pi', model: 'magpie/agy-cli/gemini-4-hydrogen', effort: 'high' });
    expect(catalogEntry('sol', 'magpie')).toEqual({ runtime: 'pi', model: 'magpie/codex/gpt-6.2-sol' });
    expect(seatAccount({ runtime: 'agy', model: 'gemini-4-hydrogen-high' })).toBe('agy_gemini');
    expect(seatAccount({ runtime: 'agy', model: 'claude-opus-5-5-high' })).toBe('agy_other');
    expect(seatAccount({ runtime: 'agy', model: 'gpt-oss-120b-medium' })).toBe('agy_other');
    expect(seatAccount({ runtime: 'agy', model: null })).toBeNull();
    expect(seatAccount({ runtime: 'pi', model: 'magpie/agy-cli/gemini-4-hydrogen' })).toBe('agy_gemini');
    expect(SHIPPED_MODEL_IDS.has('gemini-4-hydrogen-high')).toBe(true);
    expect(SHIPPED_MODEL_IDS.has('magpie/agy-cli/gemini-4-hydrogen')).toBe(true);
    expect(SHIPPED_MODEL_IDS.has('gpt-6.1-terra')).toBe(false);
    expect(SHIPPED_MODEL_IDS.has('magpie/codex/gpt-6.1-terra')).toBe(false);
    expect(isCatalogModelPermittedOnSeat('worker', catalogEntry('sol', 'magpie'))).toBe(true);
    expect(isCatalogModelPermittedOnSeat('worker', catalogEntry('sol', 'native'))).toBe(true);
    expect(isCatalogModelPermittedOnSeat('worker', catalogEntry('astra', 'native'))).toBe(false);
    expect(isCatalogModelPermittedOnSeat('council', catalogEntry('astra', 'native'))).toBe(true);
    expect(isCatalogModelPermittedOnSeat('council', catalogEntry('fable', 'native'))).toBe(true);
    expect(isCatalogModelPermittedOnSeat('council', catalogEntry('carbon', 'magpie'))).toBe(true);
    expect(isCatalogModelPermittedOnSeat('council', catalogEntry('neon', 'magpie'))).toBe(false);
    expect(isCatalogModelPermittedOnSeat('council', catalogEntry('opus', 'native'))).toBe(false);
    expect(isCatalogModelPermittedOnSeat('worker-light', catalogEntry('hydrogen', 'native'))).toBe(true);
    expect(isCatalogModelPermittedOnSeat('worker-neon-deep', catalogEntry('neon', 'magpie'))).toBe(true);
    expect(isCatalogModelPermittedOnSeat('reviewer', catalogEntry('glm-5.4', 'magpie'))).toBe(true);
    expect(MODEL_CATALOG.astra.planes).toEqual(['council']);
  });

  test('unknown weekly quota has no derived mode; short-window exhaustion still stops Claude', () => {
    const quota = seatAccountQuotas([claude({ five_hour: week(97, 2) })], DEFAULT_SEATS_CONFIG.routing);
    expect(quota.claude).toMatchObject({ mode: 'unknown', state: 'exhausted', remaining: null });
    expect(formatSeatModes(DEFAULT_SEATS_CONFIG, quota)).toBe('claude mode: unknown (weekly quota unavailable)\ncodex mode: unknown (weekly quota unavailable)\nagy_gemini weekly: weekly quota unavailable\nagy_other weekly: weekly quota unavailable');
    expect(formatSeatRoutes(DEFAULT_SEATS_CONFIG, quota)).toContain('route frontend: worker-neon (pi magpie/agy-cli/gemini-4-neon high; agy_gemini unknown); skipped worker-opus: claude exhausted, reserved for advisor and orchestrator');
    const missing = seatAccountQuotas([], DEFAULT_SEATS_CONFIG.routing);
    expect(formatSeatRoutes(DEFAULT_SEATS_CONFIG, missing)).toContain('worker-opus (claude opus high; claude unknown)');
  });

  test('configured thresholds decide modes while other windows keep their exhaustion stop', () => {
    const seats = { ...DEFAULT_SEATS_CONFIG, routing: { ...DEFAULT_SEATS_CONFIG.routing,
      claude_saving_below_remaining: 60, claude_hyper_at_or_above_remaining: 40 } };
    const accounts = [claude({ seven_day: week(50, 84), five_hour: week(95, 2) }),
      classifyQuotaReading(decodeCodexRateLimitsResult({ rateLimits: {
        primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: (NOW + 84 * HOUR) / 1000 },
      } }, new Date(NOW).toISOString()), NOW)];
    const quota = seatAccountQuotas(accounts, seats.routing);
    // Saving wins below its own threshold, also at or above the Claude hyper threshold.
    expect(formatSeatModes(seats, quota)).toBe('claude mode: saving (50% left < 60%)\ncodex mode: normal (60% left)\nagy_gemini weekly: weekly quota unavailable\nagy_other weekly: weekly quota unavailable');
    expect(formatSeatRoutes(seats, quota)).toContain('route frontend: worker-neon (pi magpie/agy-cli/gemini-4-neon high; agy_gemini unknown); skipped worker-opus: claude exhausted, reserved for advisor and orchestrator');
  });

  test.each([
    [undefined, 10, 'worker-deep'], [undefined, 97, 'worker-opus'], [30, 97, 'worker-opus'], [undefined, 80, 'worker-deep'],
  ])('ordered routing with Claude used %s and Codex used %s selects %s', (used, codexUsed, selected) => {
    const seats = { ...DEFAULT_SEATS_CONFIG,
      routing: { ...DEFAULT_SEATS_CONFIG.routing, important_deep: ['worker-opus', 'worker-deep'] as const } };
    const accounts = [claude(used === undefined ? {} : { seven_day: week(used, 84) }),
      classifyQuotaReading(decodeCodexRateLimitsResult({ rateLimits: {
        primary: { usedPercent: codexUsed, windowDurationMins: 10080, resetsAt: (NOW + 84 * HOUR) / 1000 },
      } }, new Date(NOW).toISOString()), NOW)];
    const routes = formatSeatRoutes(seats, seatAccountQuotas(accounts, seats.routing));
    expect(routes).toContain(`route important_deep: ${selected} (`);
    if (codexUsed >= 95) expect(routes).toContain('gatekeeper: none (chatgpt exhausted)');
  });

  test('an exhausted gatekeeper account routes the gatekeeper to a configured fallback; a normal account keeps the gatekeeper', () => {
    const codex = (used: number) => classifyQuotaReading(decodeCodexRateLimitsResult({ rateLimits: {
      primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: (NOW + 84 * HOUR) / 1000 },
    } }, new Date(NOW).toISOString()), NOW);
    const pi: SeatConfigV1 = { ...DEFAULT_SEATS_CONFIG.gatekeeper, runtime: 'pi', model: 'magpie/group/deepseek-v4.1-flash', effort: null };
    const line = (fallback: SeatConfigV1 | null, codexUsed: number, claudeUsed = 10) => {
      const seats = { ...DEFAULT_SEATS_CONFIG, 'gatekeeper-fallback': fallback };
      const quota = seatAccountQuotas([codex(codexUsed), claude({ seven_day: week(claudeUsed, 84) })], seats.routing);
      return formatSeatRoutes(seats, quota).split('\n').find(entry => entry.startsWith('gatekeeper:'));
    };
    expect(line(pi, 97)).toBe('gatekeeper: gatekeeper-fallback (pi magpie/group/deepseek-v4.1-flash; gatekeeper: chatgpt exhausted)');
    expect(line(null, 97)).toBe('gatekeeper: none (chatgpt exhausted)');
    expect(line(DEFAULT_SEATS_CONFIG.reviewer, 97, 97)).toBe('gatekeeper: none (chatgpt exhausted; gatekeeper-fallback: claude exhausted, reserved for advisor and orchestrator)');
    expect(line(pi, 40)).toBe(line(null, 40));
    const routes = formatSeatRoutes(DEFAULT_SEATS_CONFIG, seatAccountQuotas([codex(10)], DEFAULT_SEATS_CONFIG.routing)).split('\n');
    expect(routes.some(entry => entry.startsWith('gatekeeper-deep:'))).toBe(false);
  });

  test('the credit mode admits the seats it names on an exhausted ChatGPT account with credits at or above the floor', () => {
    const codex = (credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null, reached: string | null = null, used = 95) => classifyQuotaReading(decodeCodexRateLimitsResult({ rateLimits: {
      primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: (NOW + 84 * HOUR) / 1000 }, credits, rateLimitReachedType: reached,
    } }, new Date(NOW).toISOString()), NOW);
    const funded = { hasCredits: true, unlimited: false, balance: '34410.83' };
    const seats = { ...DEFAULT_SEATS_CONFIG,
      routing: { ...DEFAULT_SEATS_CONFIG.routing, important_deep: ['worker-opus', 'worker-deep'] as const, simple_fast: ['worker'] as const } };
    const routes = (account: ReturnType<typeof codex>, codex_credit_mode: CodexCreditMode, codex_credit_floor = 0) =>
      formatSeatRoutes(seats, seatAccountQuotas([account], { ...seats.routing, codex_credit_mode, codex_credit_floor }));
    const writer = 'route important_deep: worker-deep (pi magpie/codex/gpt-6.2-sol high; chatgpt exhausted, on credits); skipped worker-opus: claude unknown';
    const gatekeeper = 'gatekeeper: gatekeeper (pi magpie/codex/gpt-6.2-sol high; chatgpt exhausted, on credits)';
    expect(routes(codex(funded), 'off')).toContain('route important_deep: worker-opus (claude opus high; claude unknown)');
    expect(routes(codex(funded), 'off')).toContain('gatekeeper: none (chatgpt exhausted)');
    const review = routes(codex(funded), 'review');
    expect(review).toContain(gatekeeper);
    expect(review).toContain('route important_deep: worker-opus (claude opus high; claude unknown)');
    expect(review).toContain('route simple_fast: none (chatgpt exhausted)');
    for (const line of [writer, gatekeeper]) expect(routes(codex(funded), 'all'), line).toContain(line);
    expect(routes(codex(funded, 'rate_limit_reached'), 'review')).toContain(gatekeeper);
    expect(routes(codex({ hasCredits: false, unlimited: false, balance: '0' }), 'all')).toContain('gatekeeper: none (chatgpt exhausted)');
    expect(routes(codex({ hasCredits: false, unlimited: true, balance: null }), 'all', 2000)).toContain(gatekeeper);
    expect(routes(codex({ hasCredits: true, unlimited: false, balance: null }), 'all', 0)).toBe(routes(codex(funded), 'off'));
    expect(routes(codex(funded), 'all', 34410.83)).toContain(gatekeeper);
    expect(routes(codex(funded), 'all', 34411)).toBe(routes(codex(funded), 'off'));
    expect(routes(codex(funded, null, 40), 'all')).toBe(routes(codex(funded, null, 40), 'off'));
    expect(seatAccountQuotas([codex(funded, 'rate_limit_reached')], { ...seats.routing, codex_credit_mode: 'review' }).chatgpt)
      .toMatchObject({ state: 'exhausted', credits: 'review' });
  });
});

describe('quota classification', () => {
  test('the report decoder preserves a built report and rejects malformed wire shapes', () => {
    const report = buildQuotaReport([
      decodeClaudeQuotaCapture({ observed_at: new Date(NOW).toISOString(), rate_limits: { seven_day: week(50, 84) } }),
      decodeCodexRateLimitsResult({ rateLimits: {
        primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: (NOW + 84 * HOUR) / 1000 },
        planType: 'pro', credits: { hasCredits: true, unlimited: false, balance: '12.50' },
      } }, new Date(NOW).toISOString()),
      decodeCodexRateLimitsResult({}, new Date(NOW).toISOString()),
    ], NOW);
    expect(decodeQuotaReport(report)).toBe(report);
    const nullable = structuredClone(report);
    nullable.accounts[1]!.codex!.credits = null;
    nullable.accounts[1]!.codex!.plan_type = null;
    expect(decodeQuotaReport(nullable)).toBe(nullable);
    const rows: Array<[string, unknown]> = [
      ['protocol', 'other'], ['read_at', null], ['accounts', {}], ['accounts.0', []],
      ['accounts.0.account', 'other'], ['accounts.0.source', 'other'], ['accounts.0.observed_at', 1],
      ['accounts.0.state', 'absent'], ['accounts.0.reason', false], ['accounts.0.windows', {}],
      ['accounts.0.windows.0', null], ['accounts.0.windows.0.window', 1],
      ['accounts.0.windows.0.window_minutes', '300'], ['accounts.0.windows.0.used_percent', NaN],
      ['accounts.0.windows.0.resets_at', 1], ['accounts.0.windows.0.elapsed_percent', false],
      ['accounts.0.windows.0.pace', Infinity], ['accounts.0.windows.0.state', 'other'], ['accounts.0.windows.0.reason', {}],
      ['accounts.1.codex', undefined], ['accounts.1.codex.plan_type', 1], ['accounts.1.codex.credits', []],
      ['accounts.1.codex.credits.has_credits', 'yes'], ['accounts.1.codex.credits.unlimited', 0],
      ['accounts.1.codex.credits.balance', 12], ['accounts.1.codex.rate_limit_reached_type', false],
      ['accounts.1.codex.field_errors', null], ['accounts.1.codex.field_errors', [1]],
    ];
    const at = (value: unknown, path: string[]): Record<string, unknown> => path.reduce((row, key) => (row as Record<string, unknown>)[key], value) as Record<string, unknown>;
    for (const [path, invalid] of rows) {
      const value = structuredClone(report), keys = path.split('.'), key = keys.pop()!;
      at(value, keys)[key] = invalid;
      expect(() => decodeQuotaReport(value), path).toThrow();
    }
    for (const path of ['', 'accounts.0', 'accounts.0.windows.0', 'accounts.1.codex', 'accounts.1.codex.credits']) {
      const keys = path ? path.split('.') : [];
      const fields = Object.keys(at(report, keys));
      for (const key of [...fields, 'extra']) {
        const value = structuredClone(report), row = at(value, keys);
        if (key === 'extra') row.extra = true; else delete row[key];
        expect(() => decodeQuotaReport(value), `${path}.${key}`).toThrow();
      }
    }
    for (const value of [null, [], 'report']) expect(() => decodeQuotaReport(value)).toThrow();
  });

  test.each([
    // [case, seven_day used, hours to reset, window state, account state] — elapsed at 84 h is 50%.
    // five_hour is absent, so the account state is the seven_day state.
    ['used at 95 is exhausted', 95, 84, 'exhausted', 'exhausted'],
    ['headroom under 15 is tight', 86, 160, 'tight', 'tight'],
    ['pace over +15 is tight', 66, 84, 'tight', 'tight'],
    ['pace +15 exactly is normal', 65, 84, 'normal', 'normal'],
    ['pace under -25 with the reset under 24 h is surplus', 60, 12, 'surplus', 'surplus'],
    ['pace under -25 with the reset 24 h or more away is normal', 10, 84, 'normal', 'normal'],
  ] as const)('%s', (_name, used, hours, windowState, accountState) => {
    const account = claude({ seven_day: week(used, hours) });
    expect(account.windows.find(window => window.window === 'seven_day')?.state).toBe(windowState);
    expect(account.state).toBe(accountState);
  });

  test.each([
    // [case, window used, hours to reset, exhaustion line, window state, account state] — elapsed at 84 h is 50%.
    // The pace is used - 50, so a 95% window is over +15 and reads tight below a line of 100.
    ['the default line is 95', 95, 84, undefined, 'exhausted', 'exhausted'],
    ['94% used stays below the default line', 94, 84, undefined, 'tight', 'tight'],
    ['a 95% window is tight at a line of 100', 95, 84, 100, 'tight', 'tight'],
    ['a 100% window is exhausted at a line of 100', 100, 84, 100, 'exhausted', 'exhausted'],
    ['a 50% window is exhausted at the lowest line', 50, 84, 50, 'exhausted', 'exhausted'],
  ] as const)('the exhaustion line decides the state: %s', (_name, used, hours, line, windowState, accountState) => {
    const reading = decodeClaudeQuotaCapture({ observed_at: new Date(NOW).toISOString(), rate_limits: { seven_day: week(used, hours) } });
    const account = line === undefined ? classifyQuotaReading(reading, NOW) : classifyQuotaReading(reading, NOW, line);
    expect(account.windows.find(window => window.window === 'seven_day')?.state).toBe(windowState);
    expect(account.state).toBe(accountState);
  });

  test.each([
    ['positive balance covers an exhausted window', 97, '12.50', false, null, 'all', 0, 'normal', 'available credits cover usage'],
    ['positive balance covers a tight window at the floor', 90, '12.50', false, null, 'all', 12.5, 'normal', 'available credits cover usage'],
    ['unlimited credits cover usage at any floor', 97, null, true, 'rate_limit_reached', 'all', 1000, 'normal', 'unlimited credits cover usage'],
    ['a provider limit still stops finite credits', 97, '12.50', false, 'rate_limit_reached', 'all', 0, 'exhausted', 'rate_limit_reached_type rate_limit_reached'],
    ['zero balance does not cover usage', 97, '0', false, null, 'all', 0, 'exhausted', null],
    ['a balance below the floor does not cover usage', 97, '12.50', false, null, 'all', 13, 'exhausted', null],
    ['review mode leaves the account classification intact', 97, '12.50', false, null, 'review', 0, 'exhausted', null],
    ['off mode leaves the account classification intact', 97, '12.50', false, null, 'off', 0, 'exhausted', null],
  ] as const)('ChatGPT credit classification: %s', (_name, usedPercent, balance, unlimited, reached, mode, floor, state, reason) => {
    const reading = decodeCodexRateLimitsResult({ rateLimits: {
      primary: { usedPercent, windowDurationMins: 300, resetsAt: (NOW + 2 * HOUR) / 1000 },
      secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: (NOW + 84 * HOUR) / 1000 },
      credits: { hasCredits: balance !== null && Number(balance) > 0, unlimited, balance }, rateLimitReachedType: reached,
    } }, new Date(NOW).toISOString());
    reading.credit_routing = { codex_credit_mode: mode, codex_credit_floor: floor };
    expect(classifyQuotaReading(reading, NOW)).toMatchObject({ state, reason, windows: [
      { window: 'primary', state: usedPercent >= 95 ? 'exhausted' : 'tight', used_percent: usedPercent },
      { window: 'secondary', state: 'normal' },
    ] });
  });

  test('a provider-reported limit is exhausted at any exhaustion line', () => {
    const reading = decodeCodexRateLimitsResult({ rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: (NOW + 84 * HOUR) / 1000 }, rateLimitReachedType: 'rate_limit_reached',
    } }, new Date(NOW).toISOString());
    expect(classifyQuotaReading(reading, NOW, 100)).toMatchObject({ state: 'exhausted', reason: 'rate_limit_reached_type rate_limit_reached' });
  });

  test('the worst window wins and each failed field names its reason', () => {
    const fiveHour = { used_percentage: 96, resets_at: (NOW + HOUR) / 1000 };
    expect(claude({ five_hour: fiveHour, seven_day: week(60, 12) }).state).toBe('exhausted');
    expect(claude({ five_hour: { used_percentage: 10, resets_at: (NOW + 4 * HOUR) / 1000 }, seven_day: week(60, 12) }).state).toBe('normal');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, 'seven_day absent'],
      [{ seven_day: null }, 'seven_day absent'],
      [{ seven_day: 'x' }, 'seven_day is not an object'],
      [{ seven_day: { resets_at: week(1, 1).resets_at } }, 'seven_day.used_percentage missing or not 0-100'],
      [{ seven_day: { used_percentage: 101, resets_at: week(1, 1).resets_at } }, 'seven_day.used_percentage missing or not 0-100'],
      [{ seven_day: { used_percentage: 5, resets_at: '1762300000' } }, 'seven_day.resets_at missing or not Unix seconds'],
      [{ seven_day: week(5, -1) }, 'window reset after the reading'],
      [{ seven_day: week(5, 200) }, 'resets_at is beyond the window length'],
    ];
    for (const [windows, reason] of cases) {
      const account = claude(windows);
      expect(account.state).toBe('unknown');
      expect(account.windows.find(window => window.window === 'seven_day')).toMatchObject({ state: 'unknown', reason, elapsed_percent: null, pace: null });
    }
  });

  test('a reading-level failure makes every window unknown', () => {
    const cases: Array<[unknown, string]> = [
      [{ observed_at: new Date(NOW - 31 * 60_000).toISOString(), rate_limits: { seven_day: week(1, 84) } }, 'reading older than 30 min'],
      [{ observed_at: '2026-11-04 12:00', rate_limits: {} }, 'observed_at is not ISO-8601 UTC'],
      [{ observed_at: new Date(NOW).toISOString(), rate_limits: {}, extra: 1 }, 'capture is not { observed_at, rate_limits }'],
      [{ observed_at: new Date(NOW).toISOString(), rate_limits: [] }, 'rate_limits is not an object'],
    ];
    for (const [capture, reason] of cases) {
      const account = classifyQuotaReading(decodeClaudeQuotaCapture(capture), NOW);
      expect(account).toMatchObject({ account: 'claude', state: 'unknown', reason });
      expect(account.windows.every(window => window.state === 'unknown' && window.reason === reason)).toBe(true);
    }
  });

  test('the Codex decoder reads rateLimits only and fails closed per field', () => {
    const window = (used: number, minutes: number | null, hours: number) => ({ usedPercent: used, windowDurationMins: minutes, resetsAt: (NOW + hours * HOUR) / 1000 });
    const result = {
      rateLimits: { primary: window(10, 300, 4), secondary: window(1, 10_080, 167), credits: { hasCredits: true, unlimited: false, balance: '34410.83' }, planType: 'pro', rateLimitReachedType: null },
      rateLimitsByLimitId: { codex: { primary: window(99, 300, 4) } },
    };
    const normal = classifyQuotaReading(decodeCodexRateLimitsResult(result, new Date(NOW).toISOString()), NOW);
    expect(normal).toMatchObject({ account: 'chatgpt', state: 'normal', reason: null, codex: { plan_type: 'pro', credits: { has_credits: true, unlimited: false, balance: '34410.83' }, field_errors: [] } });
    expect(normal.windows.map(w => [w.window, w.state, w.elapsed_percent])).toEqual([['primary', 'normal', 20], ['secondary', 'normal', 0.6]]);
    const reached = decodeCodexRateLimitsResult({ rateLimits: { ...result.rateLimits, rateLimitReachedType: 'rate_limit_reached' } }, new Date(NOW).toISOString());
    expect(classifyQuotaReading(reached, NOW)).toMatchObject({ state: 'exhausted', reason: 'rate_limit_reached_type rate_limit_reached' });
    const broken = decodeCodexRateLimitsResult({ rateLimits: { primary: window(10, null, 4), secondary: null, credits: { hasCredits: 'yes' }, planType: 7 } }, new Date(NOW).toISOString());
    expect(classifyQuotaReading(broken, NOW)).toMatchObject({
      state: 'unknown',
      reason: 'no window of 10080 min',
      windows: [{ window: 'primary', state: 'unknown', reason: 'primary.windowDurationMins missing or not a positive integer' }, { window: 'secondary', state: 'absent', reason: 'secondary absent' }],
      codex: { plan_type: null, credits: null, field_errors: ['planType is not a string or null', 'credits is not { hasCredits, unlimited, balance }'] },
    });
    expect(classifyQuotaReading(decodeCodexRateLimitsResult({ rateLimits: { rateLimitReachedType: 3 } }, new Date(NOW).toISOString()), NOW)).toMatchObject({ state: 'unknown', reason: 'rateLimitReachedType is not a string or null' });
    expect(buildQuotaReport([decodeCodexRateLimitsResult({}, new Date(NOW).toISOString())], NOW).accounts[0]).toMatchObject({ state: 'unknown', reason: 'result.rateLimits is not an object' });
  });

  test('the weekly window decides the account and an absent non-weekly window is absent', () => {
    const stale = new Date(NOW - 31 * 60_000).toISOString();
    const codexWindow = (used: number, minutes: number, hours: number) => ({ usedPercent: used, windowDurationMins: minutes, resetsAt: (NOW + hours * HOUR) / 1000 });
    const codex = (rateLimits: Record<string, unknown>, observedAt = new Date(NOW).toISOString()) => classifyQuotaReading(decodeCodexRateLimitsResult({ rateLimits }, observedAt), NOW);
    const fiveHour = (used: number) => ({ used_percentage: used, resets_at: (NOW + 4 * HOUR) / 1000 });
    const weekly = codexWindow(5, 10_080, 160), short = codexWindow(10, 300, 4);
    const rows: Array<[string, ReturnType<typeof classifyQuotaReading>, string, string | null, Array<[string, string, string | null]>]> = [
      // [case, account report, account state, account reason, [window, state, reason]]
      ['claude weekly absent', claude({ five_hour: fiveHour(10) }), 'unknown', null, [['five_hour', 'normal', null], ['seven_day', 'unknown', 'seven_day absent']]],
      ['claude weekly absent, five_hour exhausted', claude({ five_hour: fiveHour(96) }), 'exhausted', null, [['five_hour', 'exhausted', null], ['seven_day', 'unknown', 'seven_day absent']]],
      ['claude weekly absent, five_hour tight', claude({ five_hour: fiveHour(90) }), 'tight', null, [['five_hour', 'tight', null], ['seven_day', 'unknown', 'seven_day absent']]],
      ['claude weekly malformed, five_hour exhausted', claude({ five_hour: fiveHour(96), seven_day: { used_percentage: 5 } }), 'exhausted', null, [['five_hour', 'exhausted', null], ['seven_day', 'unknown', 'seven_day.resets_at missing or not Unix seconds']]],
      ['claude weekly stale', claude({ seven_day: week(10, 84) }, stale), 'unknown', 'reading older than 30 min', [['five_hour', 'unknown', 'reading older than 30 min'], ['seven_day', 'unknown', 'reading older than 30 min']]],
      ['claude weekly malformed', claude({ five_hour: fiveHour(10), seven_day: { used_percentage: 5 } }), 'unknown', null, [['five_hour', 'normal', null], ['seven_day', 'unknown', 'seven_day.resets_at missing or not Unix seconds']]],
      ['claude non-weekly undefined', claude({ seven_day: week(10, 84) }), 'normal', null, [['five_hour', 'absent', 'five_hour absent'], ['seven_day', 'normal', null]]],
      ['claude non-weekly null', claude({ five_hour: null, seven_day: week(10, 84) }), 'normal', null, [['five_hour', 'absent', 'five_hour absent'], ['seven_day', 'normal', null]]],
      ['claude non-weekly malformed', claude({ five_hour: 'x', seven_day: week(10, 84) }), 'unknown', null, [['five_hour', 'unknown', 'five_hour is not an object'], ['seven_day', 'normal', null]]],
      ['claude non-weekly valid', claude({ five_hour: fiveHour(96), seven_day: week(10, 84) }), 'exhausted', null, [['five_hour', 'exhausted', null], ['seven_day', 'normal', null]]],
      ['codex weekly absent', codex({ primary: short, secondary: null }), 'unknown', 'no window of 10080 min', [['primary', 'normal', null], ['secondary', 'absent', 'secondary absent']]],
      ['codex weekly absent, primary exhausted', codex({ primary: codexWindow(96, 300, 4), secondary: null }), 'exhausted', 'no window of 10080 min', [['primary', 'exhausted', null], ['secondary', 'absent', 'secondary absent']]],
      ['codex weekly absent, primary tight', codex({ primary: codexWindow(90, 300, 4), secondary: null }), 'tight', 'no window of 10080 min', [['primary', 'tight', null], ['secondary', 'absent', 'secondary absent']]],
      ['codex weekly malformed, primary exhausted', codex({ primary: codexWindow(96, 300, 4), secondary: { ...weekly, usedPercent: -1 } }), 'exhausted', null, [['primary', 'exhausted', null], ['secondary', 'unknown', 'secondary.usedPercent missing or not a non-negative integer']]],
      ['codex weekly stale', codex({ primary: weekly, secondary: null }, stale), 'unknown', 'reading older than 30 min', [['primary', 'unknown', 'reading older than 30 min'], ['secondary', 'unknown', 'reading older than 30 min']]],
      ['codex weekly malformed', codex({ primary: { ...weekly, usedPercent: -1 }, secondary: null }), 'unknown', null, [['primary', 'unknown', 'primary.usedPercent missing or not a non-negative integer'], ['secondary', 'absent', 'secondary absent']]],
      ['codex non-weekly undefined', codex({ primary: weekly }), 'normal', null, [['primary', 'normal', null], ['secondary', 'absent', 'secondary absent']]],
      ['codex non-weekly null', codex({ primary: weekly, secondary: null }), 'normal', null, [['primary', 'normal', null], ['secondary', 'absent', 'secondary absent']]],
      ['codex non-weekly malformed', codex({ primary: weekly, secondary: { ...short, resetsAt: 0 } }), 'unknown', null, [['primary', 'normal', null], ['secondary', 'unknown', 'secondary.resetsAt missing or not Unix seconds']]],
      ['codex non-weekly valid', codex({ primary: codexWindow(90, 300, 4), secondary: weekly }), 'tight', null, [['primary', 'tight', null], ['secondary', 'normal', null]]],
    ];
    for (const [name, account, state, reason, windows] of rows) {
      expect([name, account.state, account.reason, account.windows.map(window => [window.window, window.state, window.reason])]).toEqual([name, state, reason, windows]);
    }
    const line = formatQuotaReport(buildQuotaReport([decodeCodexRateLimitsResult({ rateLimits: { primary: weekly, secondary: null } }, new Date(NOW).toISOString())], NOW));
    expect(line).toStartWith('chatgpt: normal | primary normal 5% used, pace +0.2, ');
    expect(line).toContain('; secondary absent | read ');
  });
});

const FAKE_CODEX = `#!${process.execPath}
const fs = require('node:fs');
const mode = process.env.FAKE_CODEX_MODE;
const out = message => process.stdout.write(JSON.stringify(message) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ argv: process.argv.slice(2), message: JSON.parse(line) }) + '\\n');
  const message = JSON.parse(line);
  if (mode === 'exit') process.exit(3);
  if (message.method === 'initialize') {
    out({ method: 'account/updated', params: {} });
    out({ id: message.id, result: { codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos', userAgent: 'fake' } });
  } else if (message.method === 'account/rateLimits/read') {
    if (mode === 'error') return out({ id: message.id, error: { code: -32603, message: 'not logged in' } });
    const primaryUsed = mode === 'primary-exhausted' ? 97 : 50;
    const resetsAt = Math.floor(Date.now() / 1000) + 167 * 3600;
    out({ id: message.id, result: { rateLimits: { primary: { usedPercent: primaryUsed, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600 }, secondary: { usedPercent: mode === 'exhausted' ? 95 : mode === '90-left' ? 10 : 1, windowDurationMins: 10080, resetsAt }, credits: { hasCredits: true, unlimited: false, balance: '34410.83' }, planType: 'pro', rateLimitReachedType: null } } });
  }
});
`;

const fakeAgy = (log: string, mode: string) => `#!${process.execPath}
const args = process.argv.slice(2).join(' ');
require('node:fs').appendFileSync(${JSON.stringify(log)}, args + '\\n');
const mode = ${JSON.stringify(mode)};
const email = ['agy-private-fixture', 'example.invalid'].join('@');
if (args === '--help') { console.log('Usage of agy: --conversation'); process.exit(0); }
if (args === '--version') { console.log('1.5.12'); process.exit(0); }
if (args === 'models') {
  if (mode === 'signed-out') {
    process.stderr.write('Please sign in ' + email);
    process.exit(1);
  }
  process.exit(0);
}
if (args !== '-p /usage --output-format json') process.exit(9);
if (mode === 'api-key' || mode === 'error') {
  process.stderr.write(email);
  process.exit(mode === 'api-key' ? 2 : 3);
}
const hour = 3_600_000;
const bucket = (window, remaining_fraction, hours) => ({
  id: 'private-bucket-id', name: 'private-bucket-label', window, remaining_fraction,
  reset_time: new Date(Date.now() + hours * hour).toISOString(),
});
const group = (name, remaining) => ({ name, description: email,
  buckets: [bucket('weekly', remaining, 84), bucket('5h', 0.9, 2)],
});
const groups = [group('Claude and GPT models', 0.05), group('Gemini Models', 0.62)];
if (mode === 'one') groups.shift();
if (mode === 'three') groups.push(group('Third model group', 0.7));
if (mode === 'unrecognized') groups[0].name = email;
if (mode === 'missing-window') groups[0].buckets.pop();
if (mode === 'gemini-exhausted') {
  groups[0].buckets[0].remaining_fraction = 0.62;
  groups[1].buckets[0].remaining_fraction = 0;
}
console.log(JSON.stringify({ status: 'SUCCESS', account: { email }, command: { name: 'usage', data: { groups } } }));
`;

function fixture(codexMode: string | null, agyMode: string | null = null) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quota-')));
  fixtures.push(root);
  const home = join(root, 'home'), bin = join(root, 'bin'), log = join(root, 'codex.jsonl');
  mkdirSync(join(home, '.repo-harness', 'quota'), { recursive: true });
  mkdirSync(bin);
  if (codexMode !== null) {
    writeFileSync(join(bin, 'codex'), FAKE_CODEX);
    chmodSync(join(bin, 'codex'), 0o755);
  }
  const agyLog = join(root, 'agy.jsonl');
  if (agyMode !== null) {
    writeFileSync(join(bin, 'agy'), fakeAgy(agyLog, agyMode));
    chmodSync(join(bin, 'agy'), 0o755);
  }
  const env = { HOME: home, PATH: bin, TMPDIR: tmpdir(), BUN_INSTALL: join(home, '.bun'),
    FAKE_CODEX_LOG: log, FAKE_CODEX_MODE: codexMode ?? '' };
  return { home, env, log, agyLog };
}

function fixtureMagpie(env: Record<string, string>, output: string, exitCode = 0): string {
  const log = join(env.HOME, 'magpie.json');
  writeFileSync(join(env.PATH, 'magpie'), `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
console.log(${JSON.stringify(output)});
process.exit(${exitCode});
`, { mode: 0o755 });
  return log;
}

function magpieSubscription(nowMs: number) {
  return {
    provider: 'codex', kind: 'subscription', name: 'private-magpie-name', user: 'private-magpie-user@example.invalid',
    readAt: new Date(nowMs).toISOString().replace('Z', '+00:00'),
    balance: '12.50 credits',
    windows: [
      { name: '7 days', used: 97, remaining: 3, resetsAt: new Date(nowMs + 84 * HOUR).toISOString().replace('Z', '+00:00') },
      { name: 'Image generation', used: 0, remaining: 100, text: true, display: 'Unknown', lane: 'images' },
    ],
  };
}

function quota(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [CLI, 'quota', ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 40_000 });
}

function seatsArgv(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [CLI, 'seats', 'argv', ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 40_000 });
}

function configureAgySeats(home: string, advisorModel = 'magpie/agy-cli/gemini-4-carbon'): void {
  const worker = { ...DEFAULT_SEATS_CONFIG.worker, runtime: 'pi', model: 'magpie/agy-cli/gemini-4-neon', fleet: [] };
  const workerDeep = { ...DEFAULT_SEATS_CONFIG['worker-deep'], runtime: 'pi', model: 'magpie/agy-cli/claude-opus-5-5', fleet: [] };
  const advisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: 'pi', model: advisorModel, fleet: [] };
  writeFileSync(join(home, '.repo-harness', 'config.json'), JSON.stringify({ seats: { ...DEFAULT_SEATS_CONFIG, worker, advisor,
    'worker-deep': workerDeep, routing: { ...DEFAULT_SEATS_CONFIG.routing, simple_fast: ['worker', 'worker-deep'] },
  } }));
}

const FAKE_SEAT_CATALOG = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');
const id = basename(process.argv[1]);
const record = (call) => appendFileSync(process.env.SEAT_POOL_LOG, JSON.stringify({ id, call, cwd: process.cwd() }) + '\\n');
const args = process.argv.slice(2).join(' ');
record(args);
const mode = id === 'claude' ? process.env.SEAT_POOL_CLAUDE : process.env.SEAT_POOL_CODEX;
if (args === '--version') { console.log(id === 'claude' ? '99.0.0 (Claude Code)' : 'codex-cli 99.0.0'); process.exit(0); }
if (args === 'app-server --help') { console.log('Usage: codex app-server'); process.exit(0); }
if (args === 'auth status --json') {
  console.log(JSON.stringify({ loggedIn: mode !== 'signed_out', email: 'private-catalog-fixture@example.invalid' }));
  process.exit(mode === 'signed_out' ? 1 : 0);
}
if (args === 'login status') {
  console.error(mode === 'signed_out' ? 'Not logged in' : 'Logged in using ChatGPT');
  process.exit(mode === 'signed_out' ? 1 : 0);
}
if (!args.startsWith('-p --input-format stream-json') && args !== 'app-server --listen stdio://') process.exit(9);
if (mode === 'catalog_error') { console.error('private-catalog-fixture'); process.exit(3); }
const out = (payload) => console.log(JSON.stringify(payload));
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const method = id === 'claude' ? message.request.subtype : message.method;
  record(method);
  switch (method) {
    case 'list_models': out({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success', response: { models: [
      { value: 'opus' }, { value: 'sonnet', disabled: true, description: 'private-catalog-fixture' }, { value: 'private-free-id' },
    ] } } }); break;
    case 'initialize': out({ id: message.id, result: {} }); break;
    case 'initialized': break;
    case 'model/list': out({ id: message.id, result: { data: [{ model: 'gpt-6.2-sol' }, { model: 'gpt-6.2-astra', hidden: true }], nextCursor: null } }); break;
    case 'config/read': out({ id: message.id, result: { config: { model: 'private-free-id' } } }); break;
    default: process.exit(9);
  }
});
`;

function poolFixture(...runtimes: string[]) {
  const f = fixture(null);
  const bin = f.env.PATH;
  const env = { ...f.env, BUN_INSTALL: mkdtempSync(join(f.home, 'bun-install-')), SEAT_POOL_LOG: join(f.home, 'pool-calls.jsonl') };
  for (const id of runtimes) writeFileSync(join(bin, id), FAKE_SEAT_CATALOG, { mode: 0o755 });
  const cache = join(f.home, '.repo-harness', 'seats', 'pool.json');
  const run = (args: string[] = ['--json'], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [CLI, 'seats', 'pool', ...args], { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', timeout: 40_000 });
  return { ...f, env, cache, run };
}

describe('rh seats pool', () => {
  test('Pi uses PATH and the configured provider prefix without running Pi or agy', () => {
    const f = poolFixture('pi');
    const seats = { ...DEFAULT_SEATS_CONFIG, routing: { ...DEFAULT_SEATS_CONFIG.routing, unavailable_pi_providers: ['magpie/group'] } };
    writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats }));
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const pool = decodeSeatPool(JSON.parse(result.stdout));
    expect(pool.runtimes.find(entry => entry.id === 'pi')).toEqual({ id: 'pi', installation: 'available', sign_in: 'not_checked', models: 'not_checked' });
    expect(pool.seats.find(row => row.seat === 'worker')?.pool).toMatchObject([
      { model: 'magpie/agy-cli/gemini-4-neon', account: 'agy_gemini', reason: 'pi on PATH; provider not checked' },
      { model: 'magpie/codex/gpt-6.2-sol', account: 'chatgpt', reason: 'pi on PATH; provider not checked' },
      { model: 'zai/glm-5.3-flash', reason: 'pi on PATH; provider not checked' },
      { model: 'magpie/agy-cli/gemini-4-hydrogen', account: 'agy_gemini', reason: 'pi on PATH; provider not checked' },
    ]);
    expect(pool.seats.find(row => row.seat === 'worker')?.excluded).toContainEqual(expect.objectContaining({ model: 'magpie/group/deepseek-v4.1-flash', status: 'provider_unavailable' }));
    expect(pool.seats.find(row => row.seat === 'advisor')?.pool.map(entry => [entry.model, entry.account])).toEqual([
      ['magpie/agy-cli/gemini-4-neon', 'agy_gemini'], ['magpie/agy-cli/gemini-4-carbon', 'agy_gemini'],
    ]);
    expect(pool.seats.find(row => row.seat === 'worker-neon-deep')?.configured).toMatchObject({ in_pool: true });
    expect(pool.seats.find(row => row.seat === 'worker-light')?.pool).toContainEqual(expect.objectContaining({ model: 'magpie/zcode/GLM-5.4' }));
    expect(result.stdout).not.toContain('signed in');
    expect(existsSync(f.env.SEAT_POOL_LOG)).toBe(false);
    expect(JSON.parse(readFileSync(f.cache, 'utf8'))).toEqual(JSON.parse(result.stdout));
  });

  test.each([
    ['present', 'available'], ['missing', 'not_installed'], ['signed_out', 'signed_out'], ['unsupported', 'unknown'],
    ['timeout', 'unknown'], ['malformed', 'unknown'], ['empty', 'unknown'],
  ] as const)('agy projects one native catalog observation into the advisor pool (%s)', (branch, expected) => {
      const f = poolFixture();
      const free = 'private-free-id';
      const model = 'gemini-4-neon-high';
      const advisor = { runtime: 'agy', model: free, effort: null, advisor_model: null, fleet: [], tools: ['net', 'read', 'shell'] } as const;
      writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats: { ...DEFAULT_SEATS_CONFIG, advisor } }));
      const catalogs: Record<typeof branch, AgyCatalogFixture> = {
        present: [{ id: 'gemini-4-neon', efforts: ['high'] }, free], missing: [], signed_out: 'signed_out',
        unsupported: [], timeout: 'timeout', malformed: 'malformed', empty: [],
      };
      if (branch !== 'missing') writeFileSync(join(f.env.PATH, 'agy'), `#!${process.execPath}
${agyCatalogScript(catalogs[branch], branch === 'unsupported' ? '1.4.9' : undefined)}
`, { mode: 0o755 });
      const fresh = f.run();
      expect(fresh.status, fresh.stderr).toBe(0);
      const report = decodeSeatPool(JSON.parse(fresh.stdout));
      const row = report.seats.find(item => item.seat === 'advisor')!;
      const high = [...row.pool, ...row.excluded].find(entry => entry.model === model)!;
      expect(high.status).toBe(expected);
      if (branch === 'present') {
        expect(high.account).toBe('agy_gemini');
        expect(effectiveSeatConfig('advisor', { ...DEFAULT_SEATS_CONFIG, advisor }, seatAccountQuotas([], DEFAULT_SEATS_CONFIG.routing))).toEqual(advisor);
        expect(row.excluded.find(entry => entry.model === 'gemini-4-neon-low')?.status).toBe('not_listed');
      }
      const cache = readFileSync(f.cache, 'utf8');
      for (const output of [fresh.stdout, fresh.stderr, cache]) {
        expect(output).not.toContain(free);
        expect(output).not.toContain('private-catalog-text');
      }
      expect(row.configured).toMatchObject({ table_entry: false, in_pool: false, field: 'seats.advisor.model' });
    }, 30_000,
  );

  test('Claude and Codex use only OAR installation, sign-in and catalogs and keep table order', () => {
    const f = poolFixture('claude', 'codex');
    const seats = { ...DEFAULT_SEATS_CONFIG, worker: { ...DEFAULT_SEATS_CONFIG.worker, runtime: 'codex' as const, model: 'private-free-id' } };
    const config = JSON.stringify({ seats });
    const configPath = join(f.home, '.repo-harness', 'config.json');
    writeFileSync(configPath, config);
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const report = decodeSeatPool(JSON.parse(result.stdout));
    const row = report.seats.find(entry => entry.seat === 'worker')!;
    expect(row.pool.map(entry => [entry.runtime, entry.model, entry.account])).toEqual([
      ['claude', 'opus', 'claude'], ['codex', 'gpt-6.2-sol', 'chatgpt'],
    ]);
    expect(row.excluded.map(entry => [entry.model, entry.status])).toEqual([
      ['magpie/agy-cli/gemini-4-neon', 'not_installed'],
      ['gemini-4-neon-low', 'not_installed'], ['gemini-4-neon-medium', 'not_installed'],
      ['gemini-4-neon-high', 'not_installed'], ['gemini-4-neon-xhigh', 'not_installed'],
      ['magpie/codex/gpt-6.2-sol', 'not_installed'],
      ['zai/glm-5.3-flash', 'not_installed'], ['magpie/group/deepseek-v4.1-flash', 'not_installed'],
      ['magpie/agy-cli/gemini-4-hydrogen', 'not_installed'],
      ...['low', 'medium', 'high', 'xhigh'].map(effort => [`gemini-4-hydrogen-${effort}`, 'not_installed']),
    ]);
    expect(row.configured).toEqual({ field: 'seats.worker.model', table_entry: false, in_pool: false, reason: 'outside_recommendations' });
    const calls = readFileSync(f.env.SEAT_POOL_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map(({ id, call }) => `${id} ${call.startsWith('-p ') ? '-p' : call}`)).toEqual([
      'claude --version', 'claude auth status --json', 'claude -p', 'claude list_models',
      'codex app-server --help', 'codex --version', 'codex login status', 'codex app-server --listen stdio://',
      'codex initialize', 'codex initialized', 'codex model/list', 'codex config/read',
    ]);
    expect(new Set(calls.map(({ cwd }) => cwd)).size).toBe(1);
    expect(calls[0].cwd).toContain('/rh-seat-pool-');
    const human = f.run([]);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain('seats.worker.model');
    for (const output of [result.stdout, result.stderr, human.stdout, human.stderr, readFileSync(f.cache, 'utf8')]) {
      expect(output).not.toContain('private-free-id');
      expect(output).not.toContain('private-catalog-fixture');
    }
    expect(readFileSync(configPath, 'utf8')).toBe(config);
  });

  test('a new probe replaces a stale signed-out result and maps a failed catalog to unknown', () => {
    const f = poolFixture('claude', 'codex');
    const negative = f.run(['--json'], { SEAT_POOL_CLAUDE: 'signed_out', SEAT_POOL_CODEX: 'signed_out' });
    expect(negative.status, negative.stderr).toBe(0);
    const old = decodeSeatPool(JSON.parse(negative.stdout));
    const oldRow = old.seats.find(row => row.seat === 'orchestrator')!;
    expect(oldRow.pool).toEqual([]);
    expect(oldRow.excluded[0]).toMatchObject({ model: 'opus', status: 'signed_out', hint: 'Run claude auth login.' });
    expect(readFileSync(f.env.SEAT_POOL_LOG, 'utf8')).not.toMatch(/list_models|model\/list/u);
    writeFileSync(f.cache, JSON.stringify({ ...old, collected_at: '2026-11-01T00:00:00.000Z' }));
    const fresh = f.run(['--json'], { SEAT_POOL_CODEX: 'catalog_error' });
    expect(fresh.status, fresh.stderr).toBe(0);
    const current = decodeSeatPool(JSON.parse(fresh.stdout));
    expect(current.seats.find(row => row.seat === 'orchestrator')?.configured).toMatchObject({ table_entry: true, in_pool: true, reason: 'available' });
    expect(current.seats.find(row => row.seat === 'worker')?.excluded).toContainEqual(expect.objectContaining({ model: 'gpt-6.2-sol', status: 'unknown' }));
    expect(current.collected_at).not.toBe('2026-11-01T00:00:00.000Z');
    expect(JSON.parse(readFileSync(f.cache, 'utf8'))).toEqual(JSON.parse(fresh.stdout));
    expect(fresh.stderr).not.toContain('private-catalog-fixture');
  });

  test('a cache path with an unrelated file leaves the file intact and still reports the fresh pool', () => {
    const f = poolFixture();
    mkdirSync(join(f.home, '.repo-harness', 'seats'));
    const ownerFile = JSON.stringify({ text: 'unrelated fixture' });
    writeFileSync(f.cache, ownerFile);
    const fresh = f.run();
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(fresh.stderr).toContain('seat_pool_cache_write_failed');
    expect(decodeSeatPool(JSON.parse(fresh.stdout)).seats.every(row => row.pool.length === 0)).toBe(true);
    expect(readFileSync(f.cache, 'utf8')).toBe(ownerFile);
  });
});

function launchSeat(seat: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [CLI, 'seats', 'launch', seat, '--space', 'sp1', '--cwd', ROOT, '--task', 'Test launch', '--json'],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 40_000 });
}

function fixtureHerdr(env: Record<string, string>, log: string): void {
  writeFileSync(join(env.PATH!, 'herdr-app'), `#!${process.execPath}
if (process.argv[2] === 'ls') {
  console.log(JSON.stringify({ spaces: [{ id: 'sp1', name: 'sp1', folder: null, active: true, tabs: [] }] }));
  process.exit(0);
}
require('node:fs').writeFileSync(${JSON.stringify(log)}, process.argv[4]);
console.log(JSON.stringify({ tab: 'tb1', terminal: 't9' }));
`, { mode: 0o755 });
}

describe('rh seats launch availability', () => {
  test('catalog auth loss blocks the runtime before the quota-selected model check', () => {
    expect(seatRuntimeBlock('worker', 'codex', [{
      id: 'codex', installation: 'available', sign_in: 'logged_in', models: 'unauthenticated', listed: [],
    }])).toContain('Runtime signed out.');
  });
  test('a missing default runtime reports a redacted pool hint and starts no tab', () => {
    const f = poolFixture('pi');
    const seats = { ...DEFAULT_SEATS_CONFIG, worker: { ...DEFAULT_SEATS_CONFIG.worker, runtime: 'codex' as const, model: 'gpt-6.2-sol' } };
    writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats }));
    const tab = join(f.home, 'tab.json');
    fixtureHerdr(f.env, tab);
    const refused = launchSeat('worker', f.env);
    expect([refused.status, refused.stdout, JSON.parse(refused.stderr)]).toEqual([1, '', {
      ok: false, error: 'seat_provider_unavailable',
      message: expect.stringMatching(/The worker seat cannot launch\. codex: Runtime not found on PATH\. See seats\.worker\.model\..*Available pool for worker: pi magpie\/agy-cli\/gemini-4-neon, pi magpie\/codex\/gpt-6\.2-sol, pi zai\/glm-5\.3-flash, pi magpie\/group\/deepseek-v4\.1-flash, pi magpie\/agy-cli\/gemini-4-hydrogen/u),
    }]);
    expect(existsSync(tab)).toBe(false);
    expect(existsSync(f.env.SEAT_POOL_LOG)).toBe(false);
  });

  test.each([
    ['codex', 'gpt-6.1-terra', 'seats.worker.model uses retired model gpt-6.1-terra. Choose another worker model such as gpt-6.2-sol.'],
    ['pi', 'magpie/codex/gpt-6.1-terra', 'seats.worker.model uses retired model magpie/codex/gpt-6.1-terra. Choose another worker model such as magpie/codex/gpt-6.2-sol.'],
  ] as const)('rh seats launch refuses a saved retired %s Terra model before probing or opening a tab', (runtime, model, expectedMessage) => {
    const f = poolFixture('codex', 'pi');
    const seats = { ...DEFAULT_SEATS_CONFIG, worker: { ...DEFAULT_SEATS_CONFIG.worker, runtime, model } };
    writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats }));
    const tab = join(f.home, 'tab.json');
    fixtureHerdr(f.env, tab);
    const refused = launchSeat('worker', f.env);
    expect([refused.status, refused.stdout, JSON.parse(refused.stderr)]).toEqual([1, '', {
      ok: false, error: 'seat_model_invalid', message: expectedMessage,
    }]);
    expect(existsSync(tab)).toBe(false);
    expect(existsSync(f.env.SEAT_POOL_LOG)).toBe(false);
  });

  test('a signed-out runtime refuses a stored free id before quota or tab start', () => {
    const f = poolFixture('codex');
    const free = 'private-free-id';
    const seats = { ...DEFAULT_SEATS_CONFIG, worker: { ...DEFAULT_SEATS_CONFIG.worker, runtime: 'codex' as const, model: free } };
    writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats }));
    const tab = join(f.home, 'tab.json');
    fixtureHerdr(f.env, tab);
    const refused = launchSeat('worker', { ...f.env, SEAT_POOL_CODEX: 'signed_out' });
    expect([refused.status, refused.stdout]).toEqual([1, '']);
    expect(JSON.parse(refused.stderr)).toEqual({ ok: false, error: 'seat_provider_unavailable',
      message: expect.stringMatching(/codex: Runtime signed out\. See seats\.worker\.model\. Run codex login\. Available pool for worker: empty\./u) });
    expect(refused.stderr).not.toContain(free);
    expect(existsSync(tab)).toBe(false);
    const calls = readFileSync(f.env.SEAT_POOL_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line).call);
    expect(calls).toEqual(['app-server --help', '--version', 'login status']);
  });

  test('launch checks the quota-selected advisor model when the configured model is absent from the catalog', () => {
    const f = poolFixture('claude');
    const seats = { ...DEFAULT_SEATS_CONFIG, advisor: { ...DEFAULT_SEATS_CONFIG.advisor, runtime: 'claude' as const, model: 'fable', effort: 'high' } };
    writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats }));
    const catalog = f.run();
    expect(catalog.status, catalog.stderr).toBe(0);
    expect(decodeSeatPool(JSON.parse(catalog.stdout)).seats.find(row => row.seat === 'advisor')?.configured)
      .toMatchObject({ in_pool: false, reason: 'not_listed' });
    const tab = join(f.home, 'tab.json');
    fixtureHerdr(f.env, tab);
    const result = launchSeat('advisor', f.env);
    expect(result.status, result.stderr).toBe(0);
    const argv = JSON.parse(readFileSync(tab, 'utf8')).argv as string[];
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
  });

  test('launch ignores a stale negative and sends the unchanged free id only to the tab', () => {
    const f = poolFixture('claude');
    const free = 'private-free-id';
    const seats = { ...DEFAULT_SEATS_CONFIG, orchestrator: { ...DEFAULT_SEATS_CONFIG.orchestrator, model: free } };
    writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats }));
    const negative = f.run(['--json'], { SEAT_POOL_CLAUDE: 'signed_out' });
    expect(negative.status, negative.stderr).toBe(0);
    const stale = JSON.stringify({ ...decodeSeatPool(JSON.parse(negative.stdout)), collected_at: '2026-11-01T00:00:00.000Z' });
    writeFileSync(f.cache, stale);
    const tab = join(f.home, 'tab.json');
    fixtureHerdr(f.env, tab);
    const result = launchSeat('orchestrator', f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, model: 'seats.orchestrator.model', placement: { tab: 'tb1' } });
    expect(result.stdout + result.stderr).not.toContain(free);
    expect(JSON.parse(readFileSync(tab, 'utf8')).argv).toContain(free);
    expect(readFileSync(f.cache, 'utf8')).toBe(stale);
  });

  test.each(['default', 'override'])('a Magpie launch checks the %s agent path without executing Pi', (source) => {
    const f = poolFixture('pi');
    const seats = { ...DEFAULT_SEATS_CONFIG, 'worker-light': { ...DEFAULT_SEATS_CONFIG['worker-light']!, model: 'magpie/group/deepseek-v4.1-flash' } };
    writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats }));
    const agentDirectory = source === 'override' ? join(f.home, 'pi-override') : join(f.home, '.pi', 'agent');
    const env = source === 'override' ? { ...f.env, PI_CODING_AGENT_DIR: agentDirectory } : f.env;
    const tab = join(f.home, 'tab.json');
    fixtureHerdr(env, tab);
    const refused = launchSeat('worker-light', env);
    expect([refused.status, refused.stdout]).toEqual([1, '']);
    expect(JSON.parse(refused.stderr)).toMatchObject({ error: 'seat_provider_unavailable',
      message: expect.stringMatching(/Magpie extension missing.*extensions\/magpie\.ts.*PI_CODING_AGENT_DIR.*seats\.routing\.unavailable_pi_providers.*seats\.worker-light\.model/u) });
    expect(existsSync(tab)).toBe(false);

    const shell = join(f.home, 'shell');
    writeFileSync(shell, "#!/bin/sh\nprintf '%s\\n' 'RESULT[a smile :)' 'then a span `echo INJECTED-BY-BACKTICK`]'\n", { mode: 0o755 });
    mkdirSync(join(agentDirectory, 'extensions'), { recursive: true });
    writeFileSync(join(agentDirectory, 'extensions', 'magpie.ts'), 'throw new Error("metadata only");');
    writeFileSync(join(agentDirectory, 'settings.json'), JSON.stringify({ shellPath: shell }));
    const result = launchSeat('worker-light', env);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(tab, 'utf8')).argv).toContain('magpie');
    expect(existsSync(f.env.SEAT_POOL_LOG)).toBe(false);
  });
});

describe('rh quota', () => {
  test('the OAR quota boundary discards current and last account identity', () => {
    const observedAt = new Date(NOW).toISOString();
    const windows = ['Gemini Models', 'Claude and GPT models'].flatMap(name => [5, 168].map(hours => ({
      label: 'quota', scope: { kind: 'models' as const, name }, durationMs: hours * HOUR, usedRatio: 0.25,
    })));
    const available = { kind: 'available', rateLimited: false, windows } as const;
    const account = { email: 'account-identity@example.invalid', plan: 'private-plan' };
    const withIdentity = { ...available, ...account, account };
    const readings = decodeAgyQuota(withIdentity, observedAt);
    expect(readings).toEqual(decodeAgyQuota(available, observedAt));
    expect(readings.map(reading => reading.windows.map(window => window.used_percent))).toEqual([[25, 25], [25, 25]]);
    const signedOut = decodeAgyQuota({ kind: 'reauth_required', lastAccount: account }, observedAt);
    expect(signedOut.map(reading => reading.reason)).toEqual(['agy is signed out', 'agy is signed out']);
    expect(JSON.stringify([readings, signedOut])).not.toMatch(/account-identity|private-plan|lastAccount/);
  });

  test('reads both agy groups once through OAR and publishes only the fixed accounts and windows', () => {
    const f = fixture(null, 'two');
    configureAgySeats(f.home);
    const result = quota(['--json'], f.env);
    expect(result.status, result.stderr).toBe(0);
    const report = decodeQuotaReport(JSON.parse(result.stdout));
    expect(report.accounts.slice(2)).toMatchObject([
      { account: 'agy_gemini', source: 'agy_account_usage', state: 'normal', reason: null, windows: [
        { window: '5h', window_minutes: 300, used_percent: 10 }, { window: 'weekly', window_minutes: 10080, used_percent: 38 },
      ] },
      { account: 'agy_other', source: 'agy_account_usage', state: 'exhausted', reason: null, windows: [
        { window: '5h', window_minutes: 300, used_percent: 10 }, { window: 'weekly', window_minutes: 10080, used_percent: 95 },
      ] },
    ]);
    expect(readFileSync(f.agyLog, 'utf8').trim().split('\n')).toEqual(['--help', '--version', 'models', '-p /usage --output-format json']);
    const text = quota([], f.env);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain('agy_gemini weekly: 62% left\nagy_other weekly: 5% left');
    expect(text.stdout).toContain('route simple_fast: worker (pi magpie/agy-cli/gemini-4-neon high; agy_gemini normal)');
    expect(text.stdout).toContain('route simple_deep: worker-neon-deep (pi magpie/agy-cli/gemini-4-neon xhigh; agy_gemini normal)');
    expect(text.stdout).toContain('advisor: advisor (pi magpie/agy-cli/gemini-4-carbon xhigh; agy_gemini normal)');
    expect(result.stdout + result.stderr + text.stdout + text.stderr).not.toMatch(/agy-private-fixture|private-bucket|Gemini Models|Claude and GPT models/);
  });

  test.each([
    [null, 'agy not installed'],
    ['signed-out', 'agy is signed out'],
    ['api-key', 'agy /usage exited 2 without account quota'],
    ['error', 'agy quota reader failed'],
    ['one', 'agy quota expected 2 model groups, found 1'],
    ['three', 'agy quota expected 2 model groups, found 3'],
    ['unrecognized', 'agy quota model groups are unrecognized'],
    ['missing-window', 'agy quota expected a weekly and a 5h window for each model group'],
  ])('agy mode %p reports unknown for both accounts with its reason and exits 0', (mode, reason) => {
    const f = fixture(null, mode);
    configureAgySeats(f.home);
    const result = quota([], f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.split('\n').filter(line => /^agy_\w+:/.test(line))).toEqual([
      `agy_gemini: unknown | ${reason}`, `agy_other: unknown | ${reason}`,
    ]);
    expect(result.stdout).toContain('advisor: advisor (pi magpie/agy-cli/gemini-4-neon xhigh; agy_gemini unknown)');
    expect(result.stdout + result.stderr).not.toContain('agy-private-fixture');
    if (mode === 'signed-out') expect(readFileSync(f.agyLog, 'utf8').trim().split('\n')).toEqual(['--help', '--version', 'models']);
  });

  test('routes past exhausted Gemini for workers and stops the advisor projected onto Gemini', () => {
    const f = fixture(null, 'gemini-exhausted');
    configureAgySeats(f.home, 'magpie/agy-cli/claude-opus-5-5');
    const result = quota([], f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('route simple_fast: worker-deep (pi seats.worker-deep.model high; agy_other normal); skipped worker: agy_gemini exhausted');
    expect(result.stdout).toContain('advisor: none (agy_gemini exhausted)');
    const launch = seatsArgv(['advisor', '--json'], f.env);
    expect(launch.status, launch.stderr).toBe(1);
    expect(JSON.parse(launch.stderr)).toMatchObject({ error: 'seat_quota_exhausted', message: expect.stringContaining('agy_gemini account is exhausted') });
  });

  test('does not start agy when no configured seat uses it', () => {
    const f = fixture(null, 'two');
    const seats = { ...DEFAULT_SEATS_CONFIG,
      advisor: { ...DEFAULT_SEATS_CONFIG.advisor, runtime: 'claude' as const, model: 'fable', effort: 'high' },
      'worker-neon': { ...DEFAULT_SEATS_CONFIG['worker-neon'], runtime: 'claude' as const, model: 'opus', effort: 'high' },
      'worker-neon-deep': null,
      routing: { ...DEFAULT_SEATS_CONFIG.routing,
        important_deep: ['worker-opus', 'worker-neon', 'worker-deep'], simple_deep: ['worker-neon', 'worker-deep'] },
    };
    writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats }));
    const result = quota(['--json'], f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(decodeQuotaReport(JSON.parse(result.stdout)).accounts.map(account => account.account)).toEqual(['claude', 'chatgpt']);
    expect(existsSync(f.agyLog)).toBe(false);
  });
  test('the stored exhaustion line decides whether a 95% window blocks the gatekeeper (#2909)', () => {
    const f = fixture('exhausted');
    // An absent seats section reads as the defaults, so the host line is 95: this window is exhausted and refuses.
    expect((JSON.parse(quota(['--json'], f.env).stdout) as QuotaReport).accounts[1]).toMatchObject({ state: 'exhausted' });
    const blocked = seatsArgv(['gatekeeper', '--pr', '2262', '--json'], f.env);
    expect([blocked.status, JSON.parse(blocked.stderr).error]).toEqual([1, 'seat_quota_exhausted']);
    const gatekeeper = { ...DEFAULT_SEATS_CONFIG.gatekeeper, runtime: 'codex' as const, model: 'gpt-6.2-sol' };
    writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats: { ...DEFAULT_SEATS_CONFIG, gatekeeper,
      routing: { ...DEFAULT_SEATS_CONFIG.routing, exhausted_at_or_above_used: 100 } } }));
    const report = JSON.parse(quota(['--json'], f.env).stdout) as QuotaReport;
    // The same 95% weekly window is now tight: over the headroom and pace rules, below the exhaustion line.
    expect(report.accounts[1]?.state).toBe('tight');
    expect(report.accounts[1]?.windows.find(window => window.window === 'secondary')).toMatchObject({ state: 'tight', used_percent: 95 });
    const launched = seatsArgv(['gatekeeper', '--pr', '2262', '--json'], f.env);
    expect(launched.status, launched.stderr).toBe(0);
    expect(JSON.parse(launched.stdout).argv).toContain('gpt-6.2-sol');
  });

  test('reads the capture file and one app-server rateLimits read, grouped by account', () => {
    const f = fixture('90-left');
    writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats: { ...DEFAULT_SEATS_CONFIG,
      'worker-deep': { ...DEFAULT_SEATS_CONFIG['worker-deep'], runtime: 'pi', model: 'magpie/codex/gpt-6.2-sol', effort: 'medium' },
      'worker-neon': { ...DEFAULT_SEATS_CONFIG['worker-neon'], runtime: 'claude', model: 'opus', effort: 'high' },
      'worker-neon-deep': null,
      advisor: { ...DEFAULT_SEATS_CONFIG.advisor, runtime: 'pi', model: 'magpie/codex/gpt-6.2-sol', effort: null },
      routing: { ...DEFAULT_SEATS_CONFIG.routing, important_deep: ['worker-opus', 'worker-neon', 'worker-deep'], simple_deep: ['worker-deep'], simple_fast: ['worker'] },
    } }));
    const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;
    writeFileSync(join(f.home, '.repo-harness', 'quota', 'claude.json'), JSON.stringify({ observed_at: new Date().toISOString(), rate_limits: {
      five_hour: { used_percentage: 97, resets_at: resetsAt }, seven_day: { used_percentage: 95, resets_at: resetsAt },
    } }));
    const result = quota(['--json'], f.env);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as QuotaReport;
    expect(decodeQuotaReport(report)).toBe(report);
    expect(report.accounts.map(account => [account.account, account.state])).toEqual([['claude', 'exhausted'], ['chatgpt', 'normal']]);
    expect(report.accounts[1]).toMatchObject({ source: 'codex_app_server', codex: { plan_type: 'pro', credits: { balance: '34410.83' } } });
    const calls = readFileSync(f.log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; message: Record<string, unknown> });
    expect(calls.every(call => call.argv.join(' ') === 'app-server')).toBe(true);
    expect(calls.map(call => call.message)).toEqual([
      { method: 'initialize', id: 0, params: { clientInfo: { name: 'repo-harness', version: expect.any(String) } } },
      { method: 'initialized' },
      { method: 'account/rateLimits/read', id: 1 },
    ]);
    const text = quota([], f.env);
    expect(text.status).toBe(0);
    const lines = text.stdout.trim().split('\n');
    expect(lines.slice(0, 2).map(line => line.split(' | ')[0])).toEqual(['claude: exhausted', 'chatgpt: normal']);
    expect(lines.slice(2, 4)).toEqual(['claude mode: saving (5% left < 20%)', 'codex mode: normal (90% left)']);
    for (const expected of ['route simple_fast: worker (pi magpie/codex/gpt-6.2-sol high',
      'route simple_deep: worker-deep (pi magpie/codex/gpt-6.2-sol medium',
      'gatekeeper: gatekeeper (pi magpie/codex/gpt-6.2-sol high',
      'advisor: advisor (pi magpie/codex/gpt-6.2-sol)']) expect(text.stdout).toContain(expected);
    expect(lines.slice(4).map(line => line.split(':')[0])).toEqual(['route important_deep', 'route important_fast', 'route simple_deep', 'route simple_fast', 'route frontend', 'explorer', 'gatekeeper', 'reviewer', 'advisor']);
  });

  test('the stored all credit mode reports ChatGPT normal above the primary window threshold', () => {
    const f = fixture('primary-exhausted');
    const magpieLog = fixtureMagpie(f.env, JSON.stringify([magpieSubscription(Date.now())]));
    writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats: { ...DEFAULT_SEATS_CONFIG,
      routing: { ...DEFAULT_SEATS_CONFIG.routing, codex_credit_mode: 'all', codex_credit_floor: 0 } } }));
    const result = quota([], f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('chatgpt: normal | available credits cover usage | primary exhausted 97% used');
    expect(result.stdout).toContain('gatekeeper: gatekeeper (pi magpie/codex/gpt-6.2-sol high; chatgpt normal)');
    expect(existsSync(magpieLog)).toBe(false);
  });

  test('Magpie supplies the credit balance and weekly reset when the native read fails', () => {
    const f = fixture('error');
    const card = magpieSubscription(Date.now());
    const magpieLog = fixtureMagpie(f.env, JSON.stringify([card]));
    writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats: { ...DEFAULT_SEATS_CONFIG,
      routing: { ...DEFAULT_SEATS_CONFIG.routing, codex_credit_mode: 'all', codex_credit_floor: 0 } } }));
    const result = quota(['--json'], f.env);
    expect(result.status, result.stderr).toBe(0);
    const report = decodeQuotaReport(JSON.parse(result.stdout));
    expect(report.accounts[1]).toMatchObject({
      account: 'chatgpt', source: 'magpie_quota', state: 'normal', reason: 'available credits cover usage',
      observed_at: new Date(card.readAt).toISOString(),
      windows: [{ window: 'weekly', used_percent: 97, resets_at: new Date(card.windows[0]!.resetsAt!).toISOString() }],
      codex: { credits: { balance: '12.50', has_credits: true, unlimited: false } },
    });
    expect(JSON.parse(readFileSync(magpieLog, 'utf8'))).toEqual(['quota', 'codex', '--json']);
    expect(result.stdout + result.stderr).not.toMatch(/private-magpie|Image generation/);
  });

  test('Magpie supplies a valid weekly reset when it omits the credit balance', () => {
    const f = fixture(null);
    const card = { ...magpieSubscription(Date.now()), balance: undefined };
    fixtureMagpie(f.env, JSON.stringify([card]));
    const result = quota(['--json'], f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(decodeQuotaReport(JSON.parse(result.stdout)).accounts[1]).toMatchObject({
      account: 'chatgpt', source: 'magpie_quota', state: 'exhausted',
      windows: [{ window: 'weekly', resets_at: new Date(card.windows[0]!.resetsAt!).toISOString() }],
      codex: { credits: null },
    });
  });

  test.each(['empty', 'malformed', 'ambiguous', 'stale', 'failed'] as const)('Magpie %s leaves ChatGPT unknown when Codex is absent', mode => {
    const f = fixture(null);
    const card = magpieSubscription(Date.now() - (mode === 'stale' ? HOUR : 0));
    const output = mode === 'malformed' ? 'private-magpie-error'
      : JSON.stringify(mode === 'empty' ? [] : mode === 'ambiguous' ? [card, card] : [card]);
    fixtureMagpie(f.env, output, mode === 'failed' ? 2 : 0);
    const result = quota(['--json'], f.env);
    expect(result.status, result.stderr).toBe(0);
    expect(decodeQuotaReport(JSON.parse(result.stdout)).accounts[1]).toMatchObject({
      account: 'chatgpt', state: 'unknown', reason: mode === 'stale' ? 'reading older than 30 min' : 'codex not on PATH',
    });
    expect(result.stdout + result.stderr).not.toContain('private-magpie');
  });

  test('the stored review credit mode routes the gatekeeper on credits and keeps the account line exhausted', () => {
    const f = fixture('exhausted');
    const lines = () => quota([], f.env).stdout.trim().split('\n');
    const selected = (text: string[]) => text.filter(line => line.startsWith('gatekeeper:') || line.startsWith('route important_deep:'));
    expect(selected(lines())).toEqual(['route important_deep: worker-opus (claude opus high; claude unknown)', 'gatekeeper: none (chatgpt exhausted)']);
    writeFileSync(join(f.home, '.repo-harness', 'config.json'), JSON.stringify({ seats: { ...DEFAULT_SEATS_CONFIG,
      routing: { ...DEFAULT_SEATS_CONFIG.routing, codex_credit_mode: 'review', codex_credit_floor: 2000 } } }));
    const granted = lines();
    expect(selected(granted)).toEqual([
      'route important_deep: worker-opus (claude opus high; claude unknown)',
      'gatekeeper: gatekeeper (pi magpie/codex/gpt-6.2-sol high; chatgpt exhausted, on credits)',
    ]);
    expect(granted.find(line => line.startsWith('chatgpt:'))).toStartWith('chatgpt: exhausted');
  });

  test.each([
    [null, 'codex not on PATH'],
    ['error', 'account/rateLimits/read error: not logged in'],
    ['exit', 'codex app-server exited (3) before the response'],
  ])('codex mode %p is an unknown account with its reason and exit 0', (mode, reason) => {
    const f = fixture(mode);
    const result = quota(['--json'], f.env);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as QuotaReport;
    expect(report.accounts.map(account => [account.account, account.state, account.reason])).toEqual([
      ['claude', 'unknown', 'no capture'], ['chatgpt', 'unknown', reason],
      ['agy_gemini', 'unknown', 'agy not installed'], ['agy_other', 'unknown', 'agy not installed'],
    ]);
  });
});

describe('repo-harness-hook statusline', () => {
  test('copies rate_limits unchanged with a new observed_at, prints the line, and keeps the old capture otherwise', () => {
    const f = fixture(null);
    const capture = join(f.home, '.repo-harness', 'quota', 'claude.json');
    rmSync(join(f.home, '.repo-harness'), { recursive: true });
    const resetsAt = Math.floor(Date.now() / 1000);
    const fiveHour = { used_percentage: 12.4, resets_at: resetsAt + 2 * 3600 }, sevenDay = { used_percentage: 30, resets_at: resetsAt + 100 * 3600 };
    const statusline = (stdin: string, args: string[] = []) => spawnSync(process.execPath, [HOOK_ENTRY, 'statusline', ...args], { cwd: tmpdir(), env: f.env, input: stdin, encoding: 'utf8', timeout: 40_000 });
    const rows: Array<[string, string, string[], number, string, Record<string, unknown> | 'kept']> = [
      // [case, stdin, extra argv, exit, stdout, written rate_limits or 'kept']
      ['both windows and an undocumented key', JSON.stringify({ session_id: 's', rate_limits: { five_hour: fiveHour, seven_day: sevenDay, other: { x: 1 } } }), [], 0, '5h 12% · 7d 30%\n', { five_hour: fiveHour, seven_day: sevenDay, other: { x: 1 } }],
      ['one window', JSON.stringify({ rate_limits: { seven_day: sevenDay } }), [], 0, '7d 30%\n', { seven_day: sevenDay }],
      ['no rate_limits', JSON.stringify({ session_id: 's' }), [], 0, '\n', 'kept'],
      ['empty stdin', '', [], 0, '\n', 'kept'],
      ['rate_limits not an object', JSON.stringify({ rate_limits: 'x' }), [], 1, '', 'kept'],
      ['stdin not JSON', '{', [], 1, '', 'kept'],
      ['an extra argument', JSON.stringify({ rate_limits: { seven_day: sevenDay } }), ['--json'], 2, '', 'kept'],
    ];
    let previous = '';
    for (const [name, stdin, args, exit, stdout, written] of rows) {
      const before = Date.now();
      const result = statusline(stdin, args);
      expect([name, result.status, result.stdout], result.stderr).toEqual([name, exit, stdout]);
      const text = readFileSync(capture, 'utf8');
      if (written === 'kept') {
        expect([name, text]).toEqual([name, previous]);
        continue;
      }
      const value = JSON.parse(text) as { observed_at: string; rate_limits: unknown };
      expect([name, Object.keys(value), value.rate_limits]).toEqual([name, ['observed_at', 'rate_limits'], written]);
      expect(Date.parse(value.observed_at)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
      expect(decodeClaudeQuotaCapture(value).reason).toBeNull();
      expect(statSync(capture).mode & 0o777).toBe(0o600);
      previous = text;
    }
    expect(statusline(JSON.stringify({ rate_limits: 'x' })).stderr).toBe('repo-harness-hook statusline: capture not written: rate_limits is not an object\n');
    // The Q1 reader accepts the capture that the writer wrote.
    const report = JSON.parse(quota(['--json'], f.env).stdout) as QuotaReport;
    expect(report.accounts[0]).toMatchObject({ account: 'claude', state: 'normal', observed_at: JSON.parse(previous).observed_at, windows: [{ window: 'five_hour', state: 'absent', reason: 'five_hour absent' }, { window: 'seven_day', state: 'normal', used_percent: 30, reason: null }] });
  });
});
