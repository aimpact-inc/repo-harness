// The fleet roles of one Pi seat as pi-subagents role files (#1977). pi-subagents 0.87.0 reads the PATH-style
// `PI_SUBAGENT_EXTRA_AGENT_DIRS` per process, so only the seat that `rh seats argv` launches sees them.
import { sha256Hex } from '../../core/evidence/sha256';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { piRoleName } from '../../core/board/seat-launch';
import { PI_SUB_AGENT_DEFAULTS, isSeatScaffoldSubAgent, piSubAgentModel, type PiSubAgentModels } from '../../core/board/seats-settings';
import { globalConfigurationPath } from '../configuration/global-configuration';
import { parseFrontmatter, validateFrontmatter } from '../terminal/task-role-profiles';

const FLEET_SOURCE_DIR = fileURLToPath(new URL('../../../agents/fleet/', import.meta.url));
const READ_ONLY_TOOLS = 'read, grep, find, ls, bash';

export class PiFleetRolesError extends Error {
  readonly code = 'pi_fleet_role_invalid';
}

/** Render the scaffold role on its configured Pi model with read-only tools. */
function roleFile(role: string, overrides: PiSubAgentModels | undefined): string {
  if (!isSeatScaffoldSubAgent(role)) throw new PiFleetRolesError(`The ${role} fleet role has no Pi model setting.`);
  const { thinking } = PI_SUB_AGENT_DEFAULTS[role];
  const parsed = parseFrontmatter(readFileSync(join(FLEET_SOURCE_DIR, `${role}.md`), 'utf8'));
  const valid = validateFrontmatter(parsed, role);
  if (!valid.ok) throw new PiFleetRolesError(`The ${role} fleet source is invalid: ${valid.reason}.`);
  return [
    '---',
    `name: ${piRoleName(role)}`,
    `description: ${parsed!.description!.replace(` on ${valid.sourceDescription}`, '')}`,
    `model: ${JSON.stringify(piSubAgentModel(role, overrides))}`,
    `thinking: ${thinking}`,
    `tools: ${READ_ONLY_TOOLS}`,
    'systemPromptMode: replace',
    'inheritProjectContext: false',
    'inheritSkills: false',
    '---',
    '',
    parsed!.body,
    '',
  ].join('\n');
}

/**
 * Writes the role files of `fleet` and returns their directory. The directory name holds the digest of the files,
 * so each launch regenerates the same projection of `agents/fleet/` and a concurrent launch writes identical bytes;
 * each file lands by an atomic rename. A source change gives a new directory; nothing reads a stale one.
 */
export function writePiFleetRoles(fleet: readonly string[], env: NodeJS.ProcessEnv = process.env, overrides?: PiSubAgentModels): string {
  const files = fleet.map(role => [`${piRoleName(role)}.md`, roleFile(role, overrides)] as const);
  const digest = sha256Hex(JSON.stringify(files)).slice(0, 16);
  const directory = join(dirname(globalConfigurationPath(env)), 'seats', 'pi-fleet', digest);
  mkdirSync(directory, { recursive: true });
  for (const [name, text] of files) {
    const temporary = join(directory, `.${name}.${process.pid}.tmp`);
    writeFileSync(temporary, text);
    renameSync(temporary, join(directory, name));
  }
  return directory;
}
