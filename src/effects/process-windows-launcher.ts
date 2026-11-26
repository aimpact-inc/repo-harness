import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface WindowsLaunchTarget {
  /** Resolved launcher path on disk (for example `C:\...\pi.CMD`, `C:\...\pi.EXE`, or `/usr/local/bin/pi`). */
  readonly path: string;
  /** Directly spawnable executable without a shell (for example `node.exe` for a `.CMD` shim, else `path`). */
  readonly command: string;
  /** Prefix arguments placed before caller args (for example `[...shimArgs, entryPath]` for a `.CMD` shim, else `[]`). */
  readonly args: readonly string[];
  /** Underlying script or binary entry represented by the launcher (`entryPath` for a `.CMD` shim, else `path`). */
  readonly entryPath: string;
  /** Clear failure reason when a `.CMD`/`.BAT` file cannot be launched directly without a shell; null when launchable. */
  readonly launchError: string | null;
}

export interface ResolveWindowsLaunchOptions {
  readonly allowCheckoutLocal?: boolean;
  readonly dirPath?: string | null;
  readonly label?: string;
  readonly failOnRefusal?: boolean;
  readonly requireDirectLaunch?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly repoRoot?: string;
  readonly home?: string;
  readonly checkoutRoots?: readonly string[];
  readonly onRefusal?: (reason: string) => never;
}

type ShimParseResult =
  | { readonly ok: true; readonly kind: 'direct'; readonly target: string; readonly stripJsPathext: boolean }
  | {
    readonly ok: true;
    readonly kind: 'interpreter';
    readonly interpreter: string;
    readonly args: readonly string[];
    readonly entryPath: string;
    readonly stripJsPathext: boolean;
  }
  | { readonly ok: false; readonly error: string };

type ResolutionOutcome =
  | { readonly kind: 'resolved'; readonly target: WindowsLaunchTarget }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly reason: string; readonly category: 'checkout' | 'shim' };

const DEFAULT_WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const MAX_SHIM_DEPTH = 4;
const WINDOWS_SHIM_EXT_RE = /\.(cmd|bat)$/i;
const NPM_CMD_SHIM_PREFIX_RE = /^endlocal\s*&\s*goto\s+#_undefined_#\s+2>nul\s*\|\|\s*title\s+%comspec%\s*&\s*/i;
const UNQUOTED_BATCH_METACHAR_RE = /[&|<>^!();]/;

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (env[name] !== undefined) return env[name];
  if (platform !== 'win32') return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

export function windowsPathDirectories(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathValue = envValue(env, 'PATH', platform) ?? '';
  const directories: string[] = [];
  for (const rawDir of pathValue.split(delimiter)) {
    const dir = platform === 'win32' ? rawDir.replace(/^"(.*)"$/, '$1') : rawDir;
    if (dir) directories.push(dir);
  }
  return directories;
}

export function windowsPathExtensions(
  env: NodeJS.ProcessEnv = process.env,
  excludeJs = false,
): string[] {
  const raw = envValue(env, 'PATHEXT', 'win32') || DEFAULT_WINDOWS_PATHEXT;
  return raw
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => Boolean(ext) && (!excludeJs || ext.toLowerCase() !== '.js'));
}

function fileIsExecutable(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (platform !== 'win32') accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutablePath(basePath: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (!basePath) return null;
  if (platform !== 'win32') {
    return fileIsExecutable(basePath, platform) ? basePath : null;
  }
  const extensions = windowsPathExtensions(env);
  const lower = basePath.toLowerCase();
  if (extensions.some((ext) => lower.endsWith(ext.toLowerCase()))) {
    return fileIsExecutable(basePath, platform) ? basePath : null;
  }
  for (const ext of extensions) {
    const candidate = `${basePath}${ext}`;
    if (fileIsExecutable(candidate, platform)) return candidate;
  }
  return fileIsExecutable(basePath, platform) ? basePath : null;
}

function resolveRealPath(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

function stripWindowsExtendedPrefix(value: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return value;
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\[a-zA-Z]:[\\/]/.test(value)) return value.slice(4);
  return value;
}

function isQualifiedInstallPath(value: string): boolean {
  if (sep === '\\') {
    return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\?.][^\\]*\\[^\\]+/.test(value);
  }
  return isAbsolute(value);
}

