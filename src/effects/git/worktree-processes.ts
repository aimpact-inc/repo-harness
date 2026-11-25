import { dlopen, FFIType, ptr, type Pointer } from 'bun:ffi';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';

export interface WorktreeProcess { pid: number; cwd: string }
export interface LinuxWorktreeProcessProbe {
  readonly uid: number;
  entries(): readonly string[];
  owner(pid: string): number;
  cwd(pid: string): string;
  /** The text of /proc/self/mountinfo. */
  mountInfo(): string;
}
export type WindowsProcessInspection =
  | { readonly status: 'ok'; readonly cwd: string }
  | { readonly status: 'exited' | 'other_user' | 'protected' | 'ui_access' | 'denied' | 'failed' };
export interface WindowsWorktreeProcessProbe {
  readonly ownPid: number;
  readonly ownCwd: string;
  pids(): readonly number[] | null;
  inspect(pid: number): WindowsProcessInspection;
  isLocalDrive(driveRoot: string): boolean;
  realpath(path: string): string;
}

/**
 * True only when the visible /proc mount lists every process. With
 * hidepid=invisible (2) or ptraceable (4), readdir skips a task this user cannot
 * ptrace, such as a non-dumpable same-UID process, so absence proves nothing.
 * Any malformed row, an unknown hidepid value, or more than one mount on /proc
 * (file order is not stack order) leaves the listing unproven.
 */
function procListsEveryProcess(mountInfo: string): boolean {
  const procRows: string[][] = [];
  for (const line of mountInfo.split('\n').filter(Boolean)) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-', 6);
    // Six fixed fields, optional fields, '-', then exactly fstype, source and super options.
    if (separator < 0 || fields.length !== separator + 4 || fields.some(field => !field)) return false;
    if (!/^\d+$/u.test(fields[0]!) || !/^\d+$/u.test(fields[1]!) || !/^\d+:\d+$/u.test(fields[2]!)) return false;
    if (fields[4] === '/proc') procRows.push(fields.slice(separator + 1));
  }
  if (procRows.length !== 1) return false;
  const [fstype, , superOptions] = procRows[0]!;
  if (fstype !== 'proc') return false;
  return superOptions!.split(',').every(option => option !== '' && (option.split('=')[0] !== 'hidepid' || /^hidepid=(?:off|noaccess|0|1)$/u.test(option)));
}
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_QUERY_INFORMATION_AND_VM_READ = 0x0410;
const TOKEN_QUERY = 0x0008;
const STILL_ACTIVE = 259;
const STATUS_SUCCESS = 0;
const STATUS_INVALID_CID = 0xc000000b;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_ACCESS_DENIED = 0xc0000022;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
const STATUS_PROCESS_IS_TERMINATING = 0xc000010a;
const TOKEN_USER_CLASS = 1;
const TOKEN_ELEVATION_CLASS = 20;
const TOKEN_INTEGRITY_LEVEL_CLASS = 25;
const TOKEN_UI_ACCESS_CLASS = 26;
const PROCESS_BASIC_INFORMATION_CLASS = 0;
const PROCESS_WOW64_INFORMATION_CLASS = 26;
const PROCESS_PROTECTION_INFORMATION_CLASS = 61;
const RTL_USER_PROC_PARAMS_NORMALIZED = 0x1;
const DRIVE_REMOVABLE = 2;
const DRIVE_FIXED = 3;
const DRIVE_RAMDISK = 6;
const MAX_ENUM_PIDS = 1_048_576;
const MAX_TOKEN_BUFFER_BYTES = 65_536;
const MAX_CWD_BYTES = 65_534;
const CWD_READ_ATTEMPTS = 3;

