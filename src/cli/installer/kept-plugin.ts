import type { PluginId } from '../../core/skill-surface/plugin-manifest';

/** A recorded host plugin of the `all` selection whose host program or target is now absent. */
export interface KeptPlugin {
  readonly id: PluginId;
  readonly reason: string;
  /** The explicit selection that removes the plugin. */
  readonly command: string;
}

export function keptPluginLine(entry: KeptPlugin): string {
  return `kept ${entry.id}: ${entry.reason}; update keeps the recorded plugin; to remove it, run: ${entry.command}`;
}