function isOutsideRelativePath(rel: string): boolean {
  return (
    rel === '..'
    || rel.startsWith(`..${sep}`)
    || (sep === '\\' && rel.startsWith('../'))
    || isAbsolute(rel)
  );
}

function isPathInsideDir(parentDir: string, candidatePath: string, platform: NodeJS.Platform): boolean {
  const parent = resolve(stripWindowsExtendedPrefix(parentDir, platform));
  const candidate = resolve(stripWindowsExtendedPrefix(candidatePath, platform));
  const rel = relative(
    platform === 'win32' ? parent.toLowerCase() : parent,
    platform === 'win32' ? candidate.toLowerCase() : candidate,
  );
  return !isOutsideRelativePath(rel);
}

function targetCheckoutRootFor(startDir: string, homeDirs: readonly string[], platform: NodeJS.Platform): string | null {
  for (let current = startDir; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
  }
  const normalized = platform === 'win32' ? startDir.toLowerCase() : startDir;
  if (homeDirs.includes(normalized) || startDir === dirname(startDir)) {
    return null;
  }
  return startDir;
}

export function windowsTargetCheckoutRoots(
  repoRoot: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const homeDirs = [resolve(home), resolveRealPath(home)]
    .filter((value): value is string => Boolean(value))
    .map((value) => stripWindowsExtendedPrefix(value, platform))
    .map((value) => (platform === 'win32' ? value.toLowerCase() : value));
  const starts = [resolve(repoRoot), resolveRealPath(repoRoot)]
    .filter((value): value is string => Boolean(value))
    .map((value) => stripWindowsExtendedPrefix(value, platform));
  const roots: string[] = [];
  const addRoot = (candidate: string | null) => {
    if (!candidate) return;
    const cleaned = stripWindowsExtendedPrefix(candidate, platform);
    if (!roots.includes(cleaned)) roots.push(cleaned);
  };
  for (const start of starts) {
    const root = targetCheckoutRootFor(start, homeDirs, platform);
    if (root) {
      addRoot(root);
      addRoot(resolveRealPath(root));
    }
  }
  return roots;
}

function realOrResolvedAncestor(targetPath: string): string | null {
  const direct = resolveRealPath(targetPath);
  if (direct) return direct;
  const suffix: string[] = [];
  let current = targetPath;
  while (true) {
    const parent = dirname(current);
    if (parent === current) return null;
    suffix.unshift(basename(current));
    const realParent = resolveRealPath(parent);
    if (realParent) return join(realParent, ...suffix);
    current = parent;
  }
}

function checkoutRefusalReason(
  targetPath: string,
  searchDir: string | null,
  checkoutRoots: readonly string[],
  label: string,
  platform: NodeJS.Platform,
): string | null {
  const normalizedTarget = stripWindowsExtendedPrefix(targetPath, platform);
  const normalizedDir = searchDir ? stripWindowsExtendedPrefix(searchDir, platform) : null;
  if (normalizedDir !== null && !isQualifiedInstallPath(normalizedDir)) {
    return `${label} PATH directory is not a qualified Windows path: ${searchDir}`;
  }
  if (!isQualifiedInstallPath(normalizedTarget)) {
    return `${label} is not a qualified Windows path: ${targetPath}`;
  }
  if (checkoutRoots.length === 0) return null;
  const realDir = normalizedDir ? realOrResolvedAncestor(normalizedDir) : null;
  const realTarget = realOrResolvedAncestor(normalizedTarget);
  const checkPaths = [
    normalizedDir,
    normalizedTarget,
    realDir ? stripWindowsExtendedPrefix(realDir, platform) : null,
    realTarget ? stripWindowsExtendedPrefix(realTarget, platform) : null,
  ].filter((entry): entry is string => Boolean(entry));
  for (const checkoutRoot of checkoutRoots) {
    if (checkPaths.some((entry) => isPathInsideDir(checkoutRoot, entry, platform))) {
      return `refused ${label} inside target checkout (${checkoutRoot}) during read-only Windows probe: ${targetPath}`;
    }
  }
  return null;
}

function stripLeadingAt(line: string): string {
  return line.startsWith('@') ? line.slice(1).trimStart() : line;
}

