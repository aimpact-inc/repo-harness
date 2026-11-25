import { spawnSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const PACKAGE_NAME = 'repo-harness';
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LATEST_VERSION_ENV = 'REPO_HARNESS_LATEST_VERSION';
const VERSION_SHAPE = /^v?\d+\.\d+\.\d+(?:[-+].*)?$/;

/** Semver precedence of two x.y.z versions, pre-release included; null when either is not one. */
export function compareVersions(a: string, b: string): number | null {
  const left = a.trim();
  const right = b.trim();
  if (!VERSION_SHAPE.test(left) || !VERSION_SHAPE.test(right)) return null;
  return Bun.semver.order(left, right);
}

export function readLatestPackageVersion(env?: NodeJS.ProcessEnv): { version?: string; error?: string } {
  const activeEnv = env ?? process.env;
  if (activeEnv[LATEST_VERSION_ENV]) {
    return { version: activeEnv[LATEST_VERSION_ENV] };
  }

  const result = spawnSync(process.execPath, [
    'pm',
    'view',
    PACKAGE_NAME,
    'version',
    '--json',
    '--registry=https://registry.npmjs.org',
  ], {
    encoding: 'utf-8',
    timeout: 5000,
    cwd: PACKAGE_ROOT,
    env: activeEnv,
  });
  if (result.status !== 0 || result.error) {
    return { error: result.stderr || result.stdout || String(result.error?.message ?? result.error ?? 'npm view failed') };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return { version: typeof parsed === 'string' ? parsed : String(parsed) };
  } catch {
    return { version: result.stdout.trim().replace(/^"|"$/g, '') };
  }
}