interface WindowsProcessApi {
  readonly kernel32: {
    K32EnumProcesses(pids: Pointer, byteLength: number, needed: Pointer): number;
    GetCurrentProcess(): Pointer;
    GetExitCodeProcess(handle: Pointer, exitCode: Pointer): number;
    GetDriveTypeW(rootPath: Pointer): number;
  };
  readonly ntdll: {
    NtOpenProcess(handleOut: Pointer, access: number, objectAttributes: Pointer, clientId: Pointer): number;
    NtOpenProcessToken(processHandle: Pointer, access: number, tokenHandleOut: Pointer): number;
    NtQueryInformationToken(tokenHandle: Pointer, infoClass: number, buffer: Pointer | null, length: number, needed: Pointer): number;
    NtQueryInformationProcess(processHandle: Pointer, infoClass: number, buffer: Pointer, length: number, needed: Pointer): number;
    NtReadVirtualMemory(processHandle: Pointer, baseAddress: bigint, buffer: Pointer, size: bigint, bytesRead: Pointer): number;
    NtClose(handle: Pointer): number;
  };
}

let windowsProcessApi: WindowsProcessApi | undefined;

function loadWindowsProcessApi(): WindowsProcessApi {
  if (windowsProcessApi === undefined) {
    const kernel32 = dlopen('kernel32.dll', {
      K32EnumProcesses: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      GetCurrentProcess: { args: [], returns: FFIType.ptr },
      GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      GetDriveTypeW: { args: [FFIType.ptr], returns: FFIType.u32 },
    });
    const ntdll = dlopen('ntdll.dll', {
      NtOpenProcess: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
      NtOpenProcessToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
      NtQueryInformationToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
      NtQueryInformationProcess: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
      NtReadVirtualMemory: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
      NtClose: { args: [FFIType.ptr], returns: FFIType.u32 },
    });
    // SAFETY: bun:ffi dlopen returns loosely typed symbol wrappers; each entry above matches the 64-bit Windows kernel32/ntdll ABI.
    windowsProcessApi = {
      kernel32: kernel32.symbols as unknown as WindowsProcessApi['kernel32'],
      ntdll: ntdll.symbols as unknown as WindowsProcessApi['ntdll'],
    };
  }
  return windowsProcessApi;
}

const isExitedStatus = (status: number): boolean =>
  status === STATUS_INVALID_CID || status === STATUS_INVALID_PARAMETER || status === STATUS_PROCESS_IS_TERMINATING;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function extractSidFromTokenBuffer(buffer: Uint8Array, baseAddress: bigint): Uint8Array | null {
  if (buffer.byteLength < 16) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const sidAddr = view.getBigUint64(0, true);
  const offset = Number(sidAddr - baseAddress);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 8 > buffer.byteLength) return null;
  const revision = buffer[offset]!;
  const subCount = buffer[offset + 1]!;
  const length = 8 + 4 * subCount;
  if (revision !== 1 || subCount > 15 || offset + length > buffer.byteLength) return null;
  return buffer.slice(offset, offset + length);
}

function queryTokenBuffer(api: WindowsProcessApi, tokenHandle: Pointer, infoClass: number): { status: number; buffer?: Uint8Array; baseAddress?: bigint } {
  const needed = new Uint32Array(1);
  const sizeStatus = api.ntdll.NtQueryInformationToken(tokenHandle, infoClass, null, 0, ptr(needed));
  if (sizeStatus !== STATUS_BUFFER_TOO_SMALL) return { status: sizeStatus };
  if (needed[0]! < 16 || needed[0]! > MAX_TOKEN_BUFFER_BYTES) return { status: -1 };
  // Back with an explicit ArrayBuffer so reading buffer.buffer cannot relocate the self-referential SID pointer.
  const buffer = new Uint8Array(new ArrayBuffer(needed[0]!));
  const bufferPtr = ptr(buffer);
  const readStatus = api.ntdll.NtQueryInformationToken(tokenHandle, infoClass, bufferPtr, buffer.byteLength, ptr(needed));
  return readStatus === STATUS_SUCCESS ? { status: STATUS_SUCCESS, buffer, baseAddress: BigInt(bufferPtr) } : { status: readStatus };
}

function queryTokenUserSid(api: WindowsProcessApi, tokenHandle: Pointer): { status: number; sid?: Uint8Array } {
  const queried = queryTokenBuffer(api, tokenHandle, TOKEN_USER_CLASS);
  if (queried.status !== STATUS_SUCCESS || !queried.buffer || queried.baseAddress === undefined) return { status: queried.status };
  const sid = extractSidFromTokenBuffer(queried.buffer, queried.baseAddress);
  return sid ? { status: STATUS_SUCCESS, sid } : { status: -1 };
}

