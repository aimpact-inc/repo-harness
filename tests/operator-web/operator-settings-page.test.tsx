import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { AGENT_RUNTIME_CAPABILITIES, decodeAgentsSettings, type AgentsSettingsV1 } from '../../src/core/board/agents-settings';
import { isReviewRuntimeId } from '../../src/core/review/review-runtimes';
import { decodeDevActivitySnapshot } from '../../src/core/dev-activity/decode';
import { unavailableRuntimeOverlay } from '../../src/core/operator/runtime-status';
import { OperatorApp, type OperatorAppProps } from '../../src/operator-web/App';
import type { OperatorLocale } from '../../src/operator-web/i18n';
import { fixtureProps, FIXTURE_NAMES } from '../../src/operator-web/fixtures';
import { busyDevActivity } from '../../src/operator-web/fixtures/dev-activity';
import { agentsSettingsFixture, settingsStores } from '../../src/operator-web/fixtures/settings';
import { DEFAULT_SEATS_CONFIG, type SeatConfigV1, type SeatsSettingsRequestV1 } from '../../src/core/board/seats-settings';
import { registryOf } from '../../src/operator-web/fixtures';

const REGISTRY = registryOf(['repo-harness', 'repo-console']);
import {
  fetchAgentsSettings,
  postAgentsSettings,
  type AgentsSettingsPost,
  type AgentsSettingsRead,
  type AgentsSettingsWrite,
} from '../../src/operator-web/settings';
import type { DocumentationLanguage, LanguageRead, ReportingHost, ReportingPreset } from '../../src/operator-web/language-settings';
import { fetchQuota } from '../../src/operator-web/quota';
import { busyQuota, degradedQuota } from '../../src/operator-web/fixtures/quota';

let root: Root | null = null;
let window: Window;

function installDom(url = 'http://127.0.0.1:4318/'): void {
  window = new Window({ url });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => true }),
  });
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator, localStorage: window.localStorage,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event,
    MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true,
  });
}

