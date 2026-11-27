import { createHash } from 'crypto';
import { readdirSync, readFileSync, readlinkSync } from 'fs';
import { join } from 'path';
import { parseJsonText } from '../../core/evidence/file-syntax';

export interface CandidatePackageIdentityRecord {
  readonly root: string;
  readonly version: string;
  readonly package_digest: string;
}

function packageTreeDigest(root: string): string {
  const hash = createHash('sha256');
  const excludedDirectories = new Set(['.ai', '.codegraph', '.git', 'node_modules', '_ops']);
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`D\0${relative}\0`);
        visit(path, relative);
      } else if (entry.isSymbolicLink()) {
        hash.update(`L\0${relative}\0${readlinkSync(path)}\0`);
      } else if (entry.isFile()) {
        hash.update(`F\0${relative}\0`);
        hash.update(readFileSync(path));
        hash.update('\0');
      }
    }
  };
  visit(root, '');
  return `sha256:${hash.digest('hex')}`;
}

export function readCandidatePackageIdentity(root: string): CandidatePackageIdentityRecord {
  const packagePath = join(root, 'package.json');
  const raw = readFileSync(packagePath);
  const manifest = parseJsonText(raw.toString('utf-8'), packagePath) as { name?: unknown; version?: unknown };
  if (manifest.name !== 'repo-harness' || typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`candidate package identity is invalid: ${packagePath}`);
  }
  return {
    root,
    version: manifest.version,
    package_digest: packageTreeDigest(root),
  };
}