function queryTokenSecurityFlags(api: WindowsProcessApi, tokenHandle: Pointer): {
  integrityRid: number; uiAccess: boolean; elevated: boolean;
} | null {
  const integrity = queryTokenBuffer(api, tokenHandle, TOKEN_INTEGRITY_LEVEL_CLASS);
  const sid = integrity.status === STATUS_SUCCESS && integrity.buffer && integrity.baseAddress !== undefined
    ? extractSidFromTokenBuffer(integrity.buffer, integrity.baseAddress) : null;
  // Mandatory label SIDs use SECURITY_MANDATORY_LABEL_AUTHORITY (0,0,0,0,0,16).
  if (!sid || sid[1]! < 1 || sid[2] !== 0 || sid[3] !== 0 || sid[4] !== 0 || sid[5] !== 0 || sid[6] !== 0 || sid[7] !== 16) {
    return null;
  }
  const integrityRid = new DataView(sid.buffer, sid.byteOffset, sid.byteLength).getUint32(8 + 4 * (sid[1]! - 1), true);
  const uiAccess = new Uint32Array(1);
  const elevated = new Uint32Array(1);
  const needed = new Uint32Array(1);
  if (api.ntdll.NtQueryInformationToken(tokenHandle, TOKEN_UI_ACCESS_CLASS, ptr(uiAccess), 4, ptr(needed)) !== STATUS_SUCCESS) return null;
  if (api.ntdll.NtQueryInformationToken(tokenHandle, TOKEN_ELEVATION_CLASS, ptr(elevated), 4, ptr(needed)) !== STATUS_SUCCESS) return null;
  return { integrityRid, uiAccess: uiAccess[0]! !== 0, elevated: elevated[0]! !== 0 };
}

function ntOpenProcess(api: WindowsProcessApi, pid: number, access: number): { status: number; handle?: Pointer } {
  // 64-bit OBJECT_ATTRIBUTES (48 bytes with Length=48) and CLIENT_ID (UniqueProcess, UniqueThread).
  const attributes = new Uint8Array(48);
  new DataView(attributes.buffer).setUint32(0, 48, true);
  const clientId = new BigUint64Array([BigInt(pid), 0n]);
  const handleOut = new BigUint64Array(1);
  const status = api.ntdll.NtOpenProcess(ptr(handleOut), access, ptr(attributes), ptr(clientId));
  return status === STATUS_SUCCESS && handleOut[0]! !== 0n
    ? { status: STATUS_SUCCESS, handle: Number(handleOut[0]!) as Pointer }
    : { status };
}

function processStillActive(api: WindowsProcessApi, handle: Pointer): boolean | null {
  const exitCode = new Uint32Array(1);
  if (api.kernel32.GetExitCodeProcess(handle, ptr(exitCode)) === 0) return null;
  return exitCode[0]! === STILL_ACTIVE;
}

function readRemoteBytes(api: WindowsProcessApi, handle: Pointer, address: bigint, size: number): { status: number; buffer?: Uint8Array } {
  if (address === 0n) return { status: -1 };
  const buffer = new Uint8Array(size);
  const read = new BigUint64Array(1);
  const status = api.ntdll.NtReadVirtualMemory(handle, address, ptr(buffer), BigInt(size), ptr(read));
  return status === STATUS_SUCCESS && Number(read[0]!) === size ? { status: STATUS_SUCCESS, buffer } : { status };
}

type DosPathLocation = { readonly status: 'ok'; readonly byteLength: number; readonly address: bigint } | { readonly status: 'exited' } | { readonly status: 'retry' };