const NOW = Date.now();
const activity = decodeDevActivitySnapshot(busyDevActivity(NOW));
const REVISION_A = `sha256:${'a'.repeat(64)}`;
const REVISION_B = `sha256:${'b'.repeat(64)}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const entry = (id: string, installation: Record<string, unknown>, group = 'default') => ({
  id, group, installation, review_supported: isReviewRuntimeId(id), docs_supported: false, capabilities: AGENT_RUNTIME_CAPABILITIES,
});

/**
 * claude is on for review; codex and kimi are installed and off; grok is not installed. No runtime reports
 * docs support: the launch allowlist is empty, so the docs use and default are not offered (#1234).
 */
function settings(config: Partial<AgentsSettingsV1['config']> = {}, extra: readonly Record<string, unknown>[] = []): AgentsSettingsV1 {
  return decodeAgentsSettings({
    protocol: 1, kind: 'operator_agents_settings',
    config: { revision: REVISION_A, enabled: ['claude'], uses: { docs: [], review: ['claude'] }, default_docs: null, ...config },
    runtimes: {
      status: 'ready', reason: null, collected_at: new Date(NOW - 120_000).toISOString(),
      entries: [
        entry('claude', { kind: 'available', via: 'executable', version: '2.1.3' }),
        entry('codex', { kind: 'available', via: 'executable', version: '0.71.0' }),
        entry('grok', { kind: 'not_found' }),
        entry('kimi', { kind: 'available', via: 'executable', version: null }),
        entry('cursor', { kind: 'dependency_missing', package: '@cursor/sdk' }, 'host_dependency'),
        ...extra,
      ],
    },
  });
}

/** A route stand-in: reads return the current value, writes return the queued outcomes in order. */
function server(initial: AgentsSettingsV1, outcomes: AgentsSettingsWrite[]) {
  let current: AgentsSettingsRead = { state: 'ok', settings: initial };
  const posts: AgentsSettingsPost[] = [];
  let reads = 0;
  return {
    posts,
    reads: () => reads,
    set(next: AgentsSettingsRead) { current = next; },
    read: async (): Promise<AgentsSettingsRead> => { reads += 1; return current; },
    write: async (body: AgentsSettingsPost): Promise<AgentsSettingsWrite> => {
      posts.push(body);
      const outcome = outcomes.shift();
      if (!outcome) throw new Error('unexpected write');
      return outcome;
    },
  };
}

function props(route: ReturnType<typeof server>, locale: OperatorLocale = 'en'): OperatorAppProps {
  return {
    initialLocale: locale, initialRepositories: REGISTRY, readRepositories: async () => REGISTRY,
    initialDevActivity: activity, fetchDevActivity: async () => activity,
    initialRuntimeOverlay: unavailableRuntimeOverlay(), readRuntimeStatus: async () => unavailableRuntimeOverlay(),
    readNotifyStatus: () => new Promise(() => {}),
    readAgentsSettings: route.read, writeAgentsSettings: route.write,
    // The setup check stays pending, so every runtime shows in the agent settings list below Hosts.
    readSetup: () => new Promise(() => {}), readSeatsSettings: () => new Promise(() => {}), readQuota: () => new Promise(() => {}),
  };
}

async function mount(appProps: OperatorAppProps, hash = '#agents'): Promise<void> {
  window.location.hash = hash;
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<OperatorApp {...appProps} />));
  await settle();
}

const settle = () => act(async () => { for (let turn = 0; turn < 6; turn++) await Promise.resolve(); });
const all = (selector: string, scope: ParentNode = document) => Array.from(scope.querySelectorAll<HTMLElement>(selector));
const row = (id: string) => document.querySelector<HTMLElement>(`[data-runtime="${id}"]`)!;
const toggle = (id: string) => row(id).querySelector<HTMLButtonElement>(`[aria-label="Enable ${id}"], [aria-label="启用 ${id}"]`);
const use = (id: string, name: 'docs' | 'review') => row(id).querySelector<HTMLButtonElement>(`[data-use="${name}"]`)!;
const saveButton = () => document.querySelector<HTMLButtonElement>('[data-save="agents"]')!;
const seatsSave = () => document.querySelector<HTMLButtonElement>('[data-save="seats"]')!;
const result = () => document.querySelector<HTMLElement>('[data-save-result]');
const buttonWithText = (label: string) => all('button').find(button => button.textContent?.trim() === label)!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); await settle(); };

beforeEach(() => installDom());
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  window.happyDOM.abort();
});

describe('agents page seats section', () => {
  /** The busy fixture's read; writes are recorded and answered as saved. */
  function seatsProps(posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[]): OperatorAppProps {
    return {
      ...props(server(settings(), [])),
      readSeatsSettings: settingsStores(NOW, 'busy').seats.read,
      writeSeatsSettings: async (body) => { posts.push(body); return { state: 'saved', result: { config_revision: REVISION_B, changed_keys: ['seats.advisor.fleet'] } }; },
    };
  }
  test('the advisor card shows the model for the next launch from the current Gemini quota', async () => {
    const read = await settingsStores(NOW, 'busy').seats.read();
    if (read.state !== 'ok') throw new Error('fixture read failed');
    const carbon = 'magpie/agy-cli/gemini-4-carbon';
    const advisor = { ...read.settings.config.advisor, runtime: 'pi' as const, model: carbon, advisor_model: null };
    const stored = { ...read.settings, config: { ...read.settings.config, advisor } };
    let report = busyQuota(NOW);
    await mount({ ...seatsProps([]), readSeatsSettings: async () => ({ state: 'ok', settings: stored }),
      readQuota: async () => ({ state: 'ok', settings: report }) });
    const card = '[data-seat-card="advisor"]';
    const launchModel = () => document.querySelector(`${card} [data-seat-launch-model]`)?.textContent;
    expect(launchModel()).toBe(carbon);
    report = degradedQuota(NOW);
    await click(document.querySelector<HTMLButtonElement>('[data-quota-refresh]')!);
    expect(launchModel()).toBe('magpie/agy-cli/gemini-4-neon');
    expect(document.querySelector(`${card} [aria-label="Model"] [aria-pressed="true"]`)?.textContent).toBe(carbon);
  });

  const allow = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="Allow ${label}"]`)!;
  const pane = (seat: string) => document.querySelector<HTMLButtonElement>(`[data-pane="${seat}"]`)!;
  const levels = () => [...document.querySelectorAll('[data-seat-card] [data-limit]')].map(node => node.getAttribute('data-limit'));

  test('eligible seats offer agy and save their starter tools, while the primary review seats hide it', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    const read = await settingsStores(NOW, 'busy').seats.read();
    if (read.state !== 'ok') throw new Error('fixture read failed');
    const { settings: initial } = read;
    const ranges = { ...initial.ranges, runtimes: initial.ranges.runtimes.map(runtime => runtime.id === 'agy' ? { ...runtime, enabled: true } : runtime) };
    await mount({ ...seatsProps(posts), readSeatsSettings: async () => ({ state: 'ok', settings: { ...initial, ranges } }) });
    await click(buttonWithText('Antigravity (agy)'));
    expect(Boolean(buttonWithText('Host default'))).toBe(false);
    expect(buttonWithText('gemini-4-neon-high').getAttribute('aria-pressed')).toBe('true');
    expect(allow('Shell').getAttribute('aria-checked')).toBe('true');
    expect(allow('Shell').disabled).toBe(true);
    // The agy advisor rule makes edit, gh, MCP, schedule, and tasks optional while net, read, and shell stay required.
    expect(['Edit files', 'GitHub writes', 'MCP · repo-harness', 'Scheduled jobs', 'Task list'].map(tool => allow(tool).disabled)).toEqual([false, false, false, false, false]);
    await click(allow('MCP · repo-harness'));
    await click(seatsSave());
    expect(posts[0]?.seats.advisor).toEqual({ runtime: 'agy', model: 'gemini-4-neon-high', effort: null, advisor_model: null, fleet: [], tools: ['edit', 'gh', 'net', 'read', 'schedule', 'shell', 'tasks'] });

    // Worker seat gets Neon High + writable agy worker tools, unlocked gh toggle, and dynamic limits (no edit limit).
    await click(pane('worker'));
    await click(buttonWithText('Antigravity (agy)'));
    expect(buttonWithText('gemini-4-neon-high').getAttribute('aria-pressed')).toBe('true');
    expect(allow('Edit files').getAttribute('aria-checked')).toBe('true');
    expect(allow('Edit files').disabled).toBe(true);
    expect(allow('GitHub writes').getAttribute('aria-checked')).toBe('true');
    expect(allow('GitHub writes').disabled).toBe(false);
    expect(levels()).toEqual(['instructions_only', 'instructions_only', 'instructions_only', 'instructions_only']);
    await click(allow('GitHub writes'));
    expect(allow('GitHub writes').getAttribute('aria-checked')).toBe('false');
    // A writable worker keeps edit on without GitHub writes too: the launch refuses a read-only agy worker.
    expect(allow('Edit files').disabled).toBe(true);
    expect(levels()).toEqual(['instructions_only', 'instructions_only', 'instructions_only', 'common_commands', 'instructions_only']);
    await click(seatsSave());
    expect(posts[1]?.seats.worker).toEqual({ runtime: 'agy', model: 'gemini-4-neon-high', effort: null, advisor_model: null, fleet: [], tools: ['edit', 'net', 'read', 'shell'] });

    // Council seat gets Carbon High + read-only agy tools.
    await click(buttonWithText('Council'));
    await click(document.querySelector<HTMLButtonElement>('[data-seat-card="council"] [aria-label="Configured"]')!);
    await click(buttonWithText('Antigravity (agy)'));
    expect(buttonWithText('gemini-4-carbon-high').getAttribute('aria-pressed')).toBe('true');
    expect(allow('Shell').disabled).toBe(true);
    await click(seatsSave());
    expect(posts[2]?.seats.council).toEqual({ runtime: 'agy', model: 'gemini-4-carbon-high', effort: null, advisor_model: null, fleet: [], tools: ['net', 'read', 'shell'] });

    // Light worker and gatekeeper-fallback get Hydrogen + role-appropriate tools.
    await click(buttonWithText('Light worker'));
    await click(document.querySelector<HTMLButtonElement>('[data-seat-card="worker-light"] [aria-label="Configured"]')!);
    await click(buttonWithText('Antigravity (agy)'));
    expect(buttonWithText('gemini-4-hydrogen-high').getAttribute('aria-pressed')).toBe('true');
    expect(allow('Edit files').getAttribute('aria-checked')).toBe('true');
    expect(allow('GitHub writes').disabled).toBe(false);

    await click(buttonWithText('Gatekeeper fallback'));
    await click(document.querySelector<HTMLButtonElement>('[data-seat-card="gatekeeper-fallback"] [aria-label="Configured"]')!);
    await click(buttonWithText('Antigravity (agy)'));
    expect(buttonWithText('gemini-4-hydrogen-high').getAttribute('aria-pressed')).toBe('true');
    expect(allow('Shell').disabled).toBe(true);

    await click(buttonWithText('Neon deep worker'));
    await click(document.querySelector<HTMLButtonElement>('[data-seat-card="worker-neon-deep"] [aria-label="Configured"]')!);
    expect(buttonWithText('gemini-4-neon-xhigh').getAttribute('aria-pressed')).toBe('true');

    await click(pane('orchestrator'));
    await click(buttonWithText('Antigravity (agy)'));
    expect(buttonWithText('gemini-4-neon-high').getAttribute('aria-pressed')).toBe('true');
    expect(allow('Edit files').getAttribute('aria-checked')).toBe('false');
    expect(allow('Edit files').disabled).toBe(true);
    await click(seatsSave());
    expect(posts[3]?.seats.orchestrator).toEqual({
      runtime: 'agy', model: 'gemini-4-neon-high', effort: null, advisor_model: null, fleet: [],
      tools: ['gh', 'mcp', 'net', 'read', 'shell', 'tasks'],
    });

    for (const [id, label] of [['gatekeeper', 'Gatekeeper'], ['reviewer', 'Reviewer']] as const) {
      await click(buttonWithText(label));
      expect(document.querySelector('[data-seat-card]')?.getAttribute('data-seat-card')).toBe(id);
      expect(Boolean(buttonWithText('Antigravity (agy)')), label).toBe(false);
    }
  });

  test('a stored read-only agy worker allows explicitly enabling edit in Settings UI and unlocks gh afterwards', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    const read = await settingsStores(NOW, 'busy').seats.read();
    if (read.state !== 'ok') throw new Error('fixture read failed');
    const agyEnabled = {
      ...read.settings,
      config: {
        ...read.settings.config,
        'worker-neon': { runtime: 'agy' as const, model: 'gemini-4-neon-high', effort: null, advisor_model: null, fleet: [], tools: ['net', 'read', 'shell'] as const },
      },
      ranges: { ...read.settings.ranges, runtimes: read.settings.ranges.runtimes.map(entry => (entry.id === 'agy' ? { ...entry, enabled: true } : entry)) },
    };
    await mount({ ...seatsProps(posts), readSeatsSettings: async () => ({ state: 'ok', settings: agyEnabled }) });
    await click(buttonWithText('Neon worker'));
    expect(allow('Edit files').getAttribute('aria-checked')).toBe('false');
    expect(allow('Edit files').disabled).toBe(false);
    expect(allow('GitHub writes').getAttribute('aria-checked')).toBe('false');
    expect(allow('GitHub writes').disabled).toBe(true);
    await click(allow('Edit files'));
    expect(allow('Edit files').getAttribute('aria-checked')).toBe('true');
    expect(allow('Edit files').disabled).toBe(true);
    expect(allow('GitHub writes').disabled).toBe(false);
    await click(seatsSave());
    expect(posts[0]?.seats['worker-neon']).toEqual({ runtime: 'agy', model: 'gemini-4-neon-high', effort: null, advisor_model: null, fleet: [], tools: ['edit', 'net', 'read', 'shell'] });
  });

  test('an agy seat offers its model catalog effort menu and keeps an effort across a model change only when the new menu has it', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    const read = await settingsStores(NOW, 'busy').seats.read();
    if (read.state !== 'ok') throw new Error('fixture read failed');
    const settings = {
      ...read.settings,
      config: { ...read.settings.config, 'worker-deep': { runtime: 'agy' as const, model: 'gemini-4-hydrogen', effort: 'xhigh', advisor_model: null, fleet: [], tools: ['edit', 'net', 'read', 'shell'] as const } },
      ranges: {
        ...read.settings.ranges,
        runtimes: read.settings.ranges.runtimes.map(entry => (entry.id === 'agy' ? { ...entry, enabled: true } : entry)),
        agy_models: [
          { id: 'gemini-4-hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] },
          { id: 'gemini-4-neon', efforts: ['high', 'xhigh'] },
          { id: 'gemini-4-carbon', efforts: ['high'] },
          // The seat effort rule refuses an effort other than the one that a suffixed id names.
          { id: 'gemini-4-hydrogen-high', efforts: ['high', 'low'] },
        ],
      },
    };
    await mount({ ...seatsProps(posts), readSeatsSettings: async () => ({ state: 'ok', settings }) });
    await click(buttonWithText('Deep worker'));
    const effort = '[data-seat-card="worker-deep"] [aria-label="Effort"]';
    const choices = () => [...document.querySelectorAll(`${effort} button`)].map(button => button.textContent);
    const pressed = () => document.querySelector(`${effort} [aria-pressed="true"]`)?.textContent;
    expect([choices(), pressed()]).toEqual([['Default', 'low', 'medium', 'high', 'xhigh'], 'xhigh']);
    const input = '[data-seat-card="worker-deep"] [data-model-input]';
    await typeText(input, 'gemini-4-neon');
    await leaveField(input);
    expect([choices(), pressed()]).toEqual([['Default', 'high', 'xhigh'], 'xhigh']);
    await typeText(input, 'gemini-4-carbon');
    await leaveField(input);
    expect([choices(), pressed()]).toEqual([['Default', 'high'], 'Default']);
    await typeText(input, 'gemini-4-hydrogen-high');
    await leaveField(input);
    expect(choices()).toEqual(['Default', 'high']);
    await typeText(input, 'gemini-4-carbon');
    await leaveField(input);
    await click(seatsSave());
    expect(posts[0]?.seats['worker-deep']).toMatchObject({ model: 'gemini-4-carbon', effort: null });
  });

  test('the advisor offers only scaffold roles, allows edits and GitHub writes; save sends the whole section', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    await mount(seatsProps(posts));
    expect(document.querySelector('[data-seat-card]')?.getAttribute('data-seat-card')).toBe('advisor');
    expect(all('[data-seat-fleet] button[role="switch"]').map(button => button.getAttribute('aria-label'))).toEqual(['Allow deep-reasoner', 'Allow explorer']);
    expect(allow('GitHub writes').disabled).toBe(false);
    expect(allow('Edit files').disabled).toBe(false);
    // The levels are those of buildSeatLaunch (#1531): Claude advisor with shell on, tasks, schedule, edit and gh off.
    expect(levels()).toEqual(['common_commands', 'enforced', 'instructions_only', 'common_commands', 'named_types_only']);
    expect(document.querySelector('[data-seat-launch]')?.textContent).toContain('--argv "$(rh seats argv advisor --repository-id <repository-id>)"');
    // The page shows no running pane count: the operator cannot read hc (#1413).
    expect(document.querySelector('[data-seats-page]')?.textContent).not.toMatch(/running \d|\d+ running/u);
    await click(allow('deep-reasoner'));
    await click(seatsSave());
    expect(posts).toHaveLength(1);
    const { request_id, expected_revision, seats } = posts[0]!;
    expect(request_id).toMatch(UUID);
    expect(expected_revision).toMatch(/^sha256:/u);
    expect(seats.advisor.fleet).toEqual(['explorer']);
    expect(Object.keys(seats)).toEqual(['orchestrator', 'advisor', 'council', 'worker', 'worker-deep', 'worker-opus', 'worker-neon', 'worker-neon-deep', 'worker-light', 'gatekeeper', 'gatekeeper-fallback', 'reviewer', 'routing']);
    expect(document.querySelector('[data-seats-saved]')?.textContent).toContain('Running panes do not change');

    await click(pane('orchestrator'));
    expect(allow('explorer').disabled).toBe(false);
    expect(allow('fast-worker')).toBeNull();
    expect(allow('Edit files').disabled).toBe(true);
  });

  test.each([
    [true, 'claude', 'fable'],
    [false, 'claude', 'fable'],
  ] as const)('the council switch saves the starter for Pi enabled = %s and can turn it off', async (piEnabled, runtime, model) => {
    const stores = settingsStores(NOW, 'busy');
    if (piEnabled) {
      const initial = await stores.agents.read();
      if (initial.state !== 'ok') throw new Error('fixture read failed');
      const enabled = await stores.agents.write({ request_id: crypto.randomUUID(), expected_revision: initial.settings.config.revision,
        changes: [{ runtime: 'pi', enabled: true, uses: [] }] });
      expect(enabled.state).toBe('saved');
    }
    await mount({ ...seatsProps([]), readAgentsSettings: stores.agents.read, writeAgentsSettings: stores.agents.write,
      readSeatsSettings: stores.seats.read, writeSeatsSettings: stores.seats.write });
    await click(buttonWithText('Council'));
    const card = '[data-seat-card="council"]';
    const configured = () => document.querySelector<HTMLButtonElement>(`${card} [aria-label="Configured"]`)!;
    const storedCouncil = async () => {
      const read = await stores.seats.read();
      if (read.state !== 'ok') throw new Error('fixture read failed');
      return read.settings.config.council;
    };
    expect(configured().getAttribute('aria-checked')).toBe('false');
    await click(configured());
    expect(document.querySelector(`${card} [data-seat-launch]`)?.textContent).toContain('rh seats council --issue <n> --members fable,carbon');
    expect(document.querySelector(`${card} [data-model-input]`)).toBeNull();
    expect(allow('Edit files')).toBeNull();
    expect(allow('GitHub writes')).toBeNull();
    expect(allow('explorer').getAttribute('aria-checked')).toBe('true');
    await click(seatsSave());
    expect(await storedCouncil()).toEqual({ runtime, model, advisor_model: null, effort: null, tools: ['net', 'read', 'shell'], fleet: ['explorer'] });
    await click(configured());
    await click(seatsSave());
    expect(await storedCouncil()).toBeNull();
  });

  test('Claude advisor choices save one field, clear when off, and clear when the seat leaves Claude', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    await mount(seatsProps(posts));
    await click(pick('Opus worker'));
    const advisor = () => document.querySelector<HTMLElement>('[role="group"][aria-label="Advisor model"]');
    const choice = (name: string) => [...advisor()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === name)!;
    expect([...advisor()!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Off', 'opus', 'sonnet', 'haiku', 'fable']);
    expect(seatsSave().disabled).toBe(true);
    await click(choice('fable'));
    expect(seatsSave().disabled).toBe(false);
    expect(document.body.textContent).toContain('1 changes');
    await click(choice('Off'));
    expect(seatsSave().disabled).toBe(true);
    await click(choice('fable'));
    await click(seatsSave());
    expect(posts[0]!.seats['worker-opus'].advisor_model).toBe('fable');
    await click(buttonWithText('Codex'));
    expect(advisor()).toBeNull();
    await click(buttonWithText('Claude Code'));
    expect(choice('Off').getAttribute('aria-pressed')).toBe('true');
  });

  test('the seat offers its recommended models on its runtime, and a typed id outside them becomes the chosen model and saves (#3250, #3252)', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    await mount(seatsProps(posts));
    await click(pick('Opus worker'));
    const card = '[data-seat-card="worker-opus"]';
    const offered = () => [...document.querySelectorAll(`${card} [role="group"][aria-label="Model"] button`)].map(button => button.textContent);
    expect(offered()).toEqual(['Host default', 'opus']);
    await typeText(`${card} [data-model-input]`, 'claude-opus-9');
    await leaveField(`${card} [data-model-input]`);
    const chosen = () => [...document.querySelectorAll<HTMLButtonElement>(`${card} [role="group"][aria-label="Model"] button`)].find(button => button.textContent === 'claude-opus-9');
    expect(chosen()?.getAttribute('aria-pressed')).toBe('true');
    expect(offered()).toEqual(['Host default', 'opus', 'claude-opus-9']);
    // Picking the active runtime again changes nothing, so the typed id stays.
    await click(buttonWithText('Claude Code'));
    expect(chosen()?.getAttribute('aria-pressed')).toBe('true');
    await click(seatsSave());
    expect(posts[0]!.seats['worker-opus'].model).toBe('claude-opus-9');
  });

  test('Pi Neon clears the orchestrator note and can be added to a frontend route', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    const read = await settingsStores(NOW, 'busy').seats.read();
    if (read.state !== 'ok') throw new Error('fixture read failed');
    const ranges = { ...read.settings.ranges, runtimes: read.settings.ranges.runtimes.map(runtime =>
      runtime.id === 'pi' ? { ...runtime, enabled: true } : runtime) };
    await mount({ ...seatsProps(posts), readSeatsSettings: async () => ({ state: 'ok', settings: { ...read.settings, ranges } }) });
    const neon = 'magpie/agy-cli/gemini-4-neon';
    const note = () => document.querySelector('[data-seat-card="orchestrator"] [data-runtime-note]');
    await click(pick('Orchestrator'));
    await click(buttonWithText('Codex'));
    expect(note()).not.toBeNull();
    await click(buttonWithText('Pi'));
    expect(note()).not.toBeNull();
    await click(buttonWithText(neon));
    expect(note()).toBeNull();

    await click(document.querySelector<HTMLElement>('[data-route="frontend"] [aria-label="Remove worker-opus"]')!);
    await click(pick('Opus worker'));
    await click(buttonWithText('Pi'));
    const add = () => document.querySelector<HTMLElement>('[data-route="frontend"] ~ [aria-label="Add worker-opus"]');
    expect(add()).toBeNull();
    await click(buttonWithText(neon));
    await click(add()!);
    expect(seatsSave().disabled).toBe(false);
    await click(seatsSave());
    expect(posts[0]?.seats).toMatchObject({
      orchestrator: { runtime: 'pi', model: neon },
      'worker-opus': { runtime: 'pi', model: neon },
      routing: { frontend: ['worker-neon', 'worker-opus'] },
    });
  });

  test('a Pi advisor keeps its fleet when switching between GPT and Neon', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    const read = await settingsStores(NOW, 'busy').seats.read();
    if (read.state !== 'ok') throw new Error('fixture read failed');
    const advisor: SeatConfigV1 = { ...read.settings.config.advisor, runtime: 'pi', model: 'magpie/codex/gpt-6.1-terra', advisor_model: null, fleet: ['explorer'] };
    const ranges = { ...read.settings.ranges, runtimes: read.settings.ranges.runtimes.map(runtime => ({ ...runtime, enabled: true })) };
    // Like the server, a read after a save returns the saved section.
    const stored = () => (posts.length === 0 ? { ...read.settings.config, advisor } : { revision: REVISION_B, ...posts.at(-1)!.seats });
    await mount({ ...seatsProps(posts), readSeatsSettings: async () => ({ state: 'ok', settings: { ...read.settings, ranges, config: stored() } }) });
    const input = '[data-seat-card="advisor"] [data-model-input]';
    for (const model of ['magpie/codx/gpt-6.2-sol', 'magpie/codex/gpt-6.2-sol']) {
      await typeText(input, model);
      await leaveField(input);
    }
    await click(seatsSave());
    expect(posts[0]!.seats.advisor).toMatchObject({ model: 'magpie/codex/gpt-6.2-sol', fleet: ['explorer'] });
    await typeText(input, 'magpie/agy-cli/gemini-4-neon');
    await leaveField(input);
    await click(seatsSave());
    expect(posts[1]!.seats.advisor).toMatchObject({ model: 'magpie/agy-cli/gemini-4-neon', fleet: ['explorer'] });
    expect(allow('explorer').getAttribute('aria-checked')).toBe('true');
    await typeText(input, 'magpie/codex/gpt-6.2-sol');
    await leaveField(input);
    await click(seatsSave());
    expect(posts[2]!.seats.advisor).toMatchObject({ model: 'magpie/codex/gpt-6.2-sol', fleet: ['explorer'] });
  });

  test('a stored advisor role outside the range can be switched off and saved, and cannot be switched back on', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    const read = await settingsStores(NOW, 'busy').seats.read();
    if (read.state !== 'ok') throw new Error('fixture read failed');
    const stored = { ...read.settings, config: { ...read.settings.config, advisor: { ...read.settings.config.advisor, fleet: ['explorer', 'fast-worker'] } } };
    await mount({ ...seatsProps(posts), readSeatsSettings: async () => ({ state: 'ok', settings: stored }) });
    expect([allow('fast-worker').disabled, allow('fast-worker').getAttribute('aria-checked')]).toEqual([false, 'true']);
    await click(allow('fast-worker'));
    expect(allow('fast-worker')).toBeNull();
    await click(seatsSave());
    expect(posts[0]!.seats.advisor.fleet).toEqual(['explorer']);
  });

  const choices = () => all('[data-seat-card] [role="group"][aria-label="Runtime"] button').map(button => button.textContent);
  const inPlace = (runtime: string) => document.querySelector<HTMLButtonElement>(`[data-runtime-enable="${runtime}"] [aria-label="Enable ${runtime}"]`);

  test('the default Pi worker-light keeps Save off when only Claude and Codex are enabled', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    const stores = settingsStores(NOW, 'busy');
    const read = await stores.seats.read();
    if (read.state !== 'ok') throw new Error('fixture read failed');
    const stored = { ...read.settings, config: { ...read.settings.config, 'worker-light': DEFAULT_SEATS_CONFIG['worker-light'] } };
    await mount({ ...seatsProps(posts), readAgentsSettings: stores.agents.read,
      readSeatsSettings: async () => ({ state: 'ok', settings: stored }) });
    expect(choices()).toEqual(['Claude Code', 'Codex']);
    expect(seatsSave().disabled).toBe(true);
    await click(allow('deep-reasoner'));
    expect(allow('deep-reasoner').getAttribute('aria-checked')).toBe('false');
    expect(seatsSave().disabled).toBe(true);
    await click(seatsSave());
    expect(posts).toHaveLength(0);
    // The save bar names the seat and offers both ways out: the Pi Hosts switch and worker-light set to null.
    const blocked = document.querySelector('[data-save-blocked="worker-light"]')!;
    expect(blocked.textContent).toContain('worker-light runs on Pi, which is not enabled');
    expect(blocked.querySelector('[aria-label="Enable pi"]')).not.toBeNull();
    await click(blocked.querySelector<HTMLButtonElement>('[data-worker-light-off]')!);
    expect(document.querySelector('[data-save-blocked]')).toBeNull();
    await click(seatsSave());
    expect(posts[0]!.seats['worker-light']).toBeNull();
  });

  const pick = (seat: string) => buttonWithText(({ 'worker-light': 'Light worker', gatekeeper: 'Gatekeeper', 'gatekeeper-fallback': 'Gatekeeper fallback', reviewer: 'Reviewer' } as Record<string, string>)[seat] ?? seat);
  const routeSeats = (task: string) => all(`[data-route="${task}"] [data-route-seat]`).map(item => item.getAttribute('data-route-seat'));
  const mode = (account: string) => document.querySelector(`[data-account-mode="${account}"]`)!;
  async function setNumber(selector: string, value: string) {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    // react-dom loads before this DOM exists, so it watches inputs through focus and keyup, not the input event.
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new window.KeyboardEvent('keyup', { key: '0', bubbles: true }) as unknown as Event);
    });
    await settle();
  }

  /**
   * Types `value` over a threshold field one character at a time, as a keyboard does, and leaves it (#2909). A threshold
   * keeps a local draft, so every intermediate text such as `1` stays in the field; the value commits at blur. It returns
   * the text that the field showed after each keystroke, so a snapped-back draft is visible. An empty `value` is one
   * keystroke that clears the field.
   */
  async function typeText(selector: string, value: string) {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { input.focus(); });
    const seen: string[] = [];
    for (const text of value === '' ? [''] : Array.from({ length: value.length }, (_, index) => value.slice(0, index + 1))) {
      await act(async () => {
        setValue.call(input, text);
        input.dispatchEvent(new window.KeyboardEvent('keyup', { key: text.at(-1) ?? 'Backspace', bubbles: true }) as unknown as Event);
      });
      await settle();
      seen.push(input.value);
    }
    return seen;
  }
  async function leaveField(selector: string) {
    await act(async () => { document.querySelector<HTMLInputElement>(selector)!.blur(); });
    await settle();
  }
  async function typeNumber(selector: string, value: string) {
    const seen = await typeText(selector, value);
    await leaveField(selector);
    return seen;
  }

  test('every seat has a card; a review seat shows only its read, shell and network groups and no fleet; Claude mode stays unknown while quota is not read', async () => {
    await mount(seatsProps([]));
    expect(all('[role="group"][aria-label="Seat"] button')).toHaveLength(12);
    await click(pick('gatekeeper'));
    expect(document.querySelector('[data-seat-card]')?.getAttribute('data-seat-card')).toBe('gatekeeper');
    expect(all('[data-seat-tools] [role="switch"]').map(node => node.getAttribute('aria-label'))).toEqual(['Allow Read code', 'Allow Shell', 'Allow Network']);
    expect(document.querySelector('[data-seat-fleet]')).toBeNull();
    expect(document.querySelector('[data-seat-launch]')?.textContent).toContain('seats argv gatekeeper --repository-id <repository-id> --pr <n>');
    // busy stores worker-light as null: only the configured switch shows.
    await click(pick('worker-light'));
    expect([document.querySelector('[aria-label="Configured"]')?.getAttribute('aria-checked'), document.querySelector('[data-seat-tools]')]).toEqual(['false', null]);
    expect(mode('claude').getAttribute('data-mode')).toBe('unknown');
    // A frontend route seat on Codex: the request decoder refuses the section, so Save stays off with its code.
    await click(pick('Opus worker'));
    await click(buttonWithText('Codex'));
    expect([document.querySelector('[data-save-refused]')?.textContent, seatsSave().disabled]).toEqual(['The section is not valid: seats_settings_request_invalid', true]);
  });

  const configured = () => document.querySelector<HTMLButtonElement>('[aria-label="Configured"]')!;
  const CODEX_FALLBACK: SeatConfigV1 = { runtime: 'codex', model: null, advisor_model: null, effort: null, tools: ['net', 'read', 'shell'], fleet: [] };

  test('the gatekeeper-fallback card is off by default; switched on, it saves a review seat in the gatekeeper range', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    await mount(seatsProps(posts));
    await click(pick('gatekeeper-fallback'));
    expect([configured().getAttribute('aria-checked'), document.querySelector('[data-seat-tools]')]).toEqual(['false', null]);
    await click(configured());
    // The Pi starter waits for the Pi host; the Codex runtime saves.
    expect(document.querySelector('[data-save-blocked="gatekeeper-fallback"]')).not.toBeNull();
    await click(buttonWithText('Codex'));
    expect(all('[data-seat-tools] [role="switch"]').map(node => node.getAttribute('aria-label'))).toEqual(['Allow Read code', 'Allow Shell', 'Allow Network']);
    expect(document.querySelector('[data-seat-fleet]')).toBeNull();
    expect(document.querySelector('[data-seat-launch]')?.textContent).toContain('seats argv gatekeeper --repository-id <repository-id> --pr <n>');
    await click(seatsSave());
    expect(posts[0]!.seats['gatekeeper-fallback']).toEqual(CODEX_FALLBACK);
  });

  test('a stored gatekeeper-fallback switched off saves null', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    const read = await settingsStores(NOW, 'busy').seats.read();
    if (read.state !== 'ok') throw new Error('fixture read failed');
    const stored = { ...read.settings, config: { ...read.settings.config, 'gatekeeper-fallback': CODEX_FALLBACK } };
    await mount({ ...seatsProps(posts), readSeatsSettings: async () => ({ state: 'ok', settings: stored }) });
    await click(pick('gatekeeper-fallback'));
    expect(configured().getAttribute('aria-checked')).toBe('true');
    await click(configured());
    await click(seatsSave());
    expect(posts[0]!.seats['gatekeeper-fallback']).toBeNull();
  });

  test('the routing lists reorder, add and remove; save sends the routes, thresholds and credit mode', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    await mount(seatsProps(posts));
    expect(routeSeats('important_deep')).toEqual(['worker-opus', 'worker-neon', 'worker-deep']);
    await click(document.querySelector<HTMLButtonElement>('[data-route="important_deep"] [aria-label="Move worker-deep up"]')!);
    expect(routeSeats('important_deep')).toEqual(['worker-opus', 'worker-deep', 'worker-neon']);
    await click(document.querySelector<HTMLButtonElement>('[data-route="simple_fast"] ~ [aria-label="Add worker-deep"]')!);
    expect(routeSeats('simple_fast')).toEqual(['worker', 'worker-deep']);
    await click(document.querySelector<HTMLButtonElement>('[data-route="simple_fast"] [aria-label="Remove worker"]')!);
    expect(routeSeats('simple_fast')).toEqual(['worker-deep']);
    expect(document.querySelector<HTMLButtonElement>('[data-route="simple_fast"] [aria-label="Remove worker-deep"]')!.disabled).toBe(true);
    await click(document.querySelector<HTMLButtonElement>('[data-route="frontend"] [aria-label="Remove worker-opus"]')!);
    // worker-light is null in busy, so no list offers it.
    expect(all('[data-route="frontend"] ~ button').map(button => button.getAttribute('aria-label'))).toEqual(['Add worker-opus']);
    expect(document.querySelector<HTMLInputElement>('[data-threshold="agy_saving_below_remaining"]')!.value).toBe('25');
    await setNumber('[data-threshold="claude_hyper_at_or_above_remaining"]', '70');
    // The exhaustion line is a routing setting of its own (#2909): 100 typed over 95 passes through 1 and 10, and neither
    // intermediate text may be refused or snap back.
    expect(document.querySelector<HTMLInputElement>('[data-threshold="exhausted_at_or_above_used"]')!.value).toBe('95');
    expect(await typeNumber('[data-threshold="exhausted_at_or_above_used"]', '100')).toEqual(['1', '10', '100']);
    expect(document.querySelector<HTMLInputElement>('[data-threshold="exhausted_at_or_above_used"]')!.value).toBe('100');
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Codex on credits when exhausted"] button:nth-child(2)')!);
    await setNumber('[data-credit-floor]', '2000');
    await click(seatsSave());
    expect(posts[0]!.seats.routing).toMatchObject({
      important_deep: ['worker-opus', 'worker-deep', 'worker-neon'], simple_fast: ['worker-deep'], frontend: ['worker-neon'],
      claude_saving_below_remaining: 20, claude_hyper_at_or_above_remaining: 70, agy_saving_below_remaining: 25, exhausted_at_or_above_used: 100,
      codex_credit_mode: 'review', codex_credit_floor: 2000,
    });
    // worker-light as the only seat of a route: setting it to not configured empties the route, and the decoder refusal keeps Save off.
    await click(pick('worker-light'));
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Configured"]')!);
    await click(document.querySelector<HTMLButtonElement>('[data-route="simple_fast"] ~ [aria-label="Add worker-light"]')!);
    for (const seat of routeSeats('simple_fast').filter(seat => seat !== 'worker-light')) {
      await click(document.querySelector<HTMLButtonElement>(`[data-route="simple_fast"] [aria-label="Remove ${seat}"]`)!);
    }
    expect(routeSeats('simple_fast')).toEqual(['worker-light']);
    await click(document.querySelector<HTMLButtonElement>('[data-worker-light-off]')!);
    expect(routeSeats('simple_fast')).toEqual([]);
    expect([document.querySelector('[data-save-refused]')?.getAttribute('data-save-refused'), seatsSave().disabled]).toEqual(['seats_settings_request_invalid', true]);
  });

  test('a refused routing save shows the server refusal code', async () => {
    await mount({ ...seatsProps([]), writeSeatsSettings: async () => ({ state: 'refused', status: 400, error: {
      code: 'seats_settings_request_invalid', message: 'The seats section is not valid.', next_action: 'Fix the routing and save again.',
    } }) });
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Move worker-deep up"]')!);
    await click(seatsSave());
    expect(result()?.getAttribute('data-save-result')).toBe('seats_settings_request_invalid');
  });

  test('a change of one credit key alone enables Save and sends that key', async () => {
    for (const [edit, expected] of [
      [() => click(document.querySelector<HTMLButtonElement>('[aria-label="Codex on credits when exhausted"] button:nth-child(3)')!), { codex_credit_mode: 'all', codex_credit_floor: 0 }],
      [() => setNumber('[data-credit-floor]', '2000'), { codex_credit_mode: 'off', codex_credit_floor: 2000 }],
    ] as const) {
      const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
      await mount(seatsProps(posts));
      expect(seatsSave().disabled).toBe(true);
      await edit();
      expect(seatsSave().disabled).toBe(false);
      await click(seatsSave());
      expect(posts.map(post => post.seats.routing)).toEqual([expect.objectContaining(expected)]);
      await act(async () => root?.unmount());
      document.body.replaceChildren();
    }
  });

  test('the exhaustion line keeps an intermediate draft, commits a value in range, and refuses one outside it (#2909)', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    await mount(seatsProps(posts));
    const field = () => document.querySelector<HTMLInputElement>('[data-threshold="exhausted_at_or_above_used"]')!;
    const selector = '[data-threshold="exhausted_at_or_above_used"]';
    // Clearing the field is a keystroke of its own: the empty draft stays, and leaving the field restores 95 uncommitted.
    expect(await typeText(selector, '')).toEqual(['']);
    expect(seatsSave().disabled).toBe(true);
    await leaveField(selector);
    expect(field().value).toBe('95');
    expect(seatsSave().disabled).toBe(true);
    // A value below the range is refused at blur, and the field shows the stored value again.
    expect(await typeNumber(selector, '49')).toEqual(['4', '49']);
    expect(field().value).toBe('95');
    expect(seatsSave().disabled).toBe(true);
    // 50 is the lowest accepted value, and the save carries it.
    expect(await typeNumber(selector, '50')).toEqual(['5', '50']);
    expect(field().value).toBe('50');
    expect(seatsSave().disabled).toBe(false);
    await click(seatsSave());
    expect(posts[0]!.seats.routing.exhausted_at_or_above_used).toBe(50);
  });

  test('the credit preview names the configured seats that run on credits', async () => {
    // degraded quota, given credits: ChatGPT is exhausted with a balance of 5000.
    const report = degradedQuota(NOW);
    const funded = { ...report, accounts: report.accounts.map(account => account.codex === undefined ? account
      : { ...account, codex: { ...account.codex, credits: { has_credits: true, unlimited: false, balance: '5000' } } }) };
    await mount({ ...seatsProps([]), readQuota: async () => ({ state: 'ok', settings: funded }) });
    const seats = () => document.querySelector('[data-credit-seats]')?.getAttribute('data-credit-seats') ?? null;
    const mode = (index: number) => click(document.querySelector<HTMLButtonElement>(`[aria-label="Codex on credits when exhausted"] button:nth-child(${index})`)!);
    expect(seats()).toBeNull();
    await mode(2);
    expect(seats()?.split(' ')).toContain('gatekeeper');
    expect(seats()?.split(' ')).not.toContain('worker-deep');
    await mode(3);
    expect(seats()?.split(' ')).toEqual(expect.arrayContaining(['gatekeeper', 'worker-deep']));
  });

  test('a threshold change moves the shown account mode on the fixture quota report', async () => {
    // busy quota: Claude has 12% of the week left, ChatGPT 66%.
    await mount({ ...seatsProps([]), readQuota: async () => ({ state: 'ok', settings: busyQuota(NOW) }) });
    expect(mode('claude').getAttribute('data-mode')).toBe('saving');
    expect(mode('claude').textContent).toContain('12% left this week');
    await typeNumber('[data-threshold="claude_saving_below_remaining"]', '10');
    expect(mode('claude').getAttribute('data-mode')).toBe('normal');
  });

  test('the runtime choice offers only enabled runtimes; Pi is enabled in place, saved under Hosts, then a seat moves to Pi and saves against the fixture server', async () => {
    const stores = settingsStores(NOW, 'busy');
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    await mount({ ...props(server(settings(), [])), readAgentsSettings: stores.agents.read, writeAgentsSettings: stores.agents.write,
      readSeatsSettings: stores.seats.read, writeSeatsSettings: async (body) => { posts.push(body); return stores.seats.write(body); } });
    expect(choices()).toEqual(['Claude Code', 'Codex']);
    // An edited seat draft before the Hosts save: it must move to the new revision, not meet a conflict.
    await click(allow('deep-reasoner'));
    await click(inPlace('pi')!);
    // The in-place switch is the Hosts switch on the same draft; Pi is a choice only after the Hosts save.
    expect(toggle('pi')!.getAttribute('aria-checked')).toBe('true');
    expect(choices()).toEqual(['Claude Code', 'Codex']);
    await click(saveButton());
    await settle();
    expect(choices()).toEqual(['Claude Code', 'Codex', 'Pi']);
    expect(inPlace('pi')).toBeNull();
    expect(allow('deep-reasoner').getAttribute('aria-checked')).toBe('false');
    // Codex: the sandbox blocks edit, but an MCP path stays open; tasks, gh and the fleet are instructions only.
    await click(buttonWithText('Codex'));
    expect(levels()).toEqual(['common_commands', 'instructions_only', 'instructions_only', 'instructions_only']);
    await click(buttonWithText('Pi'));
    expect(levels()).toEqual(['instructions_only', 'instructions_only', 'instructions_only', 'instructions_only']);
    expect(allow('explorer').disabled).toBe(false);
    expect((buttonWithText('max') as HTMLButtonElement).disabled).toBe(false);
    // An agents draft edited before the seats save moves to the seats revision the same way.
    await click(use('codex', 'review'));
    await click(seatsSave());
    await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.seats.advisor).toMatchObject({ runtime: 'pi', model: null, effort: 'high', fleet: ['explorer'] });
    expect(document.querySelector('[data-seats-saved]')).not.toBeNull();
    await click(saveButton());
    expect(result()?.getAttribute('data-save-result')).toBe('saved');
    const read = await stores.agents.read();
    expect(read.state === 'ok' && read.settings.config).toMatchObject({ enabled: ['claude', 'codex', 'pi'], uses: { review: ['claude'] } });
  });

  test('a Hosts save names the seats that still use the runtime being turned off', async () => {
    const stores = settingsStores(NOW, 'busy');
    await mount({ ...props(server(settings(), [])), readAgentsSettings: stores.agents.read,
      writeAgentsSettings: stores.agents.write, readSeatsSettings: stores.seats.read });
    await click(toggle('codex')!);
    await click(saveButton());
    const refusal = document.querySelector('[data-save-result="runtime_in_use"]');
    expect(refusal?.textContent).toContain('gatekeeper (codex)');
    expect(refusal?.textContent).toContain('Move the listed seats to an enabled runtime');
    expect(choices()).toEqual(['Claude Code', 'Codex']);
  });

  test('a seat on a runtime that is not enabled keeps Save off and shows the Hosts switch in place of the choice', async () => {
    const posts: (SeatsSettingsRequestV1 & { readonly request_id: string })[] = [];
    // degraded: agents.enabled is claude and gemini; the stored worker runs on codex.
    const stores = settingsStores(NOW, 'degraded');
    await mount({ ...props(server(settings(), [])), readAgentsSettings: stores.agents.read,
      readSeatsSettings: stores.seats.read, writeSeatsSettings: async (body) => { posts.push(body); return stores.seats.write(body); } });
    await click(pane('worker'));
    expect(choices()).toEqual(['Claude Code']);
    expect(inPlace('codex')!.getAttribute('aria-checked')).toBe('false');
    await click(buttonWithText('review seats'));
    expect(document.querySelector('[data-save-blocked="gatekeeper"]')?.textContent).toContain('Change its runtime or enable Codex under Hosts.');
    expect(seatsSave().disabled).toBe(true);
    await click(seatsSave());
    expect(posts).toHaveLength(0);
  });
});

