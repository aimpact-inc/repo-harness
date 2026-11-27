import type { JsonValue } from '../../core/evidence/types';
import {
  SEAT_OVERRIDES_KIND,
  SEAT_OVERRIDES_PROTOCOL,
  SeatOverrideValidationError,
  decodeSeatOverrideRevokeRequest,
  decodeSeatOverrideSetRequest,
  decodeSeatOverridesResponse,
  type SeatOverridesResponseV1,
} from '../../core/board/seat-overrides';
import {
  AgySeatSettingsError,
  DEFAULT_SEATS_CONFIG,
  decodeSeatsSettings,
  decodeSeatsSettingsRequest,
  decodeSeatsSettingsResult,
  type SeatsSettingsV1,
} from '../../core/board/seats-settings';
import { SEATS_CONFIG_UPDATE_ACTION } from '../../core/board/seats-settings-migration';
import {
  SeatsConfigurationError,
  agyCatalogModels,
  applySeatOverride,
  applySeatsSettings,
  readSeatPoolCache,
  readSeatsConfiguration,
  revokeSeatOverride,
  seatsRanges,
  type SeatsConfigurationErrorCode,
} from '../board/seats-configuration';
import type { OperatorWriteRoute } from './write-channel';
import { OperatorWriteRefusal } from './write-run';

export const OPERATOR_SETTINGS_SEATS_PATH = '/api/v1/settings/seats' as const;
export const OPERATOR_SETTINGS_SEATS_ROUTE = /^\/api\/v1\/settings\/seats$/u;
export const OPERATOR_SETTINGS_SEAT_OVERRIDES_PATH = '/api/v1/settings/seats/overrides' as const;
export const OPERATOR_SETTINGS_SEAT_OVERRIDES_ROUTE = /^\/api\/v1\/settings\/seats\/overrides$/u;
export const OPERATOR_SETTINGS_SEAT_OVERRIDES_REVOKE_ROUTE = /^\/api\/v1\/settings\/seats\/overrides\/revoke$/u;

const CHOOSE_FROM_RANGES = 'Choose a value that the seat settings page offers, then save again.';

export const SEATS_CONFIGURATION_FAILURES: Readonly<Record<SeatsConfigurationErrorCode, { readonly status: number; readonly next_action: string }>> = Object.freeze({
  busy: { status: 503, next_action: 'Wait for the runtime transaction to end, then send the change with a new request_id.' },
  config_invalid: { status: 503, next_action: 'Fix the agents and seats sections of ~/.repo-harness/config.json, then reload the page.' },
  seats_config_migration_required: { status: 503, next_action: SEATS_CONFIG_UPDATE_ACTION },
  config_is_link: { status: 409, next_action: 'Edit the seats section in the file that ~/.repo-harness/config.json links to, or replace the link with a regular file.' },
  revision_conflict: { status: 409, next_action: 'Reload the settings, then apply your change again.' },
  owner_approval_required: { status: 422, next_action: 'Confirm explicit owner approval before authorizing or revoking a seat override.' },
  seat_override_instruction_invalid: { status: 422, next_action: 'Enter a single-line owner instruction between 1 and 280 characters.' },
  seat_not_configured: { status: 422, next_action: 'Configure the seat in Settings before authorizing a route override.' },
  seat_override_not_found: { status: 404, next_action: 'Reload the seat overrides and verify the seat has an active override.' },
  seat_override_active: { status: 422, next_action: 'Revoke the active owner override on the seat before turning it off.' },
  seat_runtime_not_enabled: { status: 422, next_action: 'Change the named seat to an enabled runtime, or enable its runtime under Hosts and save.' },
  seat_runtime_not_allowed: { status: 422, next_action: 'Use agy only on orchestrator, advisor, council, worker seats, or gatekeeper-fallback.' },
  seat_model_invalid: { status: 422, next_action: 'Choose or type a model for the named field, then save again.' },
  seat_model_retired: { status: 422, next_action: 'Replace the retired model in the named field, then save again.' },
  seat_effort_invalid: { status: 422, next_action: CHOOSE_FROM_RANGES },
  seat_effort_unverified: { status: 503, next_action: 'Sign in to agy so that it lists its models, or set the agy seat effort to Default, then save again.' },
  seat_tool_not_allowed: { status: 422, next_action: CHOOSE_FROM_RANGES },
  seat_fleet_not_allowed: { status: 422, next_action: CHOOSE_FROM_RANGES },
});

/** GET: the stored base catalog section, or the defaults, with its revision, the defaults and the ranges the form may offer. */
export async function readSeatsSettings(env?: NodeJS.ProcessEnv): Promise<SeatsSettingsV1> {
  const { revision, base_seats, enabled_runtimes } = readSeatsConfiguration(env);
  const agyModels = await agyCatalogModels(enabled_runtimes, env);
  const settings = decodeSeatsSettings({ protocol: 1, kind: 'operator_seats_settings', config: { revision, ...base_seats },
    defaults: DEFAULT_SEATS_CONFIG, ranges: seatsRanges(enabled_runtimes, agyModels) });
  const pool = readSeatPoolCache(env);
  return pool === null ? settings : { ...settings, model_pool: pool };
}

