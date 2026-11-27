import { Command } from 'commander';
import {
  AUTOPILOT_LOCAL_AUTHORITY,
  AutopilotError,
  buildAutopilotStatusDocument,
  formatAutopilotStatusText,
  parseAutopilotCadenceMinutes,
  type AutopilotParkedItemV1,
} from '../../core/board/autopilot';
import { readAutopilotState, startAutopilot, stopAutopilot } from '../../effects/board/autopilot-store';

export interface AutopilotCommandPorts {
  readonly cwd?: () => string;
  readonly now?: () => Date;
  readonly readParked?: (repoRoot: string) => readonly AutopilotParkedItemV1[];
}

function handleAutopilotError(error: unknown): void {
  if (!(error instanceof AutopilotError)) throw error;
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.code, message: error.message })}\n`);
  process.exitCode = error.code === 'autopilot_invalid_option' ? 2 : 1;
}

/** Local-only auto-pilot control commands (`rh autopilot start|stop|status`). */
export function buildAutopilotCommand(ports: AutopilotCommandPorts = {}): Command {
  const cwd = ports.cwd ?? (() => process.cwd());
  const now = ports.now ?? (() => new Date());
  const readParked = ports.readParked ?? (() => []);

  const autopilot = new Command('autopilot')
    .description('Manage local repository auto-pilot state and inspect status');

  autopilot.command('start')
    .description('Enable auto-pilot locally for this repository (owner local instruction only)')
    .option('--cadence <minutes>', 'Hourly advisor cadence in minutes (1-1440, default 60)')
    .option('--json', 'Output JSON instead of human-readable text')
    .action((options: { cadence?: string; json?: boolean }) => {
      try {
        const repoRoot = cwd();
        const cadence_minutes = options.cadence === undefined ? undefined : parseAutopilotCadenceMinutes(options.cadence);
        const read = startAutopilot({
          repo_root: repoRoot,
          source: AUTOPILOT_LOCAL_AUTHORITY,
          cadence_minutes,
          now: now(),
        });
        const doc = buildAutopilotStatusDocument({ ...read, parked: readParked(repoRoot) });
        process.stdout.write(options.json === true ? `${JSON.stringify(doc)}\n` : `${formatAutopilotStatusText(doc)}\n`);
      } catch (error) {
        handleAutopilotError(error);
      }
    });

  autopilot.command('stop')
    .description('Disable auto-pilot locally for this repository at once')
    .option('--reason <text>', 'Optional one-line reason for stopping auto-pilot')
    .option('--json', 'Output JSON instead of human-readable text')
    .action((options: { reason?: string; json?: boolean }) => {
      try {
        const repoRoot = cwd();
        const read = stopAutopilot({
          repo_root: repoRoot,
          reason: options.reason ?? null,
          now: now(),
        });
        const doc = buildAutopilotStatusDocument({ ...read, parked: readParked(repoRoot) });
        process.stdout.write(options.json === true ? `${JSON.stringify(doc)}\n` : `${formatAutopilotStatusText(doc)}\n`);
      } catch (error) {
        handleAutopilotError(error);
      }
    });

  autopilot.command('status')
    .description('Show local auto-pilot state, activation time, last tick and parked items')
    .option('--json', 'Output JSON instead of human-readable text')
    .action((options: { json?: boolean }) => {
      try {
        const repoRoot = cwd();
        const read = readAutopilotState(repoRoot);
        const doc = buildAutopilotStatusDocument({ ...read, parked: readParked(repoRoot) });
        process.stdout.write(options.json === true ? `${JSON.stringify(doc)}\n` : `${formatAutopilotStatusText(doc)}\n`);
      } catch (error) {
        handleAutopilotError(error);
      }
    });

  return autopilot;
}