describe('settings page', () => {
  test('3-SET-P1 enabling codex for review sends one request and offers no docs use or default', async () => {
    const route = server(settings(), [{ state: 'saved', result: { config_revision: REVISION_B, changed_keys: ['agents.enabled', 'agents.uses.review'] } }]);
    await mount(props(route));
    expect(saveButton().disabled).toBe(true);
    // No runtime is docs-supported, so the docs use and the default docs control are absent.
    expect(all('[data-use="docs"]')).toEqual([]);
    expect(document.querySelector('[data-default-docs]')).toBeNull();
    await click(toggle('codex')!);
    await click(use('codex', 'review'));
    await click(saveButton());
    expect(route.posts).toHaveLength(1);
    const { request_id, ...body } = route.posts[0]!;
    expect(request_id).toMatch(UUID);
    expect(body).toEqual({ expected_revision: REVISION_A, changes: [{ runtime: 'codex', enabled: true, uses: ['review'] }] });
    expect(result()?.getAttribute('data-save-result')).toBe('saved');
    expect(result()?.textContent).toContain('2 settings changed');
    // Saved means nothing is left to send.
    expect(saveButton().disabled).toBe(true);
  });

  test('3-SET-N1 the form has no credential input, offers review only on supported runtimes, hides docs and gives no switch to an agent that is not installed', async () => {
    await mount(props(server(settings({ enabled: ['claude', 'codex', 'kimi'] }), [])));
    // The switches carry their own checkbox inputs; nothing takes typed text.
    expect(all('input').map(input => input.getAttribute('type')).filter(type => type !== 'radio' && type !== 'checkbox')).toEqual([]);
    expect(all('textarea, select, [contenteditable]')).toHaveLength(0);
    // The settings response reports no docs-supported runtime, so no row offers the docs use or the default.
    expect(all('[data-use="docs"]')).toEqual([]);
    expect(all('[data-default-docs]')).toEqual([]);
    expect(row('kimi').querySelector('[data-use-reasons]')?.textContent).toBe('Only claude, codex and pi can review.');
    await click(use('codex', 'review'));
    expect(use('codex', 'review').getAttribute('aria-pressed')).toBe('true');
    expect(row('codex').querySelector('[data-use-reasons]')).toBeNull();
    expect(use('claude', 'review').disabled).toBe(false);
    expect(use('kimi', 'review').disabled).toBe(true);
    expect(use('kimi', 'review').title).toBe('Only claude, codex and pi can review.');
    expect(toggle('grok')).toBeNull();
    expect(row('grok').textContent).toContain('No executable found');
    expect(row('cursor').closest('[data-runtime-group]')?.getAttribute('data-runtime-group')).toBe('settings-group-extra');
    expect(row('cursor').textContent).toContain('@cursor/sdk');
    expect(all('[data-capabilities]').map(line => line.textContent)).toEqual(['Every agent can stop a turn · steer depends on the session · withdrawing a queued message depends on the session']);
  });

  test('Pi review fixture offers the review use and saves it without changing the docs default', async () => {
    const route = server(settings({}, [entry('pi', { kind: 'available', via: 'bundled', version: null })]),
      [{ state: 'saved', result: { config_revision: REVISION_B, changed_keys: ['agents.enabled', 'agents.uses.review'] } }]);
    await mount(props(route));
    await click(toggle('pi')!);
    expect(use('pi', 'review').disabled).toBe(false);
    await click(use('pi', 'review')); await click(saveButton());
    expect(route.posts).toHaveLength(1);
    expect(route.posts[0]!.changes).toEqual([{ runtime: 'pi', enabled: true, uses: ['review'] }]);
    expect(route.posts[0]!.default_docs_runtime).toBeUndefined();
    expect(agentsSettingsFixture(NOW, 'busy').runtimes.entries.find(entry => entry.id === 'pi')?.review_supported).toBe(true);
  });

  test('3-SET-F1 a stale revision asks for a reload, sends nothing more, and the reload starts from the new section', async () => {
    const route = server(settings(), [{ state: 'refused', status: 409, error: { code: 'revision_conflict', message: 'The configuration changed after it was read.', next_action: 'Reload the settings, then apply your change again.' } }]);
    await mount(props(route));
    await click(use('claude', 'review'));
    await click(saveButton());
    expect(result()?.getAttribute('data-save-result')).toBe('revision_conflict');
    expect(result()?.textContent).toContain('The settings changed after this page read them. Nothing was saved.');
    expect(saveButton().disabled).toBe(true);
    expect(toggle('codex')!.disabled).toBe(true);
    route.set({ state: 'ok', settings: settings({ revision: REVISION_B, enabled: ['claude', 'codex'], uses: { docs: [], review: ['codex'] } }) });
    await click(buttonWithText('Reload settings'));
    expect(route.posts).toHaveLength(1);
    expect(result()).toBeNull();
    expect(use('claude', 'review').getAttribute('aria-pressed')).toBe('false');
    expect(use('codex', 'review').getAttribute('aria-pressed')).toBe('true');
  });

  test('3-SET-F2 an unwritable audit log shows the reason, and the retry sends the same request_id', async () => {
    const route = server(settings(), [
      { state: 'refused', status: 503, error: { code: 'audit_unavailable', message: 'The operator audit log is unavailable. Nothing was changed.', next_action: 'Check the operator audit log, then retry with the same request_id.' } },
      { state: 'saved', result: { config_revision: REVISION_B, changed_keys: ['agents.uses.review'] } },
    ]);
    await mount(props(route));
    await click(use('claude', 'review'));
    await click(saveButton());
    expect(result()?.getAttribute('data-save-result')).toBe('audit_unavailable');
    expect(result()?.textContent).toContain('The operator audit log cannot be written, so the change was not run.');
    await click(saveButton());
    expect(route.posts.map(post => post.request_id)).toEqual([route.posts[0]!.request_id, route.posts[0]!.request_id]);
    expect(result()?.getAttribute('data-save-result')).toBe('saved');
  });

  test('reconcile_required shows 待核对, locks the form and never resends; a reload unlocks it', async () => {
    const route = server(settings(), [{ state: 'refused', status: 409, error: { code: 'reconcile_required', message: 'The action may have run, but its result is not recorded.', next_action: 'Check the target state before you retry. Do not send the request again with a new request_id.' } }]);
    await mount(props(route, 'zh'));
    await click(use('claude', 'review'));
    await click(saveButton());
    expect(result()?.getAttribute('data-save-result')).toBe('reconcile_required');
    expect(result()?.textContent).toContain('待核对');
    expect(document.querySelectorAll('p p, p div')).toHaveLength(0);
    expect(saveButton().disabled).toBe(true);
    expect(use('claude', 'review').disabled).toBe(true);
    await click(saveButton());
    expect(route.posts).toHaveLength(1);
    await click(buttonWithText('重新加载设置'));
    expect(result()).toBeNull();
    expect(use('claude', 'review').disabled).toBe(false);
    expect(route.posts).toHaveLength(1);
  });

  test('an unanswered save resends the same request_id, and a changed draft gets a new one', async () => {
    const route = server(settings(), [{ state: 'unreachable' }, { state: 'unreachable' }, { state: 'unreachable' }]);
    await mount(props(route));
    await click(use('claude', 'review'));
    await click(saveButton());
    expect(result()?.getAttribute('data-save-result')).toBe('unreachable');
    await click(saveButton());
    // A different draft: turning the runtime off is not the review change the banner promised to resend.
    await click(toggle('claude')!);
    expect(result()).toBeNull();
    await click(saveButton());
    const [first, second, third] = route.posts.map(post => post.request_id);
    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(route.posts[2]).toMatchObject({ changes: [{ runtime: 'claude', enabled: false, uses: [] }] });
  });

  test('a runtime that left the runtime list can only be turned off, and turning it off clears its uses', async () => {
    const route = server(settings({ enabled: ['claude', 'gemini'], uses: { docs: [], review: ['claude'] } }),
      [{ state: 'saved', result: { config_revision: REVISION_B, changed_keys: ['agents.enabled'] } }]);
    await mount(props(route));
    expect(row('gemini').closest('[data-runtime-group]')?.getAttribute('data-runtime-group')).toBe('settings-group-missing');
    expect(use('gemini', 'review').disabled).toBe(true);
    await click(toggle('gemini')!);
    expect(toggle('gemini')).toBeNull();
    await click(saveButton());
    expect(route.posts[0]).toMatchObject({ changes: [{ runtime: 'gemini', enabled: false, uses: [] }] });
    expect(route.posts[0]!.default_docs_runtime).toBeUndefined();
  });

  test('a newer read keeps the unsaved draft and warns that the settings changed elsewhere', async () => {
    const route = server(settings(), []);
    await mount(props(route));
    await click(use('claude', 'review'));
    route.set({ state: 'ok', settings: settings({ revision: REVISION_B, enabled: ['claude', 'codex'], uses: { docs: [], review: ['claude', 'codex'] } }) });
    await click(buttonWithText('Refresh'));
    expect(use('claude', 'review').getAttribute('aria-pressed')).toBe('false');
    expect(toggle('codex')!.getAttribute('aria-checked')).toBe('false');
    expect(result()?.getAttribute('data-save-result')).toBe('changed-elsewhere');
    await click(buttonWithText('Discard changes'));
    await click(buttonWithText('Refresh'));
    expect(result()).toBeNull();
    expect(use('codex', 'review').getAttribute('aria-pressed')).toBe('true');
  });

  test('without a finished probe or with an invalid section the page shows why and offers no form', async () => {
    const pending = decodeAgentsSettings({ ...settings(), runtimes: { status: 'unavailable', reason: 'collection_pending', collected_at: null, entries: [] } });
    await mount(props(server(pending, [])));
    expect(document.querySelector('[data-runtimes="collection_pending"]')).not.toBeNull();
    expect(document.querySelector('[data-save="agents"]')).toBeNull();
    await act(async () => root?.unmount());
    root = null;
    const route = server(settings(), []);
    route.set({ state: 'unavailable', reason: 'config_invalid' });
    await mount(props(route));
    expect(document.querySelector('[data-settings-unavailable="config_invalid"]')?.textContent).toContain('~/.repo-harness/config.json');
    expect(document.querySelector('[data-runtime]')).toBeNull();
  });

  test('a stale probe still edits, with its age and the failed detection named', async () => {
    const route = server(agentsSettingsFixture(NOW, 'degraded'), []);
    await mount(props(route));
    expect(document.querySelector('[data-runtimes="stale"]')?.textContent).toContain('The last detection timed out.');
    expect(toggle('codex')!.disabled).toBe(false);
  });

  test.each(['en', 'zh'] as const)('the rail and the System page name the Agents page as the page that writes settings in %s', async locale => {
    await mount(props(server(settings(), []), locale), '#system');
    expect(document.querySelector('[data-operator-status]')?.textContent).toContain('read-only except Agents');
    expect(document.body.textContent).toContain(locale === 'en' ? 'It is read-only except the Agents page' : '除了 Agents 页和 Worktree 页，它是只读的。');
  });

  test.each([...FIXTURE_NAMES])('the %s fixture renders Hosts, Subagents, Seats and Quota in that order on the Agents page', async name => {
    await mount(fixtureProps(name));
    await settle();
    expect(document.querySelector('main')?.getAttribute('data-workspace')).toBe('agents');
    expect(document.querySelector('.workspace-nav a[data-workspace="agents"]')?.getAttribute('aria-current')).toBe('page');
    // empty: the setup check has not finished, so the Subagents list waits for it.
    expect(all('main h2[id]').map(heading => heading.id).filter(id => ['setup-hosts-heading', 'setup-fleet-heading', 'agents-seats-heading', 'agents-quota-heading'].includes(id)))
      .toEqual(name === 'empty' ? ['setup-hosts-heading', 'agents-seats-heading', 'agents-quota-heading'] : ['setup-hosts-heading', 'setup-fleet-heading', 'agents-seats-heading', 'agents-quota-heading']);
    expect(document.querySelector('[data-agents-section="seats"] [data-seats-page]')).not.toBeNull();
  });
});

