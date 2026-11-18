/**
 * Claude Code hook-runtime target.
 *
 * Writes route-registry managed adapter entries under the `hooks` field of
 * ~/.claude/settings.json (--location global). Phase 0 verified Claude auto-reloads
 * settings.json via ConfigChange seconds after a write, no restart needed.
 *
 * `settings.json` carries non-hook config too (themes, MCP, etc.). Each managed
 * entry and the status line are host-config fragments: the gate inserts their
 * text and leaves every other byte, so sibling user hook entries survive
 * (Phase 0 baseline showed a sibling `rtk hook claude` entry that must survive).
 */

import * as fs from 'fs';
import * as path from 'path';
import { requireHome } from '../../../effects/repo-harness-home';
import { jsonFragment } from '../../../core/host-config/json-fragment';
import { NO_OVERRIDES } from '../../../core/host-config/override';
import type { FragmentRequest } from '../../../core/host-config/types';
import type { HostConfigFileChange } from '../../../effects/host-config/gate';
import { migrateJsonConfigRecords } from '../json-config-migration';
import type {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from '../types';
import { readJsonOrEmpty } from '../shared';
import {
  applyManagedHooks,
  buildHookExecCommand,
  isManagedEntry,
  managedHookRequests,
  managedStatusLine,
  overridesOf,
  type HooksByEvent,
} from '../managed-entries';

interface SettingsFile {
  hooks?: HooksByEvent;
  [key: string]: unknown;
}

function userConfigPath(loc: Location): string {
  if (loc !== 'global') {
    throw new Error('claudeTarget: hook adapters require --location global');
  }
  // Prefer $HOME env so tests can isolate via temp dirs; os.homedir() is
  // cached and ignores runtime $HOME mutations in some Node/Bun versions.
  return path.join(requireHome(), '.claude', 'settings.json');
}

/** The documented one-line pipe that keeps an existing status line and also writes the quota capture. */
export const CLAUDE_STATUS_LINE_PIPE = `input=$(cat); printf '%s' "$input" | repo-harness-hook statusline >/dev/null; printf '%s' "$input" | <your status line command>`;

/**
 * rh adds the status line only when none exists, and refreshes only the one
 * it recorded; a status line that rh did not write is the user's (R4).
 */
function statusLineFragment(content: string, isSelected: (selector: string) => boolean): FragmentRequest {
  return {
    owner: 'core',
    selector: 'statusLine',
    kind: jsonFragment.locate(content, 'statusLine') ? 'refresh' : 'add',
    strategy: jsonFragment,
    value: managedStatusLine(),
    selected: isSelected('statusLine'),
  };
}

function readSettings(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
}

class ClaudeTarget implements AgentTarget {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    const filePath = userConfigPath(loc);
    const installed = fs.existsSync(path.dirname(filePath));
    let alreadyConfigured = false;
    if (fs.existsSync(filePath)) {
      try {
        const data = readJsonOrEmpty<SettingsFile>(filePath);
        for (const entries of Object.values(data.hooks ?? {})) {
          if ((entries ?? []).some(isManagedEntry)) {
            alreadyConfigured = true;
            break;
          }
        }
      } catch {
        // Invalid JSON: leave alreadyConfigured false.
      }
    }
    return { installed, alreadyConfigured, configPath: filePath };
  }

  hostConfigChanges(loc: Location, opts: InstallOptions): HostConfigFileChange[] {
    const filePath = userConfigPath(loc);
    const content = readSettings(filePath);
    const isSelected = overridesOf(opts.overrides ?? NO_OVERRIDES, filePath, process.env);
    return [{ path: filePath, fragments: [...managedHookRequests('claude', content, isSelected), statusLineFragment(content, isSelected)] }];
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const filePath = userConfigPath(loc);
    const overrides = opts.overrides ?? NO_OVERRIDES;
    // An unresolved hook runtime stops the install before the migration writes.
    buildHookExecCommand(process.env);
    migrateJsonConfigRecords(process.env);
    const created = !fs.existsSync(filePath);
    const statusLine = statusLineFragment(readSettings(filePath), overridesOf(overrides, filePath, process.env));
    const result = applyManagedHooks(filePath, 'claude', [statusLine], process.env, overrides);
    const notes = [...result.refreshed, ...(result.skipped.some((entry) => entry.selector === 'statusLine')
      ? [`statusLine exists and is not changed. To capture Claude quota, set its command to: ${CLAUDE_STATUS_LINE_PIPE}`]
      : [])];
    if (!result.written.length) {
      return { files: [{ path: filePath, action: 'unchanged' }], ...(notes.length ? { notes } : {}) };
    }
    return {
      files: [{ path: filePath, action: created ? 'created' : 'updated' }],
      notes: [created
        ? 'Claude Code will pick up hooks on next ConfigChange event; no restart needed.'
        : 'Claude Code auto-reloads settings.json on write (verified Phase 0).', ...notes],
    };
  }
}

export const claudeTarget: AgentTarget = new ClaudeTarget();