/** GET: active owner-authorized seat route overrides and the current config revision (#3641). */
export function readSeatOverridesSettings(env?: NodeJS.ProcessEnv): SeatOverridesResponseV1 {
  const { revision, overrides } = readSeatsConfiguration(env);
  return decodeSeatOverridesResponse({
    protocol: SEAT_OVERRIDES_PROTOCOL,
    kind: SEAT_OVERRIDES_KIND,
    config_revision: revision,
    overrides,
  });
}

/** POST: replaces the `seats` section of the host config. It starts, stops and changes no pane. */
export function seatsSettingsWriteRoute(env?: NodeJS.ProcessEnv): OperatorWriteRoute {
  return {
    id: 'settings_seats_write',
    path: OPERATOR_SETTINGS_SEATS_ROUTE,
    decode(fields) {
      let request;
      try { request = decodeSeatsSettingsRequest(fields); }
      catch (error) {
        if (!(error instanceof AgySeatSettingsError)) throw error;
        const { status, next_action } = SEATS_CONFIGURATION_FAILURES[error.code];
        // SAFETY: the HTTP transport parsed fields from JSON. Bind the full rejected request to its request ID.
        return { operation: 'settings_seats', target: 'config', input: fields as unknown as JsonValue,
          execute: async () => { throw new OperatorWriteRefusal(status, error.code, error.message, next_action); } };
      }
      return {
        operation: 'settings_seats',
        target: 'config',
        input: request as unknown as JsonValue,
        execute: async () => {
          try {
            return { status: 200, body: decodeSeatsSettingsResult(await applySeatsSettings(request, env)) as unknown as JsonValue };
          } catch (error) {
            if (!(error instanceof SeatsConfigurationError)) throw error;
            const failure = SEATS_CONFIGURATION_FAILURES[error.code];
            throw new OperatorWriteRefusal(failure.status, error.code, error.message, failure.next_action);
          }
        },
      };
    },
  };
}

/** POST: authorize one owner seat route override in `~/.repo-harness/config.json#seat_overrides` (#3641). */
export function seatOverridesWriteRoute(env?: NodeJS.ProcessEnv): OperatorWriteRoute {
  return {
    id: 'settings_seat_overrides_write',
    path: OPERATOR_SETTINGS_SEAT_OVERRIDES_ROUTE,
    decode(fields) {
      let request;
      try { request = decodeSeatOverrideSetRequest(fields); }
      catch (error) {
        if (!(error instanceof SeatOverrideValidationError)) throw error;
        const { status, next_action } = SEATS_CONFIGURATION_FAILURES[error.code];
        // SAFETY: the HTTP transport parsed fields from JSON. Bind the full rejected request to its request ID.
        return {
          operation: 'settings_seat_override_set',
          target: 'config',
          input: fields as unknown as JsonValue,
          execute: async () => { throw new OperatorWriteRefusal(status, error.code, error.message, next_action); },
        };
      }
      return {
        operation: 'settings_seat_override_set',
        target: 'config',
        // SAFETY: SeatOverrideSetRequestV1 contains only JSON primitives.
        input: request as unknown as JsonValue,
        execute: async () => {
          try {
            // SAFETY: SeatOverrideResultV1 contains only JSON primitives and string arrays.
            return { status: 200, body: await applySeatOverride(request, env) as unknown as JsonValue };
          } catch (error) {
            if (!(error instanceof SeatsConfigurationError)) throw error;
            const failure = SEATS_CONFIGURATION_FAILURES[error.code];
            throw new OperatorWriteRefusal(failure.status, error.code, error.message, failure.next_action);
          }
        },
      };
    },
  };
}

/** POST: revoke one active owner seat route override, restoring the stored base catalog route (#3641). */
export function seatOverridesRevokeWriteRoute(env?: NodeJS.ProcessEnv): OperatorWriteRoute {
  return {
    id: 'settings_seat_overrides_revoke',
    path: OPERATOR_SETTINGS_SEAT_OVERRIDES_REVOKE_ROUTE,
    decode(fields) {
      let request;
      try { request = decodeSeatOverrideRevokeRequest(fields); }
      catch (error) {
        if (!(error instanceof SeatOverrideValidationError)) throw error;
        const { status, next_action } = SEATS_CONFIGURATION_FAILURES[error.code];
        // SAFETY: the HTTP transport parsed fields from JSON. Bind the full rejected request to its request ID.
        return {
          operation: 'settings_seat_override_revoke',
          target: 'config',
          input: fields as unknown as JsonValue,
          execute: async () => { throw new OperatorWriteRefusal(status, error.code, error.message, next_action); },
        };
      }
      return {
        operation: 'settings_seat_override_revoke',
        target: 'config',
        // SAFETY: SeatOverrideRevokeRequestV1 contains only JSON primitives.
        input: request as unknown as JsonValue,
        execute: async () => {
          try {
            // SAFETY: SeatOverrideResultV1 contains only JSON primitives and string arrays.
            return { status: 200, body: revokeSeatOverride(request, env) as unknown as JsonValue };
          } catch (error) {
            if (!(error instanceof SeatsConfigurationError)) throw error;
            const failure = SEATS_CONFIGURATION_FAILURES[error.code];
            throw new OperatorWriteRefusal(failure.status, error.code, error.message, failure.next_action);
          }
        },
      };
    },
  };
}