function readWow64DosPath(api: WindowsProcessApi, handle: Pointer, wowPeb: bigint): DosPathLocation {
  // 32-bit WOW64 processes maintain CurrentDirectory in PEB32 (+0x10 -> ProcessParameters32, +0x08 Flags, +0x24 UNICODE_STRING32).
  const pp = readRemoteBytes(api, handle, wowPeb + 0x10n, 4);
  if (isExitedStatus(pp.status)) return { status: 'exited' };
  if (pp.status !== STATUS_SUCCESS || !pp.buffer) return { status: 'retry' };
  const ppAddr = BigInt(new DataView(pp.buffer.buffer).getUint32(0, true));
  if (ppAddr === 0n) return { status: 'retry' };
  const params = readRemoteBytes(api, handle, ppAddr + 0x08n, 36);
  if (isExitedStatus(params.status)) return { status: 'exited' };
  if (params.status !== STATUS_SUCCESS || !params.buffer) return { status: 'retry' };
  const view = new DataView(params.buffer.buffer);
  const rawBuffer = BigInt(view.getUint32(0x20, true));
  if (rawBuffer === 0n) return { status: 'retry' };
  const address = (view.getUint32(0, true) & RTL_USER_PROC_PARAMS_NORMALIZED) === 0 ? ppAddr + rawBuffer : rawBuffer;
  return { status: 'ok', byteLength: view.getUint16(0x1c, true), address };
}

function readNative64DosPath(api: WindowsProcessApi, handle: Pointer): DosPathLocation {
  // 64-bit native processes maintain CurrentDirectory in PEB (+0x20 -> ProcessParameters, +0x08 Flags, +0x38 UNICODE_STRING).
  const retLen = new Uint32Array(1);
  const basic = new BigUint64Array(6);
  const basicStatus = api.ntdll.NtQueryInformationProcess(handle, PROCESS_BASIC_INFORMATION_CLASS, ptr(basic), 48, ptr(retLen));
  if (isExitedStatus(basicStatus)) return { status: 'exited' };
  if (basicStatus !== STATUS_SUCCESS || basic[1]! === 0n) return { status: 'retry' };
  const pp = readRemoteBytes(api, handle, basic[1]! + 0x20n, 8);
  if (isExitedStatus(pp.status)) return { status: 'exited' };
  if (pp.status !== STATUS_SUCCESS || !pp.buffer) return { status: 'retry' };
  const ppAddr = new DataView(pp.buffer.buffer).getBigUint64(0, true);
  if (ppAddr === 0n) return { status: 'retry' };
  const params = readRemoteBytes(api, handle, ppAddr + 0x08n, 64);
  if (isExitedStatus(params.status)) return { status: 'exited' };
  if (params.status !== STATUS_SUCCESS || !params.buffer) return { status: 'retry' };
  const view = new DataView(params.buffer.buffer);
  const rawBuffer = view.getBigUint64(0x38, true);
  if (rawBuffer === 0n) return { status: 'retry' };
  const address = (view.getUint32(0, true) & RTL_USER_PROC_PARAMS_NORMALIZED) === 0 ? ppAddr + rawBuffer : rawBuffer;
  return { status: 'ok', byteLength: view.getUint16(0x30, true), address };
}

function readRemoteCwdOnce(api: WindowsProcessApi, handle: Pointer): { status: 'ok'; cwd: string } | { status: 'exited' } | { status: 'retry' } {
  const retLen = new Uint32Array(1);
  const wowPeb = new BigUint64Array(1);
  const wowStatus = api.ntdll.NtQueryInformationProcess(handle, PROCESS_WOW64_INFORMATION_CLASS, ptr(wowPeb), 8, ptr(retLen));
  if (isExitedStatus(wowStatus)) return { status: 'exited' };
  if (wowStatus !== STATUS_SUCCESS) return { status: 'retry' };

  const location = wowPeb[0]! !== 0n ? readWow64DosPath(api, handle, wowPeb[0]!) : readNative64DosPath(api, handle);
  if (location.status !== 'ok') return location;
  if (location.byteLength === 0 || location.byteLength > MAX_CWD_BYTES || location.byteLength % 2 !== 0) return { status: 'retry' };

  const text = readRemoteBytes(api, handle, location.address, location.byteLength);
  if (isExitedStatus(text.status)) return { status: 'exited' };
  if (text.status !== STATUS_SUCCESS || !text.buffer) return { status: 'retry' };
  const cwd = Buffer.from(text.buffer).toString('utf16le');
  return !cwd || cwd.includes('\0') ? { status: 'retry' } : { status: 'ok', cwd };
}

