import { Command } from 'commander';
import { buildArchitectureDebtCommand } from './architecture-debt';
import { buildArchitectureProjectionCommand } from './architecture-projection';
import { buildModuleCommand } from './module';
import { buildRefactorCommand } from './refactor';
import { buildCodegraphCommand } from './tools';

/**
 * `rh arch <command> [args...]` runs one command of the pinned archctx; the
 * registered repo-harness architecture commands take precedence over that
 * pass-through.
 */
export function buildArchCommand(): Command {
  const arch = new Command('arch')
    .description('Run the architecture commands, or a command of the pinned package-local archctx')
    .argument('[command]', 'archctx command')
    .argument('[args...]', 'arguments passed to archctx unchanged')
    .allowUnknownOption()
    .helpOption(false)
    .action(async () => (await import('./arch-actions')).runArch(process.argv.slice(process.argv.indexOf('arch') + 1)));
  arch.command('verify')
    .description('Report one verdict over the ArchContext checks of a change')
    .option('--base <ref>', 'The commit or ref the change is measured against')
    .option('--json', 'Output the verdict document instead of one line per check')
    .action(async (options: { base?: string; json?: boolean }) => (await import('./arch-verify')).runArchVerify(options));
  // addCommand, not command(): a child made by command() copies this command's settings and would lose its help and strict options.
  for (const child of [buildArchitectureProjectionCommand(), buildArchitectureDebtCommand(), buildModuleCommand(), buildRefactorCommand(), buildCodegraphCommand()]) arch.addCommand(child);
  return arch;
}
