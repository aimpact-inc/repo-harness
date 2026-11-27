import { isAbsolute } from 'node:path';
import type { Sha256 } from '../../core/host-config/types';

export const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isSha = (value: unknown): value is Sha256 => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
export const isText = (value: unknown): value is string => typeof value === 'string';

export function validBaseline(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.state === 'unknown') return true;
  return value.state === 'known' && (value.existed === false || (value.existed === true && isSha(value.sha256)));
}

function validFileRecord(record: unknown): boolean {
  if (!isObject(record) || !isObject(record.committed)) return false;
  const committed = record.committed;
  return ['created', 'text_block'].includes(record.kind as string) && validBaseline(record.baseline)
    && (committed.type === 'absent' || (committed.type === 'file' && isSha(committed.sha256)))
    && (isSha(record.backup) || record.backup === null)
    && (record.external_backup === undefined || isSha(record.external_backup))
    && typeof record.external_change === 'boolean'
    && (record.format === undefined || record.format === 'toml' || record.format === 'json');
}

export const PATH_RECORD_HOSTS: readonly string[] = ['claude', 'codex', 'pi', 'antigravity', 'staged', 'bin', 'repository'];

export function validPathCommitted(value: unknown): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (value.type === 'file') return keys === 'sha256,type' && isSha(value.sha256);
  if (value.type === 'symlink') return keys === 'target,type' && isText(value.target) && value.target !== '';
  if (value.type !== 'directory') return false;
  return (keys === 'sha256,type' && isSha(value.sha256)) || (keys === 'proof,type' && value.proof === 'herdr-skill-marker');
}

/** `observeEntryIdentity`: device, file id and birth time. */
export const isIdentity = (value: unknown): value is string => isText(value) && /^\d+:\d+:\d+$/u.test(value);

/** `created` is a member path that holds the fragment's container: a prefix of its selector. */
function validCreated(selector: string, created: unknown): boolean {
  return created === undefined || (isText(created) && /^[^.[\]]+(?:\.[^.[\]]+)*$/.test(created)
    && (selector.startsWith(`${created}.`) || selector.startsWith(`${created}[`)));
}

function validFragment(value: unknown): boolean {
  return isObject(value) && isText(value.file) && isText(value.owner) && isText(value.selector)
    && ['add', 'refresh', 'override'].includes(value.kind as string) && isText(value.inserted) && validCreated(value.selector, value.created)
    && (value.preimage === undefined || isText(value.preimage))
    && (value.separator === undefined || value.separator === '\n' || value.separator === '\r\n');
}

/** The text records that every protocol has. */
export function validTextRecords(value: Record<string, unknown>): boolean {
  return isObject(value.files) && Object.entries(value.files).every(([path, record]) => isAbsolute(path) && validFileRecord(record))
    && Array.isArray(value.fragments) && value.fragments.every(validFragment)
    && Array.isArray(value.directories) && value.directories.every((directory) => isText(directory) && isAbsolute(directory));
}

export function validUserPathEntry(value: unknown): boolean {
  if (!isObject(value) || !isText(value.entry) || value.entry === '' || value.entry.includes(';') || !isText(value.inserted)) return false;
  return (value.inserted === value.entry || value.inserted === `;${value.entry}`)
    && (value.kind === 'String' || value.kind === 'ExpandString') && typeof value.value_existed === 'boolean';
}

const validRetired = (value: unknown): boolean => isObject(value) && isSha(value.sha256) && isText(value.at) && !Number.isNaN(Date.parse(value.at));
const validRecovery = (value: unknown): boolean => validRetired(value) && isObject(value) && isText(value.file) && isAbsolute(value.file);
export const validRetirement = (value: Record<string, unknown>): boolean => Array.isArray(value.retired) && value.retired.every(validRetired) && Array.isArray(value.recovery) && value.recovery.every(validRecovery);

export function validDirectoryIdentities(value: Record<string, unknown>): boolean {
  if (value.directory_identities === undefined) return true;
  return isObject(value.directory_identities)
    && Object.entries(value.directory_identities).every(([directory, identity]) => isAbsolute(directory) && isIdentity(identity));
}