function isBoilerplateBatchLine(line: string): boolean {
  return /^echo\s+off$/i.test(line)
    || /^goto\s+start$/i.test(line)
    || /^:find_dp0$/i.test(line)
    || /^set\s+(?:"dp0=%~dp0"|dp0=%~dp0)$/i.test(line)
    || /^exit\s+\/b(?:\s+0)?$/i.test(line)
    || /^:start$/i.test(line)
    || /^setlocal$/i.test(line)
    || /^endlocal$/i.test(line)
    || /^call\s+:find_dp0$/i.test(line);
}

function isStripJsPathextLine(line: string): boolean {
  return /^set\s+(?:"pathext=%pathext:;\.js;=;%"|pathext=%pathext:;\.js;=;%)$/i.test(line);
}

function matchProgAssignment(line: string): string | null {
  const match = /^set\s+(?:"_prog=([^"]*)"|_prog=(.+))$/i.exec(line);
  if (!match) return null;
  return (match[1] ?? match[2] ?? '').trim();
}

function expandDp0Path(token: string, shimDir: string): { ok: true; value: string } | { ok: false; error: string } {
  if (/^%(?:~dp0|dp0%)/i.test(token)) {
    const tail = token.replace(/^%(?:~dp0|dp0%)/i, '').replace(/^[\\/]+/, '');
    if (tail.includes('%')) {
      return { ok: false, error: `unexpanded batch variable in path: ${token}` };
    }
    const normalizedTail = tail.replace(/[\\/]+/g, sep);
    return { ok: true, value: normalizedTail ? resolve(shimDir, normalizedTail) : resolve(shimDir) };
  }
  if (token.includes('%')) {
    return { ok: false, error: `unexpanded batch variable in token: ${token}` };
  }
  return { ok: true, value: token };
}

