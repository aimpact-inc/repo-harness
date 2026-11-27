import { AGENT_RUNTIME_CAPABILITIES, decodeAgentsSettings, type AgentsSettingsV1 } from '../../core/board/agents-settings';
import {
  SEAT_OVERRIDES_KIND,
  SEAT_OVERRIDES_PROTOCOL,
  SeatOverrideValidationError,
  applySeatOverrideToConfig,
  applySeatOverrides,
  decodeSeatOverrideResult,
  decodeSeatOverrideRevokeRequest,
  decodeSeatOverrideSetRequest,
  decodeSeatOverridesResponse,
  type SeatOverridesResponseV1,
  type SeatOverridesV1,
} from '../../core/board/seat-overrides';
import { isReviewRuntimeId } from '../../core/review/review-runtimes';
import { ALLOWED_SEAT_FLEET_ROLES, COUNCIL_TOOLS, DEFAULT_SEATS_CONFIG, FRONTEND_SEAT_IDS, ROUTING_CLASSES, SEAT_IDS, SEAT_SCAFFOLD_SUB_AGENTS, WORKER_SEAT_IDS, decodeSeatsSettings, seatHostId, type SeatsConfigV1, type SeatsSettingsRequestV1, type SeatsSettingsV1 } from '../../core/board/seats-settings';
import { SEAT_RECOMMENDED_MODELS } from '../../core/board/recommended-models';
import type { DocumentationLanguage, DocumentationLanguageReader, DocumentationLanguageWriter, LanguageRead, LanguageReader, LanguageWriter, ReportingHost, ReportingPreset } from '../language-settings';
import type { OperatorApiErrorV1 } from '../operator-api-error';
import type { SeatOverrideRevokePost, SeatOverrideSetPost, SeatOverrideWrite } from '../seats';
import type { AgentsSettingsRead, AgentsSettingsWrite, AgentsSettingsPost, SettingsRead, SettingsWrite } from '../settings';

const REVISION = `sha256:${'4'.repeat(64)}`;

const entry = (id: string, group: 'default' | 'community' | 'host_dependency', installation: Record<string, unknown>) => ({
  id, group, installation, review_supported: isReviewRuntimeId(id), docs_supported: false, capabilities: AGENT_RUNTIME_CAPABILITIES,
});

/** The probe of one machine: the 7 OAR defaults, Mister Morph, and the two runtimes that need optional packages. */
function entries() {
  return [
    entry('antigravity', 'default', { kind: 'not_found' }),
    entry('claude', 'default', { kind: 'available', via: 'executable', version: '2.1.3' }),
    entry('codex', 'default', { kind: 'available', via: 'executable', version: '0.71.0' }),
    entry('grok', 'default', { kind: 'not_found' }),
    entry('kimi', 'default', { kind: 'available', via: 'executable', version: '1.4.0' }),
    entry('opencode', 'default', { kind: 'unsupported', reason: 'opencode v2 needs a newer server' }),
    entry('pi', 'default', { kind: 'available', via: 'bundled', version: null }),
    entry('morph', 'community', { kind: 'host_setup_required' }),
    entry('cursor', 'host_dependency', { kind: 'dependency_missing', package: '@cursor/sdk' }),
    entry('pi-durable', 'host_dependency', { kind: 'dependency_missing', package: '@earendil-works/pi-durable' }),
  ];
}

/** busy: codex reviews and claude reviews. degraded: the last probe timed out, and the section names a runtime the probe no longer lists. No runtime is docs-supported: the docs host is closed. */
export function agentsSettingsFixture(now: number, fixture: 'busy' | 'degraded'): AgentsSettingsV1 {
  const collected = new Date(now - (fixture === 'busy' ? 4 : 47) * 60_000).toISOString();
  return decodeAgentsSettings({
    protocol: 1,
    kind: 'operator_agents_settings',
    config: fixture === 'busy'
      ? { revision: REVISION, enabled: ['claude', 'codex'], uses: { docs: [], review: ['claude', 'codex'] }, default_docs: null }
      : { revision: REVISION, enabled: ['claude', 'gemini'], uses: { docs: [], review: ['claude'] }, default_docs: null },
    runtimes: fixture === 'busy'
      ? { status: 'ready', reason: null, collected_at: collected, entries: entries() }
      : { status: 'stale', reason: 'probe_timeout', collected_at: collected, entries: entries() },
  });
}