function readRemoteCwd(api: WindowsProcessApi, handle: Pointer, deadline: number): WindowsProcessInspection {
  for (let attempt = 0; attempt < CWD_READ_ATTEMPTS; attempt++) {
    if (Date.now() >= deadline) return { status: 'failed' };
    const read = readRemoteCwdOnce(api, handle);
    if (read.status !== 'retry') return read;
    const active = processStillActive(api, handle);
    if (active === false) return { status: 'exited' };
    if (active === null) return { status: 'failed' };
  }
  return { status: 'failed' };
}

function enumerateWindowsPids(api: WindowsProcessApi): number[] | null {
  for (let capacity = 4096; capacity <= MAX_ENUM_PIDS; capacity *= 2) {
    const buffer = new Uint32Array(capacity);
    const needed = new Uint32Array(1);
    if (api.kernel32.K32EnumProcesses(ptr(buffer), buffer.byteLength, ptr(needed)) === 0) return null;
    if (needed[0]! % 4 !== 0) return null;
    if (needed[0]! < buffer.byteLength) {
      const seen = new Set<number>();
      for (let index = 0; index < needed[0]! / 4; index++) {
        const pid = buffer[index]!;
        if (pid !== 0) seen.add(pid);
      }
      return [...seen];
    }
  }
  return null;
}

type TokenSecurityFlags = { readonly integrityRid: number; readonly uiAccess: boolean; readonly elevated: boolean };

function classifyDeniedWindowsProcess(
  api: WindowsProcessApi,
  limitedHandle: Pointer,
  token: Pointer,
  ownFlags: TokenSecurityFlags,
): WindowsProcessInspection {
  const stillActive = processStillActive(api, limitedHandle);
  if (stillActive === false) return { status: 'exited' };
  if (stillActive === null) return { status: 'failed' };
  const protection = new Uint8Array(1);
  const retLen = new Uint32Array(1);
  if (api.ntdll.NtQueryInformationProcess(limitedHandle, PROCESS_PROTECTION_INFORMATION_CLASS, ptr(protection), 1, ptr(retLen)) === STATUS_SUCCESS
    && (protection[0]! & 0x07) !== 0) {
    return { status: 'protected' };
  }
  const targetFlags = queryTokenSecurityFlags(api, token);
  if (targetFlags && targetFlags.uiAccess && !targetFlags.elevated
    && (targetFlags.integrityRid > ownFlags.integrityRid || !ownFlags.uiAccess)) {
    return { status: 'ui_access' };
  }
  return { status: 'denied' };
}

function inspectWindowsProcessWithToken(
  api: WindowsProcessApi,
  pid: number,
  limitedHandle: Pointer,
  token: Pointer,
  ownSid: Uint8Array,
  ownFlags: TokenSecurityFlags,
  deadline: number,
): WindowsProcessInspection {
  const user = queryTokenUserSid(api, token);
  if (isExitedStatus(user.status)) return { status: 'exited' };
  if (user.status !== STATUS_SUCCESS || !user.sid) return { status: 'failed' };
  if (!bytesEqual(user.sid, ownSid)) return { status: 'other_user' };

  const vm = ntOpenProcess(api, pid, PROCESS_QUERY_INFORMATION_AND_VM_READ);
  if (vm.status !== STATUS_SUCCESS || !vm.handle) {
    if (isExitedStatus(vm.status)) return { status: 'exited' };
    return vm.status === STATUS_ACCESS_DENIED
      ? classifyDeniedWindowsProcess(api, limitedHandle, token, ownFlags)
      : { status: 'failed' };
  }
  try {
    return readRemoteCwd(api, vm.handle, deadline);
  } finally {
    api.ntdll.NtClose(vm.handle);
  }
}