function tokenizeBatchCommandLine(commandLine: string): { ok: true; tokens: string[] } | { ok: false; error: string } {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let inQuotes = false;

  for (let index = 0; index < commandLine.length; index += 1) {
    const ch = commandLine[index]!;
    if (inQuotes) {
      if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    if (UNQUOTED_BATCH_METACHAR_RE.test(ch)) {
      return { ok: false, error: `unsupported batch shell operator "${ch}"` };
    }
    if (ch === '"') {
      inQuotes = true;
      inToken = true;
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inQuotes) {
    return { ok: false, error: 'unterminated quote in launch command' };
  }
  if (inToken) tokens.push(current);
  return { ok: true, tokens };
}

function parseWindowsCommandShim(shimPath: string, content: string): ShimParseResult {
  const shimDir = dirname(shimPath);
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('::') && !/^@?rem(?:\s|$)/i.test(line));

  let progValue: string | null = null;
  let stripJsPathext = false;
  const launchLines: string[] = [];

  const applyBranchLine = (rawLine: string): string | null => {
    const branchLine = stripLeadingAt(rawLine);
    if (/^(?:setlocal|endlocal)$/i.test(branchLine)) return null;
    if (isStripJsPathextLine(branchLine)) {
      stripJsPathext = true;
      return null;
    }
    const assignedProg = matchProgAssignment(branchLine);
    if (assignedProg !== null) {
      if (progValue !== null) return 'duplicate _prog assignment';
      if (!assignedProg) return 'empty _prog assignment';
      progValue = assignedProg;
      return null;
    }
    if (/^set(?:\s|$)/i.test(branchLine)) return `unsupported SET directive: ${branchLine}`;
    if (/^(?:if|for|goto|call)\s|^:/i.test(branchLine) || branchLine === '(' || branchLine === ')') {
      return `unsupported batch control flow: ${branchLine}`;
    }
    launchLines.push(branchLine);
    return null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripLeadingAt(lines[index]!);
    if (isBoilerplateBatchLine(line)) continue;
    if (isStripJsPathextLine(line)) {
      stripJsPathext = true;
      continue;
    }
    const ifMatch = /^if\s+exist\s+("([^"]+)"|([^\s()]+))\s*\($/i.exec(line);
    if (ifMatch) {
      const condRaw = ifMatch[2] ?? ifMatch[3]!;
      const expandedCond = expandDp0Path(condRaw, shimDir);
      if (!expandedCond.ok) return expandedCond;
      const ifBranch: string[] = [];
      const elseBranch: string[] = [];
      let inElse = false;
      let closed = false;
      for (index += 1; index < lines.length; index += 1) {
        const inner = lines[index]!;
        if (/^\)\s*else\s*\($/i.test(inner)) {
          if (inElse) return { ok: false, error: 'malformed IF EXIST ELSE block' };
          inElse = true;
          continue;
        }
        if (inner === ')') {
          const next = lines[index + 1];
          if (!inElse && next && /^else\s*\($/i.test(stripLeadingAt(next))) {
            inElse = true;
            index += 1;
            continue;
          }
          closed = true;
          break;
        }
        (inElse ? elseBranch : ifBranch).push(inner);
      }
      if (!closed) return { ok: false, error: 'unterminated IF EXIST block' };
      const selectedBranch = fileIsExecutable(expandedCond.value, 'win32') ? ifBranch : elseBranch;
      for (const branchLine of selectedBranch) {
        const error = applyBranchLine(branchLine);
        if (error) return { ok: false, error };
      }
      continue;
    }
    const assignedProg = matchProgAssignment(line);
    if (assignedProg !== null) {
      if (progValue !== null) return { ok: false, error: 'duplicate _prog assignment' };
      if (!assignedProg) return { ok: false, error: 'empty _prog assignment' };
      progValue = assignedProg;
      continue;
    }
    if (/^set(?:\s|$)/i.test(line)) return { ok: false, error: `unsupported SET directive: ${line}` };
    if (/^(?:if|for|goto|call)\s|^:/i.test(line) || line === '(' || line === ')') {
      return { ok: false, error: `unsupported batch control flow: ${line}` };
    }
    launchLines.push(line);
  }

  if (launchLines.length === 0) return { ok: false, error: 'no launch command found' };
  if (launchLines.length > 1) return { ok: false, error: 'multiple commands are not supported' };

  const commandLine = stripLeadingAt(launchLines[0]!).replace(NPM_CMD_SHIM_PREFIX_RE, '').trim();
  const tokenized = tokenizeBatchCommandLine(commandLine);
  if (!tokenized.ok) return tokenized;

  const { tokens } = tokenized;
  if (tokens.length < 2 || tokens[tokens.length - 1] !== '%*') {
    return { ok: false, error: 'launch command must forward arguments with %*' };
  }
  const invoke = tokens.slice(0, -1);
  if (invoke[0]!.toLowerCase() === '%_prog%') {
    if (progValue === null) return { ok: false, error: '_prog referenced before assignment' };
    invoke[0] = progValue;
  }

  const expanded: string[] = [];
  for (const token of invoke) {
    const result = expandDp0Path(token, shimDir);
    if (!result.ok) return result;
    expanded.push(result.value);
  }

  if (expanded.length === 1) {
    return { ok: true, kind: 'direct', target: expanded[0]!, stripJsPathext };
  }
  return {
    ok: true,
    kind: 'interpreter',
    interpreter: expanded[0]!,
    args: expanded.slice(1, -1),
    entryPath: expanded[expanded.length - 1]!,
    stripJsPathext,
  };
}

function isBareCommandName(command: string): boolean {
  return !command.includes('/') && !command.includes('\\') && !/^[a-zA-Z]:/.test(command);
}

function envWithoutJsPathext(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    PATHEXT: windowsPathExtensions(env, true).join(';'),
  };
}