/** The native agy catalog: base models with their effort menus, and the suffixed ids that each take one effort. */
const AGY_BASE_MODELS = [
  { id: 'gemini-4-neon', efforts: ['high', 'xhigh'] },
  { id: 'gemini-4-carbon', efforts: ['high'] },
  { id: 'gemini-4-hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] },
];
const AGY_CATALOG = [...AGY_BASE_MODELS, ...AGY_BASE_MODELS.flatMap(({ id, efforts }) => efforts.map(effort => ({ id: `${id}-${effort}`, efforts: [effort] })))];

/** The Settings ranges for the in-page store. */
function seatsRanges(enabled: readonly string[]) {
  const all = ['read', 'edit', 'shell', 'net', 'tasks', 'schedule', 'mcp', 'gh'];
  return {
    runtimes: [
      { id: 'claude', enabled: enabled.includes('claude'), effort: true, fleet: true },
      { id: 'codex', enabled: enabled.includes('codex'), effort: true, fleet: true },
      { id: 'pi', enabled: enabled.includes('pi'), effort: true, fleet: true },
      { id: 'agy', enabled: enabled.includes(seatHostId('agy')), effort: true, fleet: false },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    agy_models: enabled.includes(seatHostId('agy')) ? AGY_CATALOG : null,
    roles: SEAT_SCAFFOLD_SUB_AGENTS.map(name => ({ name, writable: false })),
    seats: {
      orchestrator: { models: SEAT_RECOMMENDED_MODELS.orchestrator, fleet: ALLOWED_SEAT_FLEET_ROLES.orchestrator, tools: all.filter(tool => tool !== 'edit') },
      advisor: { models: SEAT_RECOMMENDED_MODELS.advisor, fleet: ALLOWED_SEAT_FLEET_ROLES.advisor, tools: all },
      council: { models: SEAT_RECOMMENDED_MODELS.council, fleet: ALLOWED_SEAT_FLEET_ROLES.council, tools: COUNCIL_TOOLS },
      worker: { models: SEAT_RECOMMENDED_MODELS.worker, fleet: ALLOWED_SEAT_FLEET_ROLES.worker, tools: all },
      'worker-deep': { models: SEAT_RECOMMENDED_MODELS['worker-deep'], fleet: ALLOWED_SEAT_FLEET_ROLES['worker-deep'], tools: all },
      'worker-opus': { models: SEAT_RECOMMENDED_MODELS['worker-opus'], fleet: ALLOWED_SEAT_FLEET_ROLES['worker-opus'], tools: all },
      'worker-neon': { models: SEAT_RECOMMENDED_MODELS['worker-neon'], fleet: ALLOWED_SEAT_FLEET_ROLES['worker-neon'], tools: all },
      'worker-neon-deep': { models: SEAT_RECOMMENDED_MODELS['worker-neon-deep'], fleet: ALLOWED_SEAT_FLEET_ROLES['worker-neon-deep'], tools: all },
      'worker-light': { models: SEAT_RECOMMENDED_MODELS['worker-light'], fleet: ALLOWED_SEAT_FLEET_ROLES['worker-light'], tools: all },
      gatekeeper: { models: SEAT_RECOMMENDED_MODELS.gatekeeper, fleet: ALLOWED_SEAT_FLEET_ROLES.gatekeeper, tools: ['net', 'read', 'shell'] },
      'gatekeeper-fallback': { models: SEAT_RECOMMENDED_MODELS['gatekeeper-fallback'], fleet: ALLOWED_SEAT_FLEET_ROLES['gatekeeper-fallback'], tools: ['net', 'read', 'shell'] },
      reviewer: { models: SEAT_RECOMMENDED_MODELS.reviewer, fleet: ALLOWED_SEAT_FLEET_ROLES.reviewer, tools: ['net', 'read', 'shell'] },
    },
    routing: { classes: ROUTING_CLASSES, worker_seats: WORKER_SEAT_IDS, frontend_seats: FRONTEND_SEAT_IDS },
  };
}

type SeatsWrite = SeatsSettingsRequestV1 & { readonly request_id: string };

const CLAUDE_CODEX_SEATS_FIXTURE: SeatsConfigV1 = {
  ...DEFAULT_SEATS_CONFIG,
  advisor: { ...DEFAULT_SEATS_CONFIG.advisor, runtime: 'claude', model: 'opus', effort: 'high' },
  worker: { ...DEFAULT_SEATS_CONFIG.worker, runtime: 'codex', model: 'gpt-6.2-sol' },
  'worker-deep': { ...DEFAULT_SEATS_CONFIG['worker-deep'], runtime: 'codex', model: 'gpt-6.2-sol' },
  'worker-neon': { ...DEFAULT_SEATS_CONFIG['worker-neon'], runtime: 'claude', model: 'opus' },
  'worker-neon-deep': null,
  'worker-light': null,
  gatekeeper: { ...DEFAULT_SEATS_CONFIG.gatekeeper, runtime: 'codex', model: 'gpt-6.2-sol' },
  routing: {
    ...DEFAULT_SEATS_CONFIG.routing,
    important_deep: ['worker-opus', 'worker-neon', 'worker-deep'],
    simple_deep: ['worker-neon', 'worker-deep'],
    important_fast: ['worker-opus', 'worker-neon', 'worker'],
    simple_fast: ['worker'],
  },
};

/**
 * In-page stand-ins for the two settings routes. They share one file, as the
 * real routes do: one revision, and the seats ranges read `enabled` from the
 * agents section. busy applies each change, so a save shows on the next read.
 * empty: no file and no finished detection, so nothing can be saved yet.
 * degraded: every agents save meets the write channel's `reconcile_required`,
 * the stored worker runtime is not enabled, and a seats save meets a revision conflict.
 */
function createSeatOverridesFixture(state: {
  readonly now: number;
  readonly fixture: 'busy' | 'empty' | 'degraded';
  readonly conflictError: OperatorApiErrorV1;
  readonly revision: () => string;
  readonly enabled: () => readonly string[];
  readonly seats: () => SeatsConfigV1;
  readonly overrides: () => SeatOverridesV1;
  readonly commit: (next: SeatOverridesV1) => string;
}) {
  const read = (): Promise<SettingsRead<SeatOverridesResponseV1>> => Promise.resolve({
    state: 'ok',
    settings: decodeSeatOverridesResponse({
      protocol: SEAT_OVERRIDES_PROTOCOL,
      kind: SEAT_OVERRIDES_KIND,
      config_revision: state.revision(),
      overrides: state.overrides(),
    }),
  });
  const write = (body: SeatOverrideSetPost): Promise<SeatOverrideWrite> => {
    if (state.fixture === 'degraded' || body.expected_revision !== state.revision()) return refusal(409, state.conflictError);
    const { request_id: _requestId, ...fields } = body;
    let request;
    try {
      request = decodeSeatOverrideSetRequest(fields);
    } catch (error) {
      if (error instanceof SeatOverrideValidationError) {
        return refusal(422, { code: error.code, message: error.message, next_action: 'Correct the override field, then confirm again.' });
      }
      return refusal(400, { code: 'invalid_body', message: 'The seat override request body is not valid.', next_action: 'Reload settings and retry.' });
    }
    if (!state.enabled().includes(seatHostId(request.runtime))) {
      return refusal(422, {
        code: 'seat_runtime_not_enabled',
        message: `Enable ${request.runtime} under Hosts before authorizing a ${request.seat} override.`,
        next_action: 'Change the named seat to an enabled runtime, or enable its runtime under Hosts and save.',
      });
    }
    const baseSeat = state.seats()[request.seat];
    if (baseSeat === null) {
      return refusal(422, {
        code: 'seat_not_configured',
        message: `Configure the ${request.seat} seat before authorizing a route override.`,
        next_action: 'Configure the seat in Settings before authorizing a route override.',
      });
    }
    const authorized_at = new Date(state.now).toISOString();
    const candidate = {
      runtime: request.runtime,
      model: request.model,
      effort: request.effort,
      authorized_at,
      instruction: request.instruction,
    };
    try {
      applySeatOverrideToConfig(request.seat, baseSeat, candidate);
    } catch (error) {
      if (error instanceof SeatOverrideValidationError) {
        return refusal(422, { code: error.code, message: error.message, next_action: 'Choose a value that the seat settings page offers, then save again.' });
      }
      throw error;
    }
    const revision = state.commit({
      ...state.overrides(),
      [request.seat]: candidate,
    });
    return Promise.resolve({
      state: 'ok',
      value: decodeSeatOverrideResult({
        config_revision: revision,
        seat: request.seat,
        active: true,
        authorized_at,
        changed_keys: [`seat_overrides.${request.seat}`],
      }),
    });
  };
  const revoke = (body: SeatOverrideRevokePost): Promise<SeatOverrideWrite> => {
    if (state.fixture === 'degraded' || body.expected_revision !== state.revision()) return refusal(409, state.conflictError);
    const { request_id: _requestId, ...fields } = body;
    let request;
    try {
      request = decodeSeatOverrideRevokeRequest(fields);
    } catch (error) {
      if (error instanceof SeatOverrideValidationError) {
        return refusal(422, { code: error.code, message: error.message, next_action: 'Confirm explicit owner approval before revoking a seat override.' });
      }
      return refusal(400, { code: 'invalid_body', message: 'The seat override revoke body is not valid.', next_action: 'Reload settings and retry.' });
    }
    if (state.overrides()[request.seat] === undefined) {
      return refusal(404, {
        code: 'seat_override_not_found',
        message: `No active owner override exists for the ${request.seat} seat.`,
        next_action: 'Reload the seat overrides and verify the seat has an active override.',
      });
    }
    const revision = state.commit(
      Object.fromEntries(Object.entries(state.overrides()).filter(([id]) => id !== request.seat)) as SeatOverridesV1,
    );
    return Promise.resolve({
      state: 'ok',
      value: decodeSeatOverrideResult({
        config_revision: revision,
        seat: request.seat,
        active: false,
        authorized_at: null,
        changed_keys: [`seat_overrides.${request.seat}`],
      }),
    });
  };
  return { read, write, revoke };
}

export function settingsStores(now: number, fixture: 'busy' | 'empty' | 'degraded', initialOverrides: SeatOverridesV1 = {}) {
  let agents = fixture === 'empty'
    ? decodeAgentsSettings({
      protocol: 1, kind: 'operator_agents_settings',
      config: { revision: 'absent', enabled: [], uses: { docs: [], review: [] }, default_docs: null },
      runtimes: { status: 'unavailable', reason: 'collection_pending', collected_at: null, entries: [] },
    })
    : agentsSettingsFixture(now, fixture);
  let seats: SeatsConfigV1 = fixture === 'busy'
    ? { ...CLAUDE_CODEX_SEATS_FIXTURE, worker: { ...CLAUDE_CODEX_SEATS_FIXTURE.worker, runtime: 'claude', model: 'opus' } }
    : fixture === 'degraded'
      ? CLAUDE_CODEX_SEATS_FIXTURE
      : DEFAULT_SEATS_CONFIG;
  let overrides: SeatOverridesV1 = { ...initialOverrides };
  let serial = 0;
  const nextRevision = () => { serial += 1; return `sha256:${serial.toString(16).padStart(64, '0')}`; };
  const conflictError: OperatorApiErrorV1 = {
    code: 'revision_conflict', message: 'The configuration changed after it was read.', next_action: 'Reload the settings, then apply your change again.',
  };
  const conflict: SettingsWrite = { state: 'refused', status: 409, error: conflictError };
  const seatsSettings = () => decodeSeatsSettings({
    protocol: 1, kind: 'operator_seats_settings', config: { revision: agents.config.revision, ...seats },
    defaults: DEFAULT_SEATS_CONFIG, ranges: seatsRanges(agents.config.enabled),
  });

  const readAgents = (): Promise<AgentsSettingsRead> => Promise.resolve({ state: 'ok', settings: agents });
  const writeAgents = (body: AgentsSettingsPost): Promise<AgentsSettingsWrite> => {
    if (fixture === 'empty') {
      return Promise.resolve({ state: 'refused', status: 503, error: {
        code: 'runtimes_unavailable', message: 'The runtime list is not collected yet. Nothing was changed.',
        next_action: 'Wait for the runtime probe, then send the change with a new request_id.',
      } });
    }
    if (fixture === 'degraded') {
      return Promise.resolve({ state: 'refused', status: 409, error: {
        code: 'reconcile_required', message: 'The action may have run, but its result is not recorded.',
        next_action: 'Check the target state before you retry. Do not send the request again with a new request_id.',
      } });
    }
    if (body.expected_revision !== agents.config.revision) return Promise.resolve(conflict);
    const { config } = agents;
    const enabled = new Set(config.enabled);
    const docs = new Set(config.uses.docs);
    const review = new Set(config.uses.review);
    for (const change of body.changes) {
      if (change.enabled) enabled.add(change.runtime); else enabled.delete(change.runtime);
      for (const [use, set] of [['docs', docs], ['review', review]] as const) {
        if (change.uses.includes(use)) set.add(change.runtime); else set.delete(change.runtime);
      }
    }
    const affected = SEAT_IDS.flatMap(id => {
      const runtimes = [seats[id]?.runtime, overrides[id]?.runtime].filter((value): value is NonNullable<typeof value> => value !== undefined);
      return [...new Set(runtimes)].flatMap(runtime => config.enabled.includes(seatHostId(runtime)) && !enabled.has(seatHostId(runtime)) ? [`${id} (${runtime})`] : []);
    });
    if (affected.length > 0) {
      return refusal(422, {
        code: 'runtime_in_use', message: `The runtime change would leave ${affected.join(', ')} without an enabled runtime.`,
        next_action: 'Move the listed seats to an enabled runtime in Seats and save before turning off the runtime in Hosts.',
      });
    }
    const revision = nextRevision();
    const next = {
      enabled: [...enabled].sort(), uses: { docs: [...docs].sort(), review: [...review].sort() },
      default_docs: body.default_docs_runtime === undefined ? config.default_docs : body.default_docs_runtime,
    };
    const changedKeys = [
      ...(next.enabled.join() === config.enabled.join() ? [] : ['agents.enabled']),
      ...(next.uses.docs.join() === config.uses.docs.join() ? [] : ['agents.uses.docs']),
      ...(next.uses.review.join() === config.uses.review.join() ? [] : ['agents.uses.review']),
      ...(next.default_docs === config.default_docs ? [] : ['agents.default_docs']),
    ];
    agents = decodeAgentsSettings({ ...agents, config: { revision, ...next } });
    return Promise.resolve({ state: 'saved', result: { config_revision: revision, changed_keys: changedKeys } });
  };

  const readSeats = (): Promise<SettingsRead<SeatsSettingsV1>> => Promise.resolve({ state: 'ok', settings: seatsSettings() });
  const writeSeats = (body: SeatsWrite): Promise<SettingsWrite> => {
    if (fixture === 'degraded' || body.expected_revision !== agents.config.revision) return Promise.resolve(conflict);
    // The route checks every seat against agents.enabled before it writes.
    const off = SEAT_IDS.find(id => {
      const seat = body.seats[id];
      return seat !== null && !agents.config.enabled.includes(seatHostId(seat.runtime));
    });
    if (off !== undefined) {
      return Promise.resolve({ state: 'refused', status: 422, error: {
        code: 'seat_runtime_not_enabled', message: `Fix the ${off} seat before saving. Its runtime ${body.seats[off]!.runtime} is disabled under Hosts.`,
        next_action: 'Change the named seat to an enabled runtime, or enable its runtime under Hosts and save.',
      } });
    }
    const blockedOverride = SEAT_IDS.find(id => body.seats[id] === null && overrides[id] !== undefined);
    if (blockedOverride !== undefined) {
      return refusal(422, {
        code: 'seat_override_active',
        message: `Revoke the active owner override on ${blockedOverride} before turning the seat off.`,
        next_action: 'Revoke the active owner override on the seat before turning it off.',
      });
    }
    try {
      applySeatOverrides(body.seats, overrides);
    } catch (error) {
      if (error instanceof SeatOverrideValidationError) {
        return refusal(422, { code: error.code, message: error.message, next_action: 'Choose a value that the seat settings page offers, then save again.' });
      }
      throw error;
    }
    const revision = nextRevision();
    const changed = SEAT_IDS.flatMap(id => {
      const before = seats[id], after = body.seats[id];
      if (before === null || after === null) return before === after ? [] : [`seats.${id}`];
      return (['runtime', 'model', 'effort', 'tools', 'fleet'] as const)
        .filter(field => String(before[field]) !== String(after[field])).map(field => `seats.${id}.${field}`);
    });
    seats = body.seats;
    agents = decodeAgentsSettings({ ...agents, config: { ...agents.config, revision } });
    return Promise.resolve({ state: 'saved', result: { config_revision: revision, changed_keys: changed } });
  };

  const seatOverrides = createSeatOverridesFixture({
    now,
    fixture,
    conflictError,
    revision: () => agents.config.revision,
    enabled: () => agents.config.enabled,
    seats: () => seats,
    overrides: () => overrides,
    commit: (next) => {
      const revision = nextRevision();
      overrides = next;
      agents = decodeAgentsSettings({ ...agents, config: { ...agents.config, revision } });
      return revision;
    },
  });

  return {
    agents: { read: readAgents, write: writeAgents },
    seats: { read: readSeats, write: writeSeats },
    seatOverrides,
    ...languageStores(fixture),
  };
}

const refusal = (status: number, error: OperatorApiErrorV1) => Promise.resolve({ state: 'refused' as const, status, error });

/**
 * The language routes in the page. degraded: a rules file with unbalanced markers refuses every
 * reporting save; empty: no repository has a policy file yet.
 */
function languageStores(fixture: 'busy' | 'empty' | 'degraded') {
  let preset: ReportingPreset = 'follow';
  const hosts = (): readonly ReportingHost[] => ['claude', 'codex'].map(host => ({
    host, state: fixture === 'degraded' && host === 'codex' ? 'unbalanced' : 'managed-current', preset,
  }));
  const readReporting: LanguageReader<readonly ReportingHost[]> = () => Promise.resolve<LanguageRead<readonly ReportingHost[]>>({ state: 'ok', value: hosts() });
  const writeReporting: LanguageWriter<ReportingPreset> = (next) => {
    if (fixture === 'degraded') {
      return refusal(409, { code: 'report_language_refused', message: 'The codex rules file has unbalanced markers.', next_action: 'Repair the reported rules file or path, then save the reporting language again.' });
    }
    preset = next;
    return Promise.resolve({ state: 'ok', value: { changed_hosts: ['claude', 'codex'] } });
  };
  const languages = new Map<string, DocumentationLanguage>();
  const missing: OperatorApiErrorV1 = { code: 'policy_missing', message: 'The repository policy file is missing.', next_action: 'rh init' };
  const readDocumentation: DocumentationLanguageReader = repositoryId => () => Promise.resolve<LanguageRead<DocumentationLanguage | null>>(
    fixture === 'empty' ? { state: 'refused', error: missing } : { state: 'ok', value: languages.get(repositoryId) ?? 'en' });
  const writeDocumentation: DocumentationLanguageWriter = repositoryId => (language) => {
    if (fixture === 'empty') return refusal(409, missing);
    languages.set(repositoryId, language);
    return Promise.resolve({ state: 'ok', value: { language } });
  };
  return { reporting: { read: readReporting, write: writeReporting }, documentation: { read: readDocumentation, write: writeDocumentation } };
}
