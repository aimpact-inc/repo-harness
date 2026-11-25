import { existsSync, lstatSync, realpathSync, type Stats } from 'fs';
import { win32 } from 'path';
import { dlopen, FFIType, ptr } from 'bun:ffi';

export interface ExecutableFileAccess {
  exists(path: string): boolean;
  lstat(path: string): Stats;
  realpath(path: string): string;
}

export const HOST_EXECUTABLE_FILE_ACCESS: ExecutableFileAccess = {
  exists: existsSync,
  lstat: lstatSync,
  realpath: realpathSync,
};

export function requireWindowsAbsolute(value: unknown, label: string): string {
  if (typeof value !== 'string' || !win32.isAbsolute(value)) {
    throw new Error(`Windows protected-helper ${label} must be an absolute Windows path`);
  }
  return win32.normalize(value);
}

export function requireWindowsRegularFile(path: string, label: string, access: ExecutableFileAccess): string {
  if (!access.exists(path)) throw new Error(`Windows protected-helper ${label} is missing: ${path}`);
  const source = access.lstat(path);
  if (source.isSymbolicLink() || !source.isFile()) {
    throw new Error(`Windows protected-helper ${label} must be a non-symlink regular file: ${path}`);
  }
  const actual = access.realpath(path);
  const target = access.lstat(actual);
  if (target.isSymbolicLink() || !target.isFile()) {
    throw new Error(`Windows protected-helper ${label} must resolve to a regular file: ${path}`);
  }
  return win32.normalize(actual);
}

export function sameWindowsPath(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

export function nativeWindowsSystemToolsDirectory(): string {
  if (process.platform !== 'win32') {
    throw new Error('native Windows system directory is unavailable on this platform');
  }
  const kernel32 = dlopen('kernel32.dll', {
    GetSystemDirectoryW: {
      args: [FFIType.ptr, FFIType.u32],
      returns: FFIType.u32,
    },
  });
  try {
    const buffer = new Uint16Array(32_768);
    const length = kernel32.symbols.GetSystemDirectoryW(ptr(buffer), buffer.length);
    if (!Number.isSafeInteger(length) || length < 1 || length >= buffer.length) {
      throw new Error('GetSystemDirectoryW did not return a usable native system directory');
    }
    return win32.normalize(Buffer.from(buffer.buffer, 0, length * 2).toString('utf16le'));
  } finally {
    kernel32.close();
  }
}

/** Optional gh is operator-owned. Only fixed host install paths are candidates. */
export function resolveTrustedGhExecutable(
  access: ExecutableFileAccess = HOST_EXECUTABLE_FILE_ACCESS,
  options: { platform?: NodeJS.Platform; nativeSystemToolsDirectory?: string } = {},
): string | undefined {
  if ((options.platform ?? process.platform) === 'win32') {
    // Use the existing OS-native source, never caller ProgramFiles/SystemRoot/PATH.
    // Only the standard installation on the native system volume is supported.
    const systemDirectory = requireWindowsAbsolute(
      options.nativeSystemToolsDirectory ?? nativeWindowsSystemToolsDirectory(), 'native system directory',
    );
    const volume = win32.parse(systemDirectory).root;
    if (!/^[a-z]:\\$/i.test(volume)) throw new Error('trusted gh requires a local native Windows system volume');
    const candidate = win32.join(volume, 'Program Files', 'GitHub CLI', 'gh.exe');
    if (!access.exists(candidate)) return undefined;
    const actual = requireWindowsRegularFile(candidate, 'gh.exe', access);
    if (!sameWindowsPath(actual, candidate)) throw new Error('trusted gh must stay at the fixed host install path');
    return actual;
  }
  for (const candidate of [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    '/usr/bin/gh',
    '/home/linuxbrew/.linuxbrew/bin/gh',
  ]) {
    if (!access.exists(candidate)) continue;
    const actual = access.realpath(candidate);
    const stat = access.lstat(actual);
    if (stat.isFile() && (stat.mode & 0o111) !== 0) return actual;
  }
  return undefined;
}
