import { lstatSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { HostConfigError, type PathRecord } from '../../core/host-config/types';
import { ownsPathEntry } from '../host-config/gate';
import { antigravityDirMatches, pathRecordProof } from '../host-config/path-records';
import type { readLedger } from '../host-config/store';
import { observeEntryIdentity } from '../host-config/whole-path';

export const AGY_AGENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'rh-orchestrator': 'Repo-harness orchestrator',
  'rh-advisor': 'Repo-harness advisor',
  'rh-council': 'Repo-harness council',
  'rh-gatekeeper-fallback': 'Repo-harness gatekeeper fallback',
  'rh-worker': 'Repo-harness worker',
};

export function renderAgySeatAgentMarkdown(name: string, description: string, tools: readonly string[], inheritMcp: boolean, body: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'mainAgent: true',
    `tools: [${tools.join(', ')}]`,
    `inheritMcp: ${inheritMcp}`,
    '---',
    '',
    '# System',
    '',
    body,
    '',
  ].join('\n');
}

export function findAgySeatAgentRecord(
  ledger: ReturnType<typeof readLedger>,
  agentsDir: string,
  fileKey: string,
): { readonly key: string; readonly record: PathRecord } | null {
  const direct = ledger.paths[fileKey];
  if (direct) return { key: fileKey, record: direct };
  for (const [key, record] of Object.entries(ledger.paths)) {
    if (record.host === 'antigravity'
      && key.toLowerCase() === fileKey.toLowerCase()
      && antigravityDirMatches(agentsDir, dirname(dirname(key)))) {
      return { key, record };
    }
  }
  return null;
}

export function agySeatAgentRecordIsCurrent(
  ledger: ReturnType<typeof readLedger>,
  record: PathRecord | undefined,
  recordedKey: string,
  expectedFileDigest: string,
  agentDir: string,
): boolean {
  if (record === undefined
    || record.host !== 'antigravity'
    || record.kind !== 'created'
    || record.committed.type !== 'file'
    || record.committed.sha256 !== expectedFileDigest
    || !ownsPathEntry(record, 'core', recordedKey)) {
    return false;
  }
  const dirStat = lstatSync(agentDir, { throwIfNoEntry: false });
  if (!dirStat?.isDirectory()) return false;
  const recordedDir = dirname(recordedKey);
  const expectedDirIdentity = ledger.directory_identities?.[recordedDir] ?? ledger.directory_identities?.[agentDir];
  if (expectedDirIdentity === undefined || observeEntryIdentity(agentDir) !== expectedDirIdentity) return false;
  const entries = readdirSync(agentDir, { withFileTypes: true });
  return entries.length === 1 && entries[0]!.name === 'agent.md' && entries[0]!.isFile();
}

export function refuseExistingAgySeatAgent(
  ledger: ReturnType<typeof readLedger>,
  record: PathRecord | undefined,
  recordedKey: string,
  agentDir: string,
  expectedFileDigest: string,
): never {
  if (!record) {
    throw new HostConfigError('host_config_replacement_refused', `rh has no record of it, so rh does not replace it: ${recordedKey}`);
  }
  if (record.owner !== 'core') {
    throw new HostConfigError('host_config_replacement_refused', `rh records it for ${record.owner}, so rh does not replace it: ${recordedKey}`);
  }
  if (record.kind === 'user_managed') {
    throw new HostConfigError('host_config_replacement_refused', `the user keeps it, so rh does not replace it: ${recordedKey}`);
  }
  if (record.committed.type !== 'file' || record.committed.sha256 !== expectedFileDigest) {
    throw new HostConfigError('host_config_replacement_refused', `the recorded agy agent file differs from its expected digest, so rh does not replace it: ${recordedKey}`);
  }
  const proof = pathRecordProof(recordedKey, record);
  if (proof !== 'current') {
    const reason = proof === 'replaced'
      ? 'it holds the bytes that rh wrote, but it is another file-system entry (a copy or a restore)'
      : proof === 'unproved'
        ? 'rh recorded no identity for it, so nothing proves that rh wrote it'
        : 'it changed since rh wrote it';
    throw new HostConfigError('host_config_replacement_refused', `${reason}, so rh does not replace it: ${recordedKey}`);
  }
  const recordedDir = dirname(recordedKey);
  const expectedDirIdentity = ledger.directory_identities?.[recordedDir] ?? ledger.directory_identities?.[agentDir];
  if (expectedDirIdentity === undefined || observeEntryIdentity(agentDir) !== expectedDirIdentity) {
    throw new HostConfigError('host_config_replacement_refused', `the agy agent directory is another file-system entry (a copy or a restore), so rh does not replace it: ${agentDir}`);
  }
  throw new HostConfigError('host_config_replacement_refused', `the agy agent directory holds unexpected entries, so rh does not replace it: ${agentDir}`);
}
