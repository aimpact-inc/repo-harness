/**
 * Shared CLI validators for `--target`, `--location`, `--mode`.
 *
 * Extracted from repeated inline checks in src/cli/index.ts so every command
 * that accepts these flags validates consistently in one place.
 */

import type { AdapterTargetSpec, InstallCommandOptions, InstallTargetSpec } from './install';
import type { AdoptionMode } from '../../core/adoption/modes';

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

const VALID_TARGETS: readonly InstallTargetSpec[] = ['codex', 'claude', 'both'];

function validateTarget<T extends string>(raw: string, commandName: string, targets: readonly T[]): T {
  const target = targets.find((candidate) => candidate === raw);
  if (target !== undefined) return target;
  console.error(`rh ${commandName}: invalid --target "${raw}" (expected: ${targets.join(', ')})`);
  process.exit(2);
}

export function assertTarget(raw: string, commandName: string): InstallTargetSpec {
  return validateTarget(raw, commandName, VALID_TARGETS);
}

export function assertAdapterTarget(raw: string, commandName: string): AdapterTargetSpec {
  return validateTarget(raw, commandName, [...VALID_TARGETS, 'antigravity']);
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

type Location = InstallCommandOptions['location'];

const VALID_LOCATIONS: readonly Location[] = ['global'];

export function assertLocation(raw: string, commandName: string): Location {
  if ((VALID_LOCATIONS as readonly string[]).includes(raw)) {
    return raw as Location;
  }
  console.error(
    `rh ${commandName}: invalid --location "${raw}" (expected: ${VALID_LOCATIONS.join(', ')})`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Adoption mode
// ---------------------------------------------------------------------------

const VALID_MODES: readonly string[] = ['minimal', 'standard', 'self-host'];

export function assertAdoptionMode(raw: string, commandName: string): AdoptionMode {
  if (VALID_MODES.includes(raw)) {
    return raw as AdoptionMode;
  }
  console.error(
    `rh ${commandName}: invalid --mode "${raw}" (expected: ${VALID_MODES.join(', ')})`,
  );
  process.exit(2);
}
