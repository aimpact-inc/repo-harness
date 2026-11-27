import type { BoardTier } from './review-rules';
import { ROUTING_CLASSES, type RoutingClass } from './seats-settings';
import type { TriageManifestDuplicate, TriageManifestIssue } from './triage-apply';

const MODULE_VALUE = /^[a-z0-9][a-z0-9._/-]{0,63}$/u;
const PATTERN_VALUE = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
const REFACTOR_ID_VALUE = /^recommendation\.[a-f0-9]{16}$/u;
const TIERS: readonly BoardTier[] = ['low', 'medium', 'high'];

export type TriageFail = (message: string) => never;

export const isTriageRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function positiveInt(value: unknown, label: string, fail: TriageFail): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a positive integer`);
  return value as number;
}

export function nonEmptyString(value: unknown, label: string, fail: TriageFail): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
  return value.trim();
}

function normalizePath(raw: string, label: string, fail: TriageFail): string {
  if (typeof raw !== 'string' || raw.trim() === '') fail(`${label} must be a non-empty path`);
  return raw.trim().replace(/^\.\//u, '').replace(/\/+$/u, '');
}

export const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'repository',
  'parent',
  'coordinator',
  'baseline',
  'supersedes',
  'issues',
  'duplicates',
  'merge_order',
  'max_parallel_writers',
]);

const ISSUE_KEYS = new Set(['number', 'module', 'tier', 'route', 'pattern', 'attach_to_parent', 'target_files', 'refactor_ids']);
const DUPLICATE_KEYS = new Set(['number', 'canonical', 'reason']);

export function decodeIssue(raw: unknown, index: number, fail: TriageFail): TriageManifestIssue {
  if (!isTriageRecord(raw)) fail(`issues[${index}] must be an object`);
  for (const key of Object.keys(raw)) {
    if (!ISSUE_KEYS.has(key)) fail(`issues[${index}].${key} is not a supported field`);
  }
  const number = positiveInt(raw.number, `issues[${index}].number`, fail);
  const module = nonEmptyString(raw.module, `issues[${index}].module`, fail);
  if (!MODULE_VALUE.test(module)) fail(`issues[${index}].module ${JSON.stringify(module)} is invalid`);
  const tier = nonEmptyString(raw.tier, `issues[${index}].tier`, fail) as BoardTier;
  if (!TIERS.includes(tier)) fail(`issues[${index}].tier must be one of ${TIERS.join(', ')}`);
  const route = nonEmptyString(raw.route, `issues[${index}].route`, fail) as RoutingClass;
  if (!ROUTING_CLASSES.includes(route)) fail(`issues[${index}].route must be one of ${ROUTING_CLASSES.join(', ')}`);
  let pattern: string | null | undefined = undefined;
  if (raw.pattern !== undefined && raw.pattern !== null) {
    const p = nonEmptyString(raw.pattern, `issues[${index}].pattern`, fail);
    if (!PATTERN_VALUE.test(p)) fail(`issues[${index}].pattern ${JSON.stringify(p)} is invalid`);
    pattern = p;
  } else if (raw.pattern === null) {
    pattern = null;
  }
  if (raw.attach_to_parent !== undefined && typeof raw.attach_to_parent !== 'boolean') {
    fail(`issues[${index}].attach_to_parent must be a boolean`);
  }
  let targetFiles: string[] | undefined = undefined;
  if (raw.target_files !== undefined) {
    if (!Array.isArray(raw.target_files)) fail(`issues[${index}].target_files must be an array`);
    targetFiles = [...new Set(raw.target_files.map((entry, pos) => normalizePath(entry as string, `issues[${index}].target_files[${pos}]`, fail)))].sort();
  }
  let refactorIds: string[] | undefined = undefined;
  if (raw.refactor_ids !== undefined) {
    if (!Array.isArray(raw.refactor_ids)) fail(`issues[${index}].refactor_ids must be an array`);
    refactorIds = [...new Set(raw.refactor_ids.map((entry, pos) => {
      const id = nonEmptyString(entry, `issues[${index}].refactor_ids[${pos}]`, fail);
      if (!REFACTOR_ID_VALUE.test(id)) fail(`issues[${index}].refactor_ids[${pos}] ${JSON.stringify(id)} must match recommendation.<16-hex>`);
      return id;
    }))].sort();
  }
  return {
    number,
    module,
    tier,
    route,
    ...(pattern === undefined ? {} : { pattern }),
    ...(raw.attach_to_parent === undefined ? {} : { attach_to_parent: raw.attach_to_parent }),
    ...(targetFiles === undefined ? {} : { target_files: targetFiles }),
    ...(refactorIds === undefined ? {} : { refactor_ids: refactorIds }),
  };
}

export function decodeDuplicate(raw: unknown, index: number, fail: TriageFail): TriageManifestDuplicate {
  if (!isTriageRecord(raw)) fail(`duplicates[${index}] must be an object`);
  for (const key of Object.keys(raw)) {
    if (!DUPLICATE_KEYS.has(key)) fail(`duplicates[${index}].${key} is not a supported field`);
  }
  const number = positiveInt(raw.number, `duplicates[${index}].number`, fail);
  const canonical = positiveInt(raw.canonical, `duplicates[${index}].canonical`, fail);
  if (number === canonical) fail(`duplicates[${index}] cannot mark #${number} as a duplicate of itself`);
  const reason = nonEmptyString(raw.reason, `duplicates[${index}].reason`, fail);
  if (/[\r\n]/u.test(reason)) fail(`duplicates[${index}].reason must be one line`);
  return { number, canonical, reason };
}

