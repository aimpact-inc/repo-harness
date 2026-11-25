import { Command } from 'commander';
import { UPGRADE_DECISIONS_PATH } from '../../effects/upgrade/operator-decisions';
import {
  formatUpgradeDecideResult,
  formatUpgradeResult,
  formatUpgradeSummaryLine,
  runUpgrade,
  runUpgradeDecide,
  type UpgradeOptions,
} from './upgrade';
import { formatRegisteredUpgradeResult, runRegisteredUpgrade } from './upgrade-registered';

function buildUpgradeDecideCommand(): Command {
  return new Command('decide')
    .description(`Record keep or remove for project upgrade report items in ${UPGRADE_DECISIONS_PATH}`)
    .argument('<paths...>', 'Paths that upgrade --scope project reports')
    .option('--keep', 'Keep the items; upgrade stops reporting them while their bytes stay the same')
    .option('--remove', 'Remove the regular files on the next upgrade --scope project --apply')
    .action((paths: string[], opts: { keep?: boolean; remove?: boolean }, command: Command) => {
      // The parent upgrade command owns --json, and commander gives it options after the subcommand too.
      const json = command.optsWithGlobals<{ json?: boolean }>().json === true;
      if (opts.keep === opts.remove) {
        process.stderr.write('rh upgrade decide: choose exactly one of --keep or --remove\n');
        process.exitCode = 2;
        return;
      }
      const result = runUpgradeDecide({ decision: opts.keep ? 'keep' : 'remove', paths });
      process.stdout.write(formatUpgradeDecideResult(result, json));
      process.exitCode = result.exitCode;
    });
}

type UpgradeCommandOptions = UpgradeOptions & { json?: boolean; summaryLine?: boolean; registered?: boolean; expectedRevision?: string; pr?: boolean };

function runRegisteredUpgradeCommand(opts: UpgradeCommandOptions, command: Command): void {
  // Each registered repo always runs at project scope; the global surfaces belong to plain `upgrade`.
  const conflict = command.getOptionValueSource('scope') === 'cli' ? '--scope'
    : opts.includeStateArtifacts === true ? '--include-state-artifacts' : undefined;
  if (conflict) {
    process.stderr.write(`rh upgrade --registered: ${conflict} is not supported; each registered repo runs at project scope\n`);
    process.exitCode = 2;
    return;
  }
  const result = runRegisteredUpgrade({ apply: opts.apply, expectedRevision: opts.expectedRevision, pr: opts.pr, callerCwd: process.cwd() });
  process.stdout.write(formatRegisteredUpgradeResult(result, opts.json));
  if (result.error && opts.json) process.stderr.write(`${result.error}\n`);
  process.exitCode = result.exitCode;
}

export function buildUpgradeCommand(): Command {
  return new Command('upgrade')
    .description('Check retired repo-harness surfaces and remove only verified owned copies')
    .option('--scope <scope>', 'project|global|all', 'all')
    .option('--apply', 'Back up and remove verified owned leftovers')
    .option('--include-state-artifacts', 'Include proven owned obsolete state artifacts with --apply')
    .option('--registered', 'Preview init refresh and project upgrade for every registered repo; commits only with --pr')
    .option('--expected-revision <digest>', 'With --registered --apply: exact plan revision from the preview')
    .option('--pr', 'With --registered --apply: refresh each repo in a temporary worktree, push repo-harness/refresh and open or update its PR; never merges')
    .option('--json', 'Print JSON')
    .option('--summary-line', 'Print the one-line check summary that rh update shows')
    .action((opts: UpgradeCommandOptions, command: Command) => {
      if (opts.registered === true) {
        runRegisteredUpgradeCommand(opts, command);
        return;
      }
      if (opts.expectedRevision !== undefined || opts.pr === true) {
        process.stderr.write(`rh upgrade: ${opts.pr === true ? '--pr' : '--expected-revision'} needs --registered\n`);
        process.exitCode = 2;
        return;
      }
      const result = runUpgrade(opts, {
        beforeLegacyWorktreeRemove: (candidate) => process.stderr.write(`Removing legacy worktree ${candidate.path}; rebuild: ${candidate.rebuild}\n`),
      });
      process.stdout.write(opts.summaryLine === true ? `${formatUpgradeSummaryLine(result)}\n` : formatUpgradeResult(result, opts.json));
      if (result.error && opts.json && !result.apply) process.stderr.write(`${result.error}\n`);
      process.exitCode = result.exitCode;
    })
    .addCommand(buildUpgradeDecideCommand());
}
