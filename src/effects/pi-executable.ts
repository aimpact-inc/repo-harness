import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  isWindowsCheckoutExcluded,
  resolveWindowsLaunchTarget,
  resolveWindowsPathCommand,
  windowsPathDirectories,
  windowsPathExtensions,
  type WindowsLaunchTarget,
  type WindowsPackageShimContract,
} from './process-windows-launcher.mjs';

const WINDOWS_SHIM_EXT_RE = /\.(cmd|bat)$/i;

export const PI_PACKAGE_BIN: WindowsPackageShimContract = {
  packageName: '@earendil-works/pi-coding-agent',
  binName: 'pi',
};

export interface PiResolutionOptions {
  readonly repoRoot?: string;
  readonly checkoutRoots?: readonly string[];
}

export interface PiLaunchResolutionOptions extends PiResolutionOptions {
  readonly failOnRefusal?: boolean;
  readonly requireDirectLaunch?: boolean;
}

function piLauncherOptions(env: NodeJS.ProcessEnv, options?: PiLaunchResolutionOptions) {
  return {
    env,
    label: 'pi',
    packageBin: PI_PACKAGE_BIN,
    repoRoot: options?.repoRoot ?? process.cwd(),
    checkoutRoots: options?.checkoutRoots,
    failOnRefusal: options?.failOnRefusal,
    requireDirectLaunch: options?.requireDirectLaunch,
  };
}

function* piCandidates(env: NodeJS.ProcessEnv): Generator<string> {
  const extensions = process.platform === 'win32' ? windowsPathExtensions(env) : [''];
  for (const directory of windowsPathDirectories(env)) {
    for (const extension of extensions) yield join(directory, `pi${extension}`);
  }
}

/** Resolve `pi` on PATH through the shared Windows launcher with checkout exclusion and package-bin checks. */
export function resolvePiPathTarget(
  env: NodeJS.ProcessEnv = process.env,
  options?: PiLaunchResolutionOptions,
): WindowsLaunchTarget | null {
  return resolveWindowsPathCommand('pi', piLauncherOptions(env, options));
}

/** Validate and unwrap an explicit Pi launcher path through the shared Windows launcher. */
export function resolvePiLaunchTarget(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: PiLaunchResolutionOptions,
): WindowsLaunchTarget | null {
  return resolveWindowsLaunchTarget(executable, piLauncherOptions(env, options));
}

/** Resolve one usable executable identity; an absent or checkout-excluded installation is unavailable. */
export function piExecutable(
  env: NodeJS.ProcessEnv = process.env,
  options?: PiResolutionOptions,
): string | null {
  const target = resolvePiPathTarget(env, options);
  if (target === null) return null;
  try {
    if (process.platform === 'win32' && WINDOWS_SHIM_EXT_RE.test(target.path) && lstatSync(target.path).isSymbolicLink()) {
      return target.path;
    }
    return realpathSync(target.path);
  } catch {
    return null;
  }
}

/** Doctor-only explanation for an unavailable Pi installation. */
export function piExecutableIssue(
  env: NodeJS.ProcessEnv = process.env,
  options?: PiResolutionOptions,
): 'PI_EXECUTABLE_DANGLING_SYMLINK' | null {
  const launcherOpts = piLauncherOptions(env, options);
  for (const candidate of piCandidates(env)) {
    if (process.platform === 'win32' && isWindowsCheckoutExcluded(candidate, launcherOpts)) continue;
    try {
      if (!lstatSync(candidate).isSymbolicLink()) continue;
      try { realpathSync(candidate); } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'PI_EXECUTABLE_DANGLING_SYMLINK';
      }
    } catch { /* No PATH entry exists. */ }
  }
  return null;
}
