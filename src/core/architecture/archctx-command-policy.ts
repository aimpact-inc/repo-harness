type CommandDisposition = {
  readonly disposition: 'pass' | 'owned' | 'refused';
  readonly use?: string;
};

const passCommands = [
  'capabilities', 'init', 'index', 'validate', 'check', 'model', 'context', 'status', 'repo', 'landscape', 'explore', 'prepare',
  'practices', 'checkpoint', 'plan', 'apply', 'hash', 'review', 'complete', 'manifest', 'doctor', 'paths', 'export',
  'resolve', 'impact', 'history', 'flows', 'state-machines', 'deps', 'constraints', 'docs',
] as const;

const owned = (use: string): CommandDisposition => ({ disposition: 'owned', use });
const refused = (use: string): CommandDisposition => ({ disposition: 'refused', use });

export function buildArchctxCommandDispositions(): Readonly<Record<string, CommandDisposition>> {
  return {
    ...Object.fromEntries(passCommands.map(name => [name, { disposition: 'pass' } as CommandDisposition])),
    sync: owned('rh arch projection apply (or rh arch sync --check)'),
    projection: owned('rh arch projection'),
    debt: owned('rh arch debt'),
    verify: owned('rh arch verify'),
    refactor: owned('rh arch refactor'),
    recommendations: owned('rh arch refactor'),
    scan: owned('rh arch refactor'),
    decide: owned('rh arch refactor'),
    install: refused('rh install'),
    uninstall: refused('rh uninstall'),
    update: refused('rh update'),
    hooks: refused('rh install'),
    hook: refused('rh install'),
  };
}

/**
 * The archctx `projection` subcommands that `rh arch projection` does not
 * register. The read-only ones pass; the provider runs stay owned by the
 * registered check, plan and apply.
 */
export const ARCHCTX_PROJECTION_SUBCOMMAND_DISPOSITIONS: Readonly<Record<string, CommandDisposition>> = {
  snapshot: { disposition: 'pass' },
  freshness: { disposition: 'pass' },
  'publish-status': { disposition: 'pass' },
  'verify-pr': { disposition: 'pass' },
  slice: { disposition: 'pass' },
  run: owned('rh arch projection check|plan|apply'),
};

const SYNC_READONLY_FLAGS: ReadonlySet<string> = new Set(['--check', '--help', '-h']);
const SYNC_VALUE_FLAGS: ReadonlySet<string> = new Set(['--changed', '--format']);

export function hasStandaloneSyncFlag(rest: readonly string[]): boolean {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined || token === '--') return false;
    if (SYNC_VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (SYNC_READONLY_FLAGS.has(token)) return true;
  }
  return false;
}
