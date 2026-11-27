import {
  COMMAND_PLUGINS,
  installSelectionCommand,
  isCommandPlugin,
  PLUGIN_IDS,
  UPDATE_COMMAND,
  type PluginId,
  type PluginSelection,
} from '../../core/skill-surface/plugin-manifest';

/** A host plugin that the `all` selection does not run or record, because its host program or target is absent. */
export interface SkippedPlugin {
  readonly id: PluginId;
  readonly reason: string;
  /** The command that adds the plugin after the host program is installed. */
  readonly command: string;
}

/** A recorded host plugin of the `all` selection whose host program or target is now absent. */
export interface KeptPlugin {
  readonly id: PluginId;
  readonly reason: string;
  /** The explicit selection that removes the plugin. */
  readonly command: string;
}

export function skippedPluginLine(entry: SkippedPlugin): string {
  const after = entry.command === UPDATE_COMMAND ? 'install the host program, then run' : 'run';
  return `skipped ${entry.id}: ${entry.reason}; to add it later, ${after}: ${entry.command}`;
}

export function keptPluginLine(entry: KeptPlugin): string {
  return `kept ${entry.id}: ${entry.reason}; update keeps the recorded plugin; to remove it, run: ${entry.command}`;
}

export function notAddedPluginLine(id: PluginId): string {
  return `not added ${id} in a partial refresh; run: ${UPDATE_COMMAND}`;
}

/** The O3 repair of an explicit list: one command for every unselected command plugin, because a second command would drop the first id. */
export function commandPluginRepairLines(selection: PluginSelection): string[] {
  if (selection === 'all') return [];
  const missing = COMMAND_PLUGINS.filter(id => !selection.includes(id));
  if (missing.length === 0) return [];
  const repair = installSelectionCommand(PLUGIN_IDS.filter(id => selection.includes(id) || isCommandPlugin(id)));
  return [`[plugins] not selected ${missing.join(', ')}: an explicit list does not grow; to add them, run: ${repair}`];
}