function inspectWindowsProcess(
  api: WindowsProcessApi,
  pid: number,
  ownSid: Uint8Array,
  ownFlags: TokenSecurityFlags,
  deadline: number,
): WindowsProcessInspection {
  if (pid === 0) return { status: 'other_user' };
  const limited = ntOpenProcess(api, pid, PROCESS_QUERY_LIMITED_INFORMATION);
  if (limited.status !== STATUS_SUCCESS || !limited.handle) {
    if (isExitedStatus(limited.status)) return { status: 'exited' };
    return limited.status === STATUS_ACCESS_DENIED ? { status: 'other_user' } : { status: 'failed' };
  }
  try {
    const active = processStillActive(api, limited.handle);
    if (active === false) return { status: 'exited' };
    if (active === null) return { status: 'failed' };

    const tokenOut = new BigUint64Array(1);
    const tokenStatus = api.ntdll.NtOpenProcessToken(limited.handle, TOKEN_QUERY, ptr(tokenOut));
    if (isExitedStatus(tokenStatus)) return { status: 'exited' };
    if (tokenStatus === STATUS_ACCESS_DENIED) {
      return processStillActive(api, limited.handle) === false ? { status: 'exited' } : { status: 'other_user' };
    }
    if (tokenStatus !== STATUS_SUCCESS || tokenOut[0]! === 0n) return { status: 'failed' };
    const token = Number(tokenOut[0]!) as Pointer;
    try {
      return inspectWindowsProcessWithToken(api, pid, limited.handle, token, ownSid, ownFlags, deadline);
    } finally {
      api.ntdll.NtClose(token);
    }
  } finally {
    api.ntdll.NtClose(limited.handle);
  }
}

function createNativeWindowsProbe(deadline: number): WindowsWorktreeProcessProbe | null {
  if (process.arch !== 'x64' && process.arch !== 'arm64') return null;
  const api = loadWindowsProcessApi();
  const selfTokenOut = new BigUint64Array(1);
  if (api.ntdll.NtOpenProcessToken(api.kernel32.GetCurrentProcess(), TOKEN_QUERY, ptr(selfTokenOut)) !== STATUS_SUCCESS || selfTokenOut[0]! === 0n) {
    return null;
  }
  const selfToken = Number(selfTokenOut[0]!) as Pointer;
  let ownSid: Uint8Array;
  let ownFlags: TokenSecurityFlags;
  try {
    const user = queryTokenUserSid(api, selfToken);
    const flags = queryTokenSecurityFlags(api, selfToken);
    if (user.status !== STATUS_SUCCESS || !user.sid || !flags) return null;
    ownSid = user.sid;
    ownFlags = flags;
  } finally {
    api.ntdll.NtClose(selfToken);
  }

  const driveCache = new Map<string, boolean>();
  const isLocalDrive = (driveRoot: string): boolean => {
    const key = driveRoot.toUpperCase();
    const cached = driveCache.get(key);
    if (cached !== undefined) return cached;
    const wide = Buffer.from(`${key}\0`, 'utf16le');
    const type = api.kernel32.GetDriveTypeW(ptr(wide));
    const local = type === DRIVE_REMOVABLE || type === DRIVE_FIXED || type === DRIVE_RAMDISK;
    driveCache.set(key, local);
    return local;
  };

  return {
    ownPid: process.pid,
    ownCwd: process.cwd(),
    pids: () => enumerateWindowsPids(api),
    inspect: pid => inspectWindowsProcess(api, pid, ownSid, ownFlags, deadline),
    isLocalDrive,
    realpath: (path: string) => realpathSync.native(path),
  };
}

