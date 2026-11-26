import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const DEFAULT_WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const MAX_SHIM_DEPTH = 4;
const WINDOWS_SHIM_EXT_RE = /\.(cmd|bat)$/i;
const NPM_CMD_SHIM_PREFIX_RE = /^endlocal\s*&\s*goto\s+#_undefined_#\s+2>nul\s*\|\|\s*title\s+%comspec%\s*&\s*/i;
const UNQUOTED_BATCH_METACHAR_RE = /[&|<>^!();]/;

function envValue(env, name, platform) {
  if (env[name] !== undefined) return env[name];
  if (platform !== 'win32') return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

export function windowsPathDirectories(env = process.env, platform = process.platform) {
  const pathValue = envValue(env, 'PATH', platform) ?? '';
  const directories = [];
  for (const rawDir of pathValue.split(delimiter)) {
    const dir = platform === 'win32' ? rawDir.replace(/^"(.*)"$/, '$1') : rawDir;
    if (dir) directories.push(dir);
  }
  return directories;
}

export function windowsPathExtensions(env = process.env, excludeJs = false) {
  const raw = envValue(env, 'PATHEXT', 'win32') || DEFAULT_WINDOWS_PATHEXT;
  return raw
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => Boolean(ext) && (!excludeJs || ext.toLowerCase() !== '.js'));
}

function fileIsRegularFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function fileIsDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function pathEntryExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function fileIsExecutable(filePath, platform) {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (platform !== 'win32') accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutablePath(basePath, env, platform) {
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

function resolveRealPath(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

function stripWindowsExtendedPrefix(value, platform) {
  if (platform !== 'win32') return value;
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\[a-zA-Z]:[\\/]/.test(value)) return value.slice(4);
  return value;
}

function isQualifiedInstallPath(value) {
  if (sep === '\\') {
    return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\?.][^\\]*\\[^\\]+/.test(value);
  }
  return isAbsolute(value);
}

function isOutsideRelativePath(rel) {
  return (
    rel === '..'
    || rel.startsWith(`..${sep}`)
    || (sep === '\\' && rel.startsWith('../'))
    || isAbsolute(rel)
  );
}

function isPathInsideDir(parentDir, candidatePath, platform) {
  const parent = resolve(stripWindowsExtendedPrefix(parentDir, platform));
  const candidate = resolve(stripWindowsExtendedPrefix(candidatePath, platform));
  const rel = relative(
    platform === 'win32' ? parent.toLowerCase() : parent,
    platform === 'win32' ? candidate.toLowerCase() : candidate,
  );
  return !isOutsideRelativePath(rel);
}

function sameCanonicalPath(left, right, platform) {
  const normalizedLeft = resolve(stripWindowsExtendedPrefix(left, platform));
  const normalizedRight = resolve(stripWindowsExtendedPrefix(right, platform));
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function targetCheckoutRootFor(startDir, homeDirs, platform) {
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

export function windowsTargetCheckoutRoots(repoRoot, home = '', platform = process.platform) {
  const homeDirs = home
    ? [resolve(home), resolveRealPath(home)]
      .filter(Boolean)
      .map((value) => stripWindowsExtendedPrefix(value, platform))
      .map((value) => (platform === 'win32' ? value.toLowerCase() : value))
    : [];
  const starts = repoRoot
    ? [resolve(repoRoot), resolveRealPath(repoRoot)]
      .filter(Boolean)
      .map((value) => stripWindowsExtendedPrefix(value, platform))
    : [];
  const roots = [];
  const addRoot = (candidate) => {
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

function realOrResolvedAncestor(targetPath) {
  const direct = resolveRealPath(targetPath);
  if (direct) return direct;
  const suffix = [];
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

function checkoutRefusalReason({ targetPath, searchDir, checkoutRoots, label, platform }) {
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
  ].filter(Boolean);
  for (const checkoutRoot of checkoutRoots) {
    if (checkPaths.some((entry) => isPathInsideDir(checkoutRoot, entry, platform))) {
      return `refused ${label} inside target checkout (${checkoutRoot}) during read-only Windows probe: ${targetPath}`;
    }
  }
  return null;
}

function resolveCheckoutRoots(options, platform) {
  if (platform !== 'win32') return [];
  if (options.checkoutRoots !== undefined) return options.checkoutRoots;
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? process.cwd();
  const home = options.home ?? envValue(env, 'HOME', platform) ?? envValue(env, 'USERPROFILE', platform) ?? '';
  return windowsTargetCheckoutRoots(repoRoot, home, platform);
}

/** Report whether a Windows candidate or PATH directory is excluded as unqualified or inside the target checkout. */
export function isWindowsCheckoutExcluded(candidatePath, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return false;
  const checkoutRoots = resolveCheckoutRoots(options, platform);
  return checkoutRefusalReason({
    targetPath: candidatePath,
    searchDir: options.dirPath ?? null,
    checkoutRoots,
    label: options.label ?? 'executable',
    platform,
  }) !== null;
}

function stripLeadingAt(line) {
  return line.startsWith('@') ? line.slice(1).trimStart() : line;
}

function isBoilerplateBatchLine(line) {
  return /^echo\s+off$/i.test(line)
    || /^goto\s+start$/i.test(line)
    || /^:(?:find_dp0|start)$/i.test(line)
    || /^set\s+(?:"dp0=%~dp0"|dp0=%~dp0)$/i.test(line)
    || /^exit\s+\/b(?:\s+0)?$/i.test(line)
    || /^setlocal$/i.test(line)
    || /^endlocal$/i.test(line)
    || /^call\s+:find_dp0$/i.test(line);
}

function isStripJsPathextLine(line) {
  return /^set\s+(?:"pathext=%pathext:;\.js;=;%"|pathext=%pathext:;\.js;=;%)$/i.test(line);
}

function matchProgAssignment(line) {
  const match = /^set\s+(?:"_prog=([^"]*)"|_prog=(.+))$/i.exec(line);
  if (!match) return null;
  return (match[1] ?? match[2] ?? '').trim();
}

function expandDp0Path(token, shimDir) {
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

function tokenizeBatchCommandLine(commandLine) {
  const tokens = [];
  let current = '';
  let inToken = false;
  let inQuotes = false;

  for (let index = 0; index < commandLine.length; index += 1) {
    const ch = commandLine[index];
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

function parseWindowsCommandShim(shimPath, content) {
  const shimDir = dirname(shimPath);
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('::') && !/^@?rem(?:\s|$)/i.test(line));

  let progValue = null;
  let stripJsPathext = false;
  const launchLines = [];

  const applyBranchLine = (rawLine) => {
    const branchLine = stripLeadingAt(rawLine);
    if (/^(?:setlocal|endlocal)$/i.test(branchLine)) return null;
    if (isStripJsPathextLine(branchLine)) {
      stripJsPathext = true;
      return null;
    }
    const assigned = matchProgAssignment(branchLine);
    if (assigned !== null) {
      if (progValue !== null) return 'duplicate _prog assignment';
      if (!assigned) return 'empty _prog assignment';
      progValue = assigned;
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
    const line = stripLeadingAt(lines[index]);
    if (isBoilerplateBatchLine(line)) continue;
    if (isStripJsPathextLine(line)) {
      stripJsPathext = true;
      continue;
    }
    const ifMatch = /^if\s+exist\s+("([^"]+)"|([^\s()]+))\s*\($/i.exec(line);
    if (ifMatch) {
      const condRaw = ifMatch[2] ?? ifMatch[3] ?? '';
      const expandedCond = expandDp0Path(condRaw, shimDir);
      if (!expandedCond.ok) return expandedCond;
      const ifBranch = [];
      const elseBranch = [];
      let inElse = false;
      let closed = false;
      for (index += 1; index < lines.length; index += 1) {
        const inner = lines[index];
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

  const commandLine = stripLeadingAt(launchLines[0]).replace(NPM_CMD_SHIM_PREFIX_RE, '').trim();
  const tokenized = tokenizeBatchCommandLine(commandLine);
  if (!tokenized.ok) return tokenized;

  const { tokens } = tokenized;
  if (tokens.length < 2 || tokens.at(-1) !== '%*') {
    return { ok: false, error: 'launch command must forward arguments with %*' };
  }
  const invoke = tokens.slice(0, -1);
  if (invoke[0].toLowerCase() === '%_prog%') {
    if (progValue === null) return { ok: false, error: '_prog referenced before assignment' };
    invoke[0] = progValue;
  }

  const expanded = [];
  for (const token of invoke) {
    const result = expandDp0Path(token, shimDir);
    if (!result.ok) return result;
    expanded.push(result.value);
  }

  if (expanded.length === 1) {
    return { ok: true, kind: 'direct', target: expanded[0], stripJsPathext };
  }
  return {
    ok: true,
    kind: 'interpreter',
    interpreter: expanded[0],
    args: expanded.slice(1, -1),
    entryPath: expanded.at(-1),
    stripJsPathext,
  };
}

function isBareCommandName(command) {
  return !command.includes('/') && !command.includes('\\') && !/^[a-zA-Z]:/.test(command);
}

function envWithoutJsPathext(env) {
  return {
    ...env,
    PATHEXT: windowsPathExtensions(env, true).join(';'),
  };
}

function parsePackageNameSegments(packageName) {
  if (typeof packageName !== 'string' || !packageName) return null;
  const parts = packageName.split('/');
  if (parts.length === 1) {
    const [name] = parts;
    if (!name || name.startsWith('@') || name.startsWith('.') || name.includes('\\')) return null;
    return [name];
  }
  if (parts.length === 2) {
    const [scope, name] = parts;
    if (!scope || !name || !scope.startsWith('@') || scope.length < 2) return null;
    if (scope === '.' || scope === '..' || name.startsWith('.')) return null;
    if (scope.includes('\\') || name.includes('\\')) return null;
    return [scope, name];
  }
  return null;
}

function unscopedPackageName(packageName) {
  const slash = packageName.indexOf('/');
  return slash === -1 ? packageName : packageName.slice(slash + 1);
}

function isNodeModulesBinDir(dir) {
  return basename(dir).toLowerCase() === '.bin' && basename(dirname(dir)).toLowerCase() === 'node_modules';
}

function layoutNodeModulesRoots(shimPath) {
  const dirs = [];
  const addDir = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  addDir(dirname(shimPath));
  const realShim = resolveRealPath(shimPath);
  if (realShim) addDir(dirname(realShim));

  const roots = [];
  const addRoot = (candidate) => {
    if (candidate && !roots.includes(candidate)) roots.push(candidate);
  };
  for (const dir of dirs) {
    if (isNodeModulesBinDir(dir)) {
      addRoot(dirname(dir));
      continue;
    }
    addRoot(join(dir, 'node_modules'));
    const parent = dirname(dir);
    addRoot(join(parent, 'node_modules'));
    addRoot(join(parent, 'lib', 'node_modules'));
    addRoot(join(parent, 'install', 'global', 'node_modules'));
  }
  return roots;
}

function inferPackageFromNodeModulesRoot(nodeModulesRoot, targetPath, platform) {
  if (!isPathInsideDir(nodeModulesRoot, targetPath, platform)) return null;
  const rel = relative(
    resolve(stripWindowsExtendedPrefix(nodeModulesRoot, platform)),
    resolve(stripWindowsExtendedPrefix(targetPath, platform)),
  );
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0].toLowerCase() === '.bin') return null;
  const segments = parts[0].startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
  if (segments.length === 2 && parts.length < 3) return null;
  const packageName = segments.join('/');
  if (!parsePackageNameSegments(packageName)) return null;
  return { packageName, pkgDir: join(nodeModulesRoot, ...segments) };
}

function resolveDeclaredBinRelativePath(manifest, packageName, binName, exactKeyOnly) {
  if (typeof manifest.bin === 'string') {
    const unscoped = unscopedPackageName(packageName);
    const matches = exactKeyOnly ? unscoped === binName : unscoped.toLowerCase() === binName.toLowerCase();
    return matches ? manifest.bin : null;
  }
  if (!manifest.bin || typeof manifest.bin !== 'object' || Array.isArray(manifest.bin)) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(manifest.bin, binName)) {
    return typeof manifest.bin[binName] === 'string' ? manifest.bin[binName] : null;
  }
  if (!exactKeyOnly) {
    const lower = binName.toLowerCase();
    const matched = Object.entries(manifest.bin).filter(([key]) => key.toLowerCase() === lower);
    if (matched.length === 1 && typeof matched[0][1] === 'string') {
      return matched[0][1];
    }
  }
  return null;
}

function findExpectedPackageDir(shimPath, packageBin) {
  const pkgSegments = parsePackageNameSegments(packageBin.packageName);
  if (!pkgSegments) return { ok: false, pkgDir: null };
  const candidates = layoutNodeModulesRoots(shimPath).map((root) => join(root, ...pkgSegments));
  const matched = candidates.find((candidate) => pathEntryExists(candidate)) ?? null;
  return { ok: true, pkgDir: matched };
}

function validateOwnedPackageBin({ pkgDir, packageName, binName, exactBinKey, shimPath, checkPaths, ctx }) {
  const { options, checkoutRoots, platform } = ctx;
  const label = options.label ?? 'executable';

  if (!options.allowCheckoutLocal) {
    const pkgRefusal = checkoutRefusalReason({
      targetPath: pkgDir,
      searchDir: null,
      checkoutRoots,
      label: `${label} package root`,
      platform,
    });
    if (pkgRefusal) return { kind: 'refused', category: 'checkout', reason: pkgRefusal };
  }

  const realPkgRootRaw = resolveRealPath(pkgDir);
  if (!realPkgRootRaw || !fileIsDirectory(realPkgRootRaw)) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `Windows command shim for ${label} (${shimPath}) references an unusable ${packageName} package root: ${pkgDir}`,
    };
  }
  const realPkgRoot = stripWindowsExtendedPrefix(realPkgRootRaw, platform);

  const manifestPath = join(realPkgRoot, 'package.json');
  const realManifestRaw = resolveRealPath(manifestPath);
  if (!realManifestRaw || !fileIsRegularFile(realManifestRaw) || !isPathInsideDir(realPkgRoot, realManifestRaw, platform)) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `Windows command shim for ${label} (${shimPath}) has a missing or escaping package.json in ${realPkgRoot}`,
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(realManifestRaw, 'utf8'));
  } catch (error) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `Windows command shim for ${label} (${shimPath}) has an unreadable package.json in ${realPkgRoot}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.name !== packageName) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `Windows command shim for ${label} (${shimPath}) expects package "${packageName}" at ${realPkgRoot}, found ${JSON.stringify(manifest?.name ?? null)}`,
    };
  }

  const declaredBinRel = resolveDeclaredBinRelativePath(manifest, packageName, binName, exactBinKey);
  if (!declaredBinRel || !declaredBinRel.trim()) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `Windows command shim for ${label} (${shimPath}) requires package "${packageName}" (${realPkgRoot}) to declare bin "${binName}"`,
    };
  }
  const trimmedBinRel = declaredBinRel.trim();
  if (isAbsolute(trimmedBinRel) || /^[a-zA-Z]:/.test(trimmedBinRel) || /^[\\/]/.test(trimmedBinRel)) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `Windows command shim for ${label} (${shimPath}) has a non-relative declared bin "${binName}" in ${realPkgRoot}: ${trimmedBinRel}`,
    };
  }

  const declaredBinLogical = resolve(realPkgRoot, trimmedBinRel.replace(/[\\/]+/g, sep));
  if (!isPathInsideDir(realPkgRoot, declaredBinLogical, platform)) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `declared bin "${binName}" of ${packageName} escapes package root ${realPkgRoot}: ${trimmedBinRel}`,
    };
  }

  const realDeclaredBinRaw = resolveRealPath(declaredBinLogical);
  if (!realDeclaredBinRaw || !fileIsRegularFile(realDeclaredBinRaw)) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `declared bin "${binName}" of ${packageName} is missing: ${declaredBinLogical}`,
    };
  }
  const realDeclaredBin = stripWindowsExtendedPrefix(realDeclaredBinRaw, platform);
  if (!isPathInsideDir(realPkgRoot, realDeclaredBin, platform)) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `canonical declared bin "${binName}" of ${packageName} escapes canonical package root ${realPkgRoot}: ${realDeclaredBin}`,
    };
  }

  for (const checkPath of checkPaths) {
    const realTargetRaw = resolveRealPath(checkPath);
    if (!realTargetRaw || !fileIsRegularFile(realTargetRaw)) {
      return {
        kind: 'refused',
        category: 'shim',
        reason: `Windows command shim target is missing for ${label} (${shimPath}): ${checkPath}`,
      };
    }
    const realTarget = stripWindowsExtendedPrefix(realTargetRaw, platform);
    if (!isPathInsideDir(realPkgRoot, realTarget, platform)) {
      return {
        kind: 'refused',
        category: 'shim',
        reason: `Windows command shim target for ${label} (${shimPath}) escapes canonical package root ${realPkgRoot}: ${realTarget}`,
      };
    }
    if (!sameCanonicalPath(realTarget, realDeclaredBin, platform)) {
      return {
        kind: 'refused',
        category: 'shim',
        reason: `Windows command shim target for ${label} (${shimPath}) does not match declared bin "${binName}" of ${packageName} (expected ${realDeclaredBin}, got ${realTarget})`,
      };
    }
  }

  return { kind: 'ok', packageRoot: realPkgRoot, canonicalTarget: realDeclaredBin };
}

function verifyShimPackageOwnership({ shimPath, logicalTarget, checkPaths, ctx }) {
  const { options, platform } = ctx;
  const label = options.label ?? 'executable';
  const nmRoots = layoutNodeModulesRoots(shimPath);

  if (options.packageBin) {
    const { packageName } = options.packageBin;
    const found = findExpectedPackageDir(shimPath, options.packageBin);
    if (!found.ok) {
      return {
        kind: 'refused',
        category: 'shim',
        reason: `invalid expected package name for ${label} (${shimPath}): ${String(packageName)}`,
      };
    }
    const binName = options.packageBin.binName ?? unscopedPackageName(packageName);
    if (!found.pkgDir) {
      return {
        kind: 'refused',
        category: 'shim',
        reason: `Windows command shim for ${label} (${shimPath}) has no installed ${packageName} package with declared bin "${binName}" in its installation layout`,
      };
    }
    return validateOwnedPackageBin({
      pkgDir: found.pkgDir,
      packageName,
      binName,
      exactBinKey: true,
      shimPath,
      checkPaths,
      ctx,
    });
  }

  const shimBinName = basename(shimPath).replace(WINDOWS_SHIM_EXT_RE, '');
  const shimDir = dirname(shimPath);
  const realShim = resolveRealPath(shimPath);
  const realShimDir = realShim ? dirname(realShim) : null;

  if (isNodeModulesBinDir(shimDir) || (realShimDir && isNodeModulesBinDir(realShimDir))) {
    const binNmRoot = isNodeModulesBinDir(shimDir) ? dirname(shimDir) : dirname(realShimDir);
    const inferred = inferPackageFromNodeModulesRoot(binNmRoot, logicalTarget, platform);
    if (!inferred) {
      return {
        kind: 'refused',
        category: 'shim',
        reason: `Windows command shim target for ${label} (${shimPath}) escapes package installation layout (${binNmRoot}): ${logicalTarget}`,
      };
    }
    return validateOwnedPackageBin({
      pkgDir: inferred.pkgDir,
      packageName: inferred.packageName,
      binName: shimBinName,
      exactBinKey: false,
      shimPath,
      checkPaths,
      ctx,
    });
  }

  for (const nmRoot of nmRoots) {
    const inferred = inferPackageFromNodeModulesRoot(nmRoot, logicalTarget, platform);
    if (inferred) {
      return validateOwnedPackageBin({
        pkgDir: inferred.pkgDir,
        packageName: inferred.packageName,
        binName: shimBinName,
        exactBinKey: false,
        shimPath,
        checkPaths,
        ctx,
      });
    }
  }

  if (parsePackageNameSegments(shimBinName)) {
    for (const nmRoot of nmRoots) {
      const candidatePkgDir = join(nmRoot, shimBinName);
      if (fileIsRegularFile(join(candidatePkgDir, 'package.json'))) {
        return validateOwnedPackageBin({
          pkgDir: candidatePkgDir,
          packageName: shimBinName,
          binName: shimBinName,
          exactBinKey: false,
          shimPath,
          checkPaths,
          ctx,
        });
      }
    }
  }

  const realTargetRaw = resolveRealPath(checkPaths[0] ?? logicalTarget);
  return {
    kind: 'ok',
    packageRoot: null,
    canonicalTarget: stripWindowsExtendedPrefix(realTargetRaw ?? checkPaths[0] ?? logicalTarget, platform),
  };
}

function resolveCommandShimTarget(shimPath, ctx) {
  const { options, checkoutRoots, platform, visited } = ctx;
  const label = options.label ?? 'executable';
  const env = options.env ?? process.env;
  const shimId = (resolveRealPath(shimPath) ?? resolve(shimPath)).toLowerCase();
  if (visited.has(shimId) || visited.size >= MAX_SHIM_DEPTH) {
    return { kind: 'refused', category: 'shim', reason: `Windows command shim cycle detected for ${label} (${shimPath})` };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(shimId);

  let content;
  try {
    content = readFileSync(shimPath, 'utf8');
  } catch (error) {
    return {
      kind: 'refused',
      category: 'shim',
      reason: `cannot read Windows command shim for ${label} (${shimPath}): ${error instanceof Error ? error.message : String(error)}`,
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
    const shimDir = dirname(shimPath);
    const realShim = resolveRealPath(shimPath);
    const realShimDir = realShim ? dirname(realShim) : null;
    const inNodeModulesBin = isNodeModulesBinDir(shimDir) || Boolean(realShimDir && isNodeModulesBinDir(realShimDir));
    const outerHasExpectedPackage = Boolean(
      options.packageBin && findExpectedPackageDir(shimPath, options.packageBin).pkgDir,
    );
    const delegatePackageBinToInner = Boolean(options.packageBin && !inNodeModulesBin && !outerHasExpectedPackage);
    const inner = resolveWindowsLaunchTargetInternal(parsed.target, {
      options: {
        ...options,
        dirPath: null,
        env: nestedEnv,
        label: `${label} shim target`,
        requireDirectLaunch: true,
        packageBin: delegatePackageBinToInner ? options.packageBin : undefined,
      },
      checkoutRoots,
      platform,
      visited: nextVisited,
    });
    if (inner.kind === 'refused') return inner;
    if (inner.kind === 'missing') {
      return {
        kind: 'refused',
        category: 'shim',
        reason: `Windows command shim target is missing for ${label} (${shimPath}): ${parsed.target}`,
      };
    }
    if (inner.target.packageRoot !== null && !inNodeModulesBin && !outerHasExpectedPackage) {
      return {
        kind: 'resolved',
        target: {
          path: shimPath,
          command: inner.target.command,
          args: inner.target.args,
          entryPath: inner.target.entryPath,
          packageRoot: inner.target.packageRoot,
          launchError: null,
        },
      };
    }
    const ownership = verifyShimPackageOwnership({
      shimPath,
      logicalTarget: parsed.target,
      checkPaths: [inner.target.path, inner.target.entryPath],
      ctx,
    });
    if (ownership.kind === 'refused') return ownership;
    if (ownership.packageRoot !== null && inner.target.args.length > 0) {
      return {
        kind: 'refused',
        category: 'shim',
        reason: `Windows command shim target for ${label} (${shimPath}) must directly target the declared bin: ${parsed.target}`,
      };
    }
    const packageRoot = ownership.packageRoot ?? inner.target.packageRoot;
    const canonicalTarget = ownership.packageRoot !== null ? ownership.canonicalTarget : inner.target.entryPath;
    const directCommand = inner.target.args.length === 0 ? canonicalTarget : inner.target.command;
    return {
      kind: 'resolved',
      target: {
        path: shimPath,
        command: directCommand,
        args: inner.target.args,
        entryPath: canonicalTarget,
        packageRoot,
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
    const entryRefusal = checkoutRefusalReason({
      targetPath: parsed.entryPath,
      searchDir: null,
      checkoutRoots,
      label: `${label} shim target`,
      platform,
    });
    if (entryRefusal) return { kind: 'refused', category: 'checkout', reason: entryRefusal };
  }
  if (!fileIsRegularFile(parsed.entryPath)) {
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

  const ownership = verifyShimPackageOwnership({
    shimPath,
    logicalTarget: parsed.entryPath,
    checkPaths: [parsed.entryPath],
    ctx,
  });
  if (ownership.kind === 'refused') return ownership;

  const interpCtx = {
    options: {
      ...options,
      allowCheckoutLocal: false,
      dirPath: null,
      env: nestedEnv,
      label: `${label} interpreter`,
      requireDirectLaunch: true,
      packageBin: undefined,
    },
    checkoutRoots,
    platform,
    visited: nextVisited,
  };
  const interpOutcome = isBareCommandName(parsed.interpreter)
    ? resolveWindowsPathCommandInternal(parsed.interpreter, interpCtx)
    : resolveWindowsLaunchTargetInternal(parsed.interpreter, interpCtx);

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
      args: [...interpOutcome.target.args, ...parsed.args, ownership.canonicalTarget],
      entryPath: ownership.canonicalTarget,
      packageRoot: ownership.packageRoot,
      launchError: null,
    },
  };
}

function resolveWindowsLaunchTargetInternal(candidatePath, ctx) {
  const { options, checkoutRoots, platform } = ctx;
  if (!candidatePath) return { kind: 'missing' };
  const env = options.env ?? process.env;
  const label = options.label ?? 'executable';
  const dirPath = options.dirPath ?? null;

  if (platform !== 'win32') {
    const resolved = resolveExecutablePath(candidatePath, env, platform);
    if (!resolved) return { kind: 'missing' };
    return {
      kind: 'resolved',
      target: {
        path: resolved,
        command: resolved,
        args: [],
        entryPath: resolved,
        packageRoot: null,
        launchError: null,
      },
    };
  }

  const qualifiedInput = dirPath === null
    ? (options.repoRoot ? resolve(options.repoRoot, candidatePath) : resolve(candidatePath))
    : candidatePath;

  if (!options.allowCheckoutLocal) {
    const inputRefusal = checkoutRefusalReason({
      targetPath: qualifiedInput,
      searchDir: dirPath,
      checkoutRoots,
      label,
      platform,
    });
    if (inputRefusal) return { kind: 'refused', category: 'checkout', reason: inputRefusal };
  }

  const resolved = resolveExecutablePath(qualifiedInput, env, platform);
  if (!resolved) return { kind: 'missing' };

  if (!options.allowCheckoutLocal) {
    const resolvedRefusal = checkoutRefusalReason({
      targetPath: resolved,
      searchDir: dirPath,
      checkoutRoots,
      label,
      platform,
    });
    if (resolvedRefusal) return { kind: 'refused', category: 'checkout', reason: resolvedRefusal };
  }

  if (WINDOWS_SHIM_EXT_RE.test(resolved)) {
    const shimOutcome = resolveCommandShimTarget(resolved, ctx);
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
      target: {
        path: resolved,
        command: resolved,
        args: [],
        entryPath: resolved,
        packageRoot: null,
        launchError: reason,
      },
    };
  }

  return {
    kind: 'resolved',
    target: {
      path: resolved,
      command: resolved,
      args: [],
      entryPath: resolved,
      packageRoot: null,
      launchError: null,
    },
  };
}

function resolveWindowsPathCommandInternal(command, ctx) {
  const { options, checkoutRoots, platform, visited } = ctx;
  const env = options.env ?? process.env;
  for (const dir of windowsPathDirectories(env, platform)) {
    const outcome = resolveWindowsLaunchTargetInternal(join(dir, command), {
      options: { ...options, dirPath: dir, label: options.label ?? command },
      checkoutRoots,
      platform,
      visited,
    });
    if (outcome.kind === 'resolved') return outcome;
    if (outcome.kind === 'refused' && outcome.category === 'shim') return outcome;
  }
  return { kind: 'missing' };
}

function finalizeOutcome(outcome, options) {
  if (outcome.kind === 'resolved') return outcome.target;
  if (outcome.kind === 'refused' && options.failOnRefusal) {
    if (options.onRefusal) options.onRefusal(outcome.reason);
    throw new Error(outcome.reason);
  }
  return null;
}

/**
 * Single owning Windows launcher rule for executable lookup, read-only checkout
 * exclusion, shell-free `.CMD`/`.BAT` command-shim unwrapping, and package-bin
 * ownership verification.
 */
export function resolveWindowsLaunchTarget(candidatePath, options = {}) {
  const platform = options.platform ?? process.platform;
  const checkoutRoots = resolveCheckoutRoots(options, platform);
  const outcome = resolveWindowsLaunchTargetInternal(candidatePath, {
    options,
    checkoutRoots,
    platform,
    visited: new Set(),
  });
  return finalizeOutcome(outcome, options);
}

/** Resolve a bare command on PATH through `resolveWindowsLaunchTarget()`. */
export function resolveWindowsPathCommand(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const checkoutRoots = resolveCheckoutRoots(options, platform);
  const outcome = resolveWindowsPathCommandInternal(command, {
    options,
    checkoutRoots,
    platform,
    visited: new Set(),
  });
  return finalizeOutcome(outcome, options);
}