describe('language controls', () => {
  const host = (name: string, preset: ReportingHost['preset'], state = 'managed-current'): ReportingHost => ({ host: name, state, preset });
  const refused = (code: string, next_action: string) => ({ state: 'refused' as const, status: 409, error: { code, message: 'Server text.', next_action } });
  const pressed = (scope: string) => all('[data-language-option]', document.querySelector(scope)!).filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.languageOption);

  test('a recorded custom reporting preset shows as current, and picking a preset writes it and reads the hosts again', async () => {
    let hosts = [host('claude', 'custom'), host('codex', 'custom')];
    const writes: unknown[] = [];
    await mount({
      ...props(server(settings(), [])),
      readReportingLanguage: async (): Promise<LanguageRead<readonly ReportingHost[]>> => ({ state: 'ok', value: hosts }),
      writeReportingLanguage: async (preset: ReportingPreset, request_id: string) => {
        writes.push({ preset, request_id });
        hosts = hosts.map(entry => host(entry.host, preset));
        return { state: 'ok', value: { changed_hosts: ['claude', 'codex'] } };
      },
    });
    expect(pressed('[data-language-control="report"]')).toEqual([]);
    expect(document.querySelector('[data-language-current="custom"]')).not.toBeNull();
    expect(all('[data-language-host]').map(item => item.dataset.languageHost)).toEqual(['claude', 'codex']);
    await click(document.querySelector<HTMLElement>('[data-language-control="report"] [data-language-option="en"]')!);
    expect(writes).toEqual([{ preset: 'en', request_id: expect.stringMatching(UUID) }]);
    expect(document.querySelector('[data-language-control="report"] [data-save-result]')?.getAttribute('data-save-result')).toBe('saved');
    expect(pressed('[data-language-control="report"]')).toEqual(['en']);
    expect(document.querySelector('[data-language-current="custom"]')).toBeNull();
  });

  test('a refused reporting save names the host state and the route next action', async () => {
    const hosts = [host('claude', 'follow'), host('codex', null, 'unbalanced')];
    await mount({
      ...props(server(settings(), [])),
      readReportingLanguage: async (): Promise<LanguageRead<readonly ReportingHost[]>> => ({ state: 'ok', value: hosts }),
      writeReportingLanguage: async () => refused('report_language_refused', 'Repair the reported rules file or path, then save the reporting language again.'),
    });
    await click(document.querySelector<HTMLElement>('[data-language-control="report"] [data-language-option="zh-CN"]')!);
    expect(document.querySelector('[data-language-host="codex"]')?.getAttribute('data-language-host-state')).toBe('unbalanced');
    const banner = document.querySelector('[data-language-control="report"] [data-save-result="report_language_refused"]')!;
    expect(banner.textContent).toContain('Repair the file named in the host list');
  });

  test('an edited managed block refusal names the cause and the deletion repair', async () => {
    await mount({
      ...props(server(settings(), [])),
      readReportingLanguage: async (): Promise<LanguageRead<readonly ReportingHost[]>> => ({ state: 'ok', value: [host('codex', null, 'managed-stale')] }),
      writeReportingLanguage: async () => refused('report_language_edited', 'Server text.'),
    });
    await click(document.querySelector<HTMLElement>('[data-language-control="report"] [data-language-option="en"]')!);
    const banner = document.querySelector('[data-language-control="report"] [data-save-result="report_language_edited"]')!;
    expect(banner.textContent).toContain('differs from every released block');
    expect(banner.textContent).toContain('both marker lines');
    expect(banner.textContent!.indexOf('move your own rules')).toBeGreaterThan(-1);
    expect(banner.textContent!.indexOf('move your own rules')).toBeLessThan(banner.textContent!.indexOf('delete the block'));
  });

  test('the repository documentation language loads, saves and shows the init command for a missing policy', async () => {
    const writes: unknown[] = [];
    let stored: DocumentationLanguage = 'follow-user';
    await mount({
      ...props(server(settings(), [])),
      readDocumentationLanguage: id => async (): Promise<LanguageRead<DocumentationLanguage | null>> => (id === REGISTRY.repositories[1]!.repository_id
        ? { state: 'refused', error: { code: 'policy_missing', message: 'Server text.', next_action: 'rh init' } } : { state: 'ok', value: stored }),
      writeDocumentationLanguage: id => async (language, request_id) => {
        writes.push({ id, language, request_id });
        stored = language;
        return { state: 'ok', value: { language } };
      },
    }, '#repositories');
    const first = REGISTRY.repositories[0]!.repository_id;
    const control = (id: string) => `[data-repository-language="${id}"]`;
    expect(pressed(control(first))).toEqual(['follow-user']);
    await click(document.querySelector<HTMLElement>(`${control(first)} [data-language-option="zh-CN"]`)!);
    expect(writes).toEqual([{ id: first, language: 'zh-CN', request_id: expect.stringMatching(UUID) }]);
    expect(pressed(control(first))).toEqual(['zh-CN']);
    const missing = document.querySelector(control(REGISTRY.repositories[1]!.repository_id))!;
    expect(missing.querySelector('[data-save-result="policy_missing"] [data-command] code')?.textContent).toBe('rh init');
    expect(all('[data-language-option]', missing).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe('settings transport', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  function stub(respond: () => Response | Promise<Response>): { calls: { url: string; init: RequestInit | undefined }[] } {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => { calls.push({ url: String(url), init }); return respond(); }) as typeof fetch;
    return { calls };
  }
  const body: AgentsSettingsPost = { request_id: '00000000-0000-4000-8000-000000000001', expected_revision: 'absent', changes: [{ runtime: 'codex', enabled: true, uses: [] }] };

  test('POST sends JSON with the same-origin cookie and maps every answer to one outcome', async () => {
    const { calls } = stub(() => new Response(JSON.stringify({ config_revision: REVISION_B, changed_keys: ['agents.enabled'] }), { status: 200 }));
    expect(await postAgentsSettings(body)).toEqual({ state: 'saved', result: { config_revision: REVISION_B, changed_keys: ['agents.enabled'] } });
    expect(calls[0]!.url).toBe('/api/v1/settings/agents');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual(body);

    stub(() => new Response(JSON.stringify({ error: { code: 'busy', message: 'Another write to this target is running.', next_action: 'Wait.' } }), { status: 503 }));
    expect(await postAgentsSettings(body)).toEqual({ state: 'refused', status: 503, error: { code: 'busy', message: 'Another write to this target is running.', next_action: 'Wait.' } });
    stub(() => new Response('bad gateway', { status: 502 }));
    expect(await postAgentsSettings(body)).toEqual({ state: 'unreachable' });
    stub(() => { throw new TypeError('network'); });
    expect(await postAgentsSettings(body)).toEqual({ state: 'unreachable' });
    stub(() => new Response(JSON.stringify({ config_revision: 'nope', changed_keys: [] }), { status: 200 }));
    expect(await postAgentsSettings(body)).toEqual({ state: 'unreadable' });
  });

  test('GET names an invalid section, a payload that fails the decoder, and an unreachable service', async () => {
    const signal = new AbortController().signal;
    stub(() => new Response(JSON.stringify({ error: { code: 'config_invalid', message: 'x', next_action: 'y' } }), { status: 503 }));
    expect(await fetchAgentsSettings(signal)).toEqual({ state: 'unavailable', reason: 'config_invalid' });
    stub(() => new Response(JSON.stringify({ protocol: 1 }), { status: 200 }));
    expect(await fetchAgentsSettings(signal)).toEqual({ state: 'unavailable', reason: 'settings_invalid' });
    stub(() => { throw new TypeError('network'); });
    expect(await fetchAgentsSettings(signal)).toEqual({ state: 'unavailable', reason: 'unreachable' });
  });

  test('GET quota returns the served report; a busy or invalid refusal and no answer are unreachable; a body that fails the decoder is settings_invalid', async () => {
    const signal = new AbortController().signal;
    const report = busyQuota(NOW);
    const refusal = (code: string, status: number) => () => new Response(JSON.stringify({ error: { code, message: 'x', next_action: 'y' } }), { status });
    const cases: [() => Response, Awaited<ReturnType<typeof fetchQuota>>][] = [
      [() => new Response(JSON.stringify(report), { status: 200 }), { state: 'ok', settings: report }],
      [refusal('quota_busy', 503), { state: 'unavailable', reason: 'unreachable' }],
      [refusal('quota_invalid', 502), { state: 'unavailable', reason: 'unreachable' }],
      [() => { throw new TypeError('network'); }, { state: 'unavailable', reason: 'unreachable' }],
      [() => new Response(JSON.stringify({ ...report, protocol: 'repo-harness.quota.v0' }), { status: 200 }), { state: 'unavailable', reason: 'settings_invalid' }],
    ];
    for (const [respond, expected] of cases) {
      const { calls } = stub(respond);
      expect(await fetchQuota(signal)).toEqual(expected);
      expect(calls[0]!.url).toBe('/api/v1/quota');
    }
  });
});