export function validateTriageSplitRedLines(
  units: readonly (readonly number[])[],
  issueByNumber: ReadonlyMap<number, TriageManifestIssue>,
  fail: TriageFail,
): void {
  // Validate the three ADR-0006 §6 split red lines before planning any mutation.
  for (const unit of units) {
    if (unit.length < 2) continue;
    const members = unit.map(num => issueByNumber.get(num)!);
    // Red line (a): tier:high never mixes with low/medium and <= 2 issues.
    const hasHigh = members.some(m => m.tier === 'high');
    const hasLower = members.some(m => m.tier !== 'high');
    if (hasHigh && hasLower) {
      fail(`red line violation (tier): bundle [${unit.join(', ')}] mixes tier:high with lower tiers`);
    }
    if (hasHigh && unit.length > 2) {
      fail(`red line violation (tier): tier:high bundle [${unit.join(', ')}] has ${unit.length} issues (max 2)`);
    }
    // Red line (b): route:frontend never mixes with non-frontend routes.
    const hasFrontend = members.some(m => m.route === 'frontend');
    const hasBackend = members.some(m => m.route !== 'frontend');
    if (hasFrontend && hasBackend) {
      fail(`red line violation (route): bundle [${unit.join(', ')}] mixes route:frontend with non-frontend routes`);
    }
  }

  // Red line (c): distinct units that have no dependency ordering edge must not share a target_files entry or refactor_ids entry.
  const unitFiles = units.map(unit => new Set(unit.flatMap(num => issueByNumber.get(num)!.target_files ?? [])));
  const unitRefactors = units.map(unit => new Set(unit.flatMap(num => issueByNumber.get(num)!.refactor_ids ?? [])));
  for (let i = 0; i < units.length; i += 1) {
    const leftFiles = unitFiles[i]!;
    const leftRefactors = unitRefactors[i]!;
    for (let j = i + 1; j < units.length; j += 1) {
      if (leftFiles.size > 0) {
        const rightFiles = unitFiles[j]!;
        const overlap = [...leftFiles].filter(file => rightFiles.has(file)).sort();
        if (overlap.length > 0) {
          fail(`red line violation (target_files): units [${units[i]!.join(', ')}] and [${units[j]!.join(', ')}] share target file ${overlap[0]} with no dependency edge`);
        }
      }
      if (leftRefactors.size > 0) {
        const rightRefactors = unitRefactors[j]!;
        const overlapRefactor = [...leftRefactors].filter(id => rightRefactors.has(id)).sort();
        if (overlapRefactor.length > 0) {
          fail(`red line violation (refactor_ids): units [${units[i]!.join(', ')}] and [${units[j]!.join(', ')}] share refactor decision ${overlapRefactor[0]} with no dependency edge`);
        }
      }
    }
  }
}