function resolveCommandShimTarget(
  shimPath: string,
  options: ResolveWindowsLaunchOptions,
  checkoutRoots: readonly string[],
  platform: NodeJS.Platform,
  visited: ReadonlySet<string>,
): ResolutionOutcome {
  const label = options.label ?? 'executable';
  const env = options.env ?? process.env;
  const shimId = (resolveRealPath(shimPath) ?? resolve(shimPath)).toLowerCase();
  if (visited.has(shimId) || visited.size >= MAX_SHIM_DEPTH) {
    return { kind: 'refused', category: 'shim', reason: `Windows command shim cycle detected for ${label} (${shimPath})` };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(shimId);

  let content: string;
  try {
    content = readFileSync(shimPath, 'utf8');
  } catch (error) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `cannot read Windows command shim for ${label} (${shimPath}): ${(error as Error).message}`,
    };
  }

  const parsed = parseWindowsCommandShim(shimPath, content);
  if (!parsed.ok) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `unsupported Windows command shim for ${label} (${shimPath}): ${parsed.error}`,
    };
  }

  const nestedEnv = parsed.stripJsPathext ? envWithoutJsPathext(env) : env;

  if (parsed.kind === 'direct') {
    const normalizedTarget = stripWindowsExtendedPrefix(parsed.target, platform);
    if (!isQualifiedInstallPath(normalizedTarget)) {
      return {
        kind: 'refused',
        category: 'shim',
        reason: `unsupported Windows command shim for ${label} (${shimPath}): target is not a qualified path: ${parsed.target}`,
      };
    }
    const inner = resolveWindowsLaunchTargetInternal(
      parsed.target,
      { ...options, dirPath: null, env: nestedEnv, label: `${label} shim target`, requireDirectLaunch: true },
      checkoutRoots,
      platform,
      nextVisited,
    );
    if (inner.kind === 'refused') return inner;
    if (inner.kind === 'missing') {
      return {
        kind: 'refused',
        category: 'shim',
        reason: `Windows command shim target is missing for ${label} (${shimPath}): ${parsed.target}`,
      };
    }
    return {
      kind: 'resolved',
      target: {
        path: shimPath,
        command: inner.target.command,
        args: inner.target.args,
        entryPath: inner.target.entryPath,
        launchError: null,
      },
    };
  }

  const normalizedEntry = stripWindowsExtendedPrefix(parsed.entryPath, platform);
  if (!isQualifiedInstallPath(normalizedEntry)) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `unsupported Windows command shim for ${label} (${shimPath}): target is not a qualified path: ${parsed.entryPath}`,
    };
  }
  if (!options.allowCheckoutLocal) {
    const entryRefusal = checkoutRefusalReason(parsed.entryPath, null, checkoutRoots, `${label} shim target`, platform);
    if (entryRefusal) return { kind: 'refused', category: 'checkout', reason: entryRefusal };
  }
  let entryIsFile = false;
  try {
    entryIsFile = statSync(parsed.entryPath).isFile();
  } catch {
    entryIsFile = false;
  }
  if (!entryIsFile) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `Windows command shim target is missing for ${label} (${shimPath}): ${parsed.entryPath}`,
    };
  }
  if (WINDOWS_SHIM_EXT_RE.test(parsed.entryPath)) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `unsupported Windows command shim for ${label} (${shimPath}): target must not be a batch file: ${parsed.entryPath}`,
    };
  }

  const interpOptions: ResolveWindowsLaunchOptions = {
    ...options,
    allowCheckoutLocal: false,
    dirPath: null,
    env: nestedEnv,
    label: `${label} interpreter`,
    requireDirectLaunch: true,
  };
  const interpOutcome = isBareCommandName(parsed.interpreter)
    ? resolveWindowsPathCommandInternal(parsed.interpreter, interpOptions, checkoutRoots, platform, nextVisited)
    : resolveWindowsLaunchTargetInternal(parsed.interpreter, interpOptions, checkoutRoots, platform, nextVisited);

  if (interpOutcome.kind === 'refused') return interpOutcome;
  if (interpOutcome.kind === 'missing') {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `Windows command shim interpreter "${parsed.interpreter}" not found for ${label} (${shimPath})`,
    };
  }

  return {
    kind: 'resolved',
    target: {
      path: shimPath,
      command: interpOutcome.target.command,
      args: [...interpOutcome.target.args, ...parsed.args, parsed.entryPath],
      entryPath: parsed.entryPath,
      launchError: null,
    },
  };
}

function resolveCheckoutRoots(options: ResolveWindowsLaunchOptions, platform: NodeJS.Platform): readonly string[] {
  if (options.checkoutRoots !== undefined) return options.checkoutRoots;
  if (options.repoRoot) {
    const home = options.home ?? options.env?.HOME ?? options.env?.USERPROFILE ?? process.env.HOME ?? process.env.USERPROFILE ?? '';
    return windowsTargetCheckoutRoots(options.repoRoot, home, platform);
  }
  return [];
}

