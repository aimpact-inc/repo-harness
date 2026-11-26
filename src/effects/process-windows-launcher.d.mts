export interface WindowsPackageShimContract {
  readonly packageName: string;
  readonly binName?: string;
}

export interface WindowsLaunchTarget {
  /** Resolved launcher path on disk (for example `C:\...\pi.CMD`, `C:\...\pi.EXE`, or `/usr/local/bin/pi`). */
  readonly path: string;
  /** Directly spawnable executable without a shell (for example `node.exe` for a `.CMD` shim, else `path`). */
  readonly command: string;
  /** Prefix arguments placed before caller args (for example `[...shimArgs, entryPath]` for a `.CMD` shim, else `[]`). */
  readonly args: readonly string[];
  /** Underlying script or binary entry represented by the launcher (canonical declared bin for a package-backed shim, else `path`). */
  readonly entryPath: string;
  /** Verified canonical package root for a package-backed `.CMD`/`.BAT` shim; null for non-package launchers. */
  readonly packageRoot: string | null;
  /** Clear failure reason when a `.CMD`/`.BAT` file cannot be launched directly without a shell; null when launchable. */
  readonly launchError: string | null;
}

export interface ResolveWindowsLaunchOptions {
  readonly allowCheckoutLocal?: boolean;
  readonly dirPath?: string | null;
  readonly label?: string;
  readonly failOnRefusal?: boolean;
  readonly requireDirectLaunch?: boolean;
  readonly packageBin?: WindowsPackageShimContract;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly repoRoot?: string;
  readonly home?: string;
  readonly checkoutRoots?: readonly string[];
  readonly onRefusal?: (reason: string) => never;
}

export function windowsPathDirectories(
  env?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): string[];

export function windowsPathExtensions(
  env?: NodeJS.ProcessEnv,
  excludeJs?: boolean,
): string[];

export function windowsTargetCheckoutRoots(
  repoRoot: string,
  home?: string,
  platform?: NodeJS.Platform,
): string[];

export function isWindowsCheckoutExcluded(
  candidatePath: string,
  options?: ResolveWindowsLaunchOptions,
): boolean;

export function resolveWindowsLaunchTarget(
  candidatePath: string,
  options?: ResolveWindowsLaunchOptions,
): WindowsLaunchTarget | null;

export function resolveWindowsPathCommand(
  command: string,
  options?: ResolveWindowsLaunchOptions,
): WindowsLaunchTarget | null;