function normalizeWindowsCwd(raw: string, resolveRealpath: (path: string) => string, isLocalDrive: (driveRoot: string) => boolean): string {
  let cwd = raw.replace(/\//gu, '\\');
  if (/^\\\\\?\\[A-Za-z]:\\/u.test(cwd)) cwd = cwd.slice(4);
  else if (/^\\\\\?\\UNC\\/iu.test(cwd)) cwd = `\\\\${cwd.slice(8)}`;
  while (cwd.length > 3 && cwd.endsWith('\\')) cwd = cwd.slice(0, -1);
  if (/^[A-Za-z]:\\/u.test(cwd) && isLocalDrive(`${cwd[0]!.toUpperCase()}:\\`)) {
    try {
      const target = cwd.length >= 248 ? `\\\\?\\${cwd}` : cwd;
      let real = resolveRealpath(target).replace(/\//gu, '\\');
      if (/^\\\\\?\\[A-Za-z]:\\/u.test(real)) real = real.slice(4);
      while (real.length > 3 && real.endsWith('\\')) real = real.slice(0, -1);
      return real;
    } catch { /* Directory may have vanished or be transiently inaccessible; keep the cleaned PEB path. */ }
  }
  return cwd;
}

function windowsWorktreeProcesses(deadline: number, probe: WindowsWorktreeProcessProbe): WorktreeProcess[] | null {
  if (Date.now() >= deadline) return null;
  const pids = probe.pids();
  if (pids === null) return null;
  const result: WorktreeProcess[] = [];
  let sawOwnCwd: string | null = null;
  for (const pid of pids) {
    if (Date.now() >= deadline) return null;
    const outcome = probe.inspect(pid);
    if (outcome.status === 'exited' || outcome.status === 'other_user' || outcome.status === 'protected' || outcome.status === 'ui_access') continue;
    if (outcome.status !== 'ok') return null;
    const cwd = normalizeWindowsCwd(outcome.cwd, probe.realpath, probe.isLocalDrive);
    if (!/^([A-Za-z]:\\|\\\\)/u.test(cwd)) return null;
    result.push({ pid, cwd });
    if (pid === probe.ownPid) sawOwnCwd = cwd;
  }
  if (sawOwnCwd === null) return null;
  const expectedOwn = normalizeWindowsCwd(probe.ownCwd, probe.realpath, probe.isLocalDrive);
  if (!expectedOwn || sawOwnCwd.toLowerCase() !== expectedOwn.toLowerCase()) return null;
  return result;
}

function linuxWorktreeProcesses(deadline: number, linuxProbe?: LinuxWorktreeProcessProbe): WorktreeProcess[] | null {
  const probe = linuxProbe ?? {
    uid: process.getuid!(),
    entries: () => readdirSync('/proc'),
    owner: (pid: string) => statSync(`/proc/${pid}`).uid,
    cwd: (pid: string) => readlinkSync(`/proc/${pid}/cwd`),
    mountInfo: () => readFileSync('/proc/self/mountinfo', 'utf8'),
  };
  if (!procListsEveryProcess(probe.mountInfo())) return null;
  const result: WorktreeProcess[] = [];
  for (const pid of probe.entries().filter(name => /^\d+$/u.test(name))) {
    if (Date.now() >= deadline) return null;
    try {
      // Like unprivileged lsof on macOS, inventory this operator's processes.
      if (probe.owner(pid) !== probe.uid) continue;
      result.push({ pid: Number(pid), cwd: probe.cwd(pid) });
    }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; }
  }
  return result;
}

function darwinWorktreeProcesses(deadline: number): WorktreeProcess[] | null {
  const output = execFileSync('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fpn0'], {
    cwd: '/', encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result: WorktreeProcess[] = [];
  let pid: number | null = null;
  for (const field of output.split('\0').map(part => part.replace(/^\n/u, ''))) {
    if (/^p\d+$/u.test(field)) pid = Number(field.slice(1));
    else if (field.startsWith('n') && pid !== null) result.push({ pid, cwd: field.slice(1) });
  }
  return result.length ? result : null;
}

/** Null means occupancy could not be proved. Never turn a failed process probe into an empty list. */
export function worktreeProcesses(
  deadline: number,
  linuxProbe?: LinuxWorktreeProcessProbe,
  windowsProbe?: WindowsWorktreeProcessProbe,
): WorktreeProcess[] | null {
  try {
    if (linuxProbe || (!windowsProbe && process.platform === 'linux')) return linuxWorktreeProcesses(deadline, linuxProbe);
    if (windowsProbe || process.platform === 'win32') {
      const probe = windowsProbe ?? createNativeWindowsProbe(deadline);
      return probe ? windowsWorktreeProcesses(deadline, probe) : null;
    }
    return process.platform === 'darwin' ? darwinWorktreeProcesses(deadline) : null;
  } catch { return null; }
}