function resolveWindowsLaunchTargetInternal(
  candidatePath: string,
  options: ResolveWindowsLaunchOptions,
  checkoutRoots: readonly string[],
  platform: NodeJS.Platform,
  visited: ReadonlySet<string>,
): ResolutionOutcome {
  if (!candidatePath) return { kind: 'missing' };
  const env = options.env ?? process.env;
  const label = options.label ?? 'executable';
  const dirPath = options.dirPath ?? null;

  if (platform !== 'win32') {
    const resolved = resolveExecutablePath(candidatePath, env, platform);
    if (!resolved) return { kind: 'missing' };
    return {
      kind: 'resolved',
      target: { path: resolved, command: resolved, args: [], entryPath: resolved, launchError: null },
    };
  }

  const qualifiedInput = dirPath === null
    ? (options.repoRoot ? resolve(options.repoRoot, candidatePath) : resolve(candidatePath))
    : candidatePath;

  if (!options.allowCheckoutLocal) {
    const inputRefusal = checkoutRefusalReason(qualifiedInput, dirPath, checkoutRoots, label, platform);
    if (inputRefusal) return { kind: 'refused', category: 'checkout', reason: inputRefusal };
  }

  const resolved = resolveExecutablePath(qualifiedInput, env, platform);
  if (!resolved) return { kind: 'missing' };

  if (!options.allowCheckoutLocal) {
    const resolvedRefusal = checkoutRefusalReason(resolved, dirPath, checkoutRoots, label, platform);
    if (resolvedRefusal) return { kind: 'refused', category: 'checkout', reason: resolvedRefusal };
  }

  if (WINDOWS_SHIM_EXT_RE.test(resolved)) {
    const shimOutcome = resolveCommandShimTarget(resolved, options, checkoutRoots, platform, visited);
    if (shimOutcome.kind === 'resolved') return shimOutcome;
    if (shimOutcome.kind === 'refused' && shimOutcome.category === 'checkout') return shimOutcome;
    const reason = shimOutcome.kind === 'refused'
      ? shimOutcome.reason
      : `unsupported Windows command shim for ${label} (${resolved})`;
    if (options.requireDirectLaunch) {
      return { kind: 'refused', category: 'shim', reason };
    }
    return {
      kind: 'resolved',
      target: { path: resolved, command: resolved, args: [], entryPath: resolved, launchError: reason },
    };
  }

  return {
    kind: 'resolved',
    target: { path: resolved, command: resolved, args: [], entryPath: resolved, launchError: null },
  };
}

function resolveWindowsPathCommandInternal(
  command: string,
  options: ResolveWindowsLaunchOptions,
  checkoutRoots: readonly string[],
  platform: NodeJS.Platform,
  visited: ReadonlySet<string>,
): ResolutionOutcome {
  const env = options.env ?? process.env;
  for (const dir of windowsPathDirectories(env, platform)) {
    const outcome = resolveWindowsLaunchTargetInternal(
      join(dir, command),
      { ...options, dirPath: dir, label: options.label ?? command },
      checkoutRoots,
      platform,
      visited,
    );
    if (outcome.kind === 'resolved') return outcome;
    if (outcome.kind === 'refused' && outcome.category === 'shim') return outcome;
  }
  return { kind: 'missing' };
}

function finalizeOutcome(outcome: ResolutionOutcome, options: ResolveWindowsLaunchOptions): WindowsLaunchTarget | null {
  if (outcome.kind === 'resolved') return outcome.target;
  if (outcome.kind === 'refused' && options.failOnRefusal) {
    if (options.onRefusal) options.onRefusal(outcome.reason);
    throw new Error(outcome.reason);
  }
  return null;
}

/**
 * Single owning Windows launcher rule for executable lookup, read-only checkout
 * exclusion, and shell-free `.CMD`/`.BAT` command-shim unwrapping.
 */
export function resolveWindowsLaunchTarget(
  candidatePath: string,
  options: ResolveWindowsLaunchOptions = {},
): WindowsLaunchTarget | null {
  const platform = options.platform ?? process.platform;
  const checkoutRoots = resolveCheckoutRoots(options, platform);
  const outcome = resolveWindowsLaunchTargetInternal(candidatePath, options, checkoutRoots, platform, new Set());
  return finalizeOutcome(outcome, options);
}

/** Resolve a bare command on PATH through `resolveWindowsLaunchTarget()`. */
export function resolveWindowsPathCommand(
  command: string,
  options: ResolveWindowsLaunchOptions = {},
): WindowsLaunchTarget | null {
  const platform = options.platform ?? process.platform;
  const checkoutRoots = resolveCheckoutRoots(options, platform);
  const outcome = resolveWindowsPathCommandInternal(command, options, checkoutRoots, platform, new Set());
  return finalizeOutcome(outcome, options);
}
