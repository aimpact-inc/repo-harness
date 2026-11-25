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
  | { readonly status: 'ok'; readonly cwd: string; readonly canonical?: boolean }
  | { readonly status: 'exited' | 'other_user' | 'inaccessible' | 'protected' | 'ui_access' | 'denied' | 'failed' };
export interface WindowsPathResolver {
  isLocalDrive(driveRoot: string): boolean;
  realpath(path: string): string;
}
export interface WindowsWorktreeProcessProbe extends WindowsPathResolver {
  readonly ownPid: number;
  readonly ownCwd: string;
  pids(): readonly number[] | null;
  inspect(pid: number): WindowsProcessInspection;
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
const PROCESS_QUERY_INFORMATION_VM_READ_AND_DUP_HANDLE = 0x0450;
const TOKEN_QUERY = 0x0008;
const DUPLICATE_SAME_ACCESS = 0x2;
const FILE_READ_ATTRIBUTES = 0x80;
const FILE_SHARE_ALL = 0x7;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const FILE_TYPE_DISK = 0x1;
const FILE_NAME_NORMALIZED_VOLUME_DOS = 0x0;
const FILE_NAME_NORMALIZED_VOLUME_GUID = 0x1;
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
const DRIVE_REMOVABLE = 2;
const DRIVE_FIXED = 3;
const DRIVE_RAMDISK = 6;
const MAX_ENUM_PIDS = 1_048_576;
const MAX_TOKEN_BUFFER_BYTES = 65_536;
const MAX_CWD_CHARS = 32_768;
const CWD_READ_ATTEMPTS = 3;

interface WindowsProcessApi {
  readonly kernel32: {
    K32EnumProcesses(pids: Pointer, byteLength: number, needed: Pointer): number;
    GetCurrentProcess(): Pointer;
    GetExitCodeProcess(handle: Pointer, exitCode: Pointer): number;
    GetDriveTypeW(rootPath: Pointer): number;
    GetFileType(handle: Pointer): number;
    GetFinalPathNameByHandleW(handle: Pointer, filePath: Pointer, charCapacity: number, flags: number): number;
    CreateFileW(
      fileName: Pointer,
      desiredAccess: number,
      shareMode: number,
      securityAttributes: Pointer | null,
      creationDisposition: number,
      flagsAndAttributes: number,
      templateFile: Pointer | null,
    ): bigint;
  };
  readonly ntdll: {
    NtOpenProcess(handleOut: Pointer, access: number, objectAttributes: Pointer, clientId: Pointer): number;
    NtOpenProcessToken(processHandle: Pointer, access: number, tokenHandleOut: Pointer): number;
    NtQueryInformationToken(tokenHandle: Pointer, infoClass: number, buffer: Pointer | null, length: number, needed: Pointer): number;
    NtQueryInformationProcess(processHandle: Pointer, infoClass: number, buffer: Pointer, length: number, needed: Pointer): number;
    NtReadVirtualMemory(processHandle: Pointer, baseAddress: bigint, buffer: Pointer, size: bigint, bytesRead: Pointer): number;
    NtDuplicateObject(
      sourceProcess: Pointer,
      sourceHandle: bigint,
      targetProcess: Pointer,
      targetHandleOut: Pointer,
      desiredAccess: number,
      handleAttributes: number,
      options: number,
    ): number;
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
      GetFileType: { args: [FFIType.ptr], returns: FFIType.u32 },
      GetFinalPathNameByHandleW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
      CreateFileW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.u64,
      },
    });
    const ntdll = dlopen('ntdll.dll', {
      NtOpenProcess: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
      NtOpenProcessToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
      NtQueryInformationToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
      NtQueryInformationProcess: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
      NtReadVirtualMemory: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
      NtDuplicateObject: {
        args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32],
        returns: FFIType.u32,
      },
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

type CwdHandleLocation = { readonly status: 'ok'; readonly cwdHandle: bigint } | { readonly status: 'exited' } | { readonly status: 'retry' };

function readWow64CwdHandle(api: WindowsProcessApi, handle: Pointer, wowPeb: bigint): CwdHandleLocation {
  // 32-bit WOW64 processes maintain CurrentDirectory.Handle in PEB32 (+0x10 -> ProcessParameters32, +0x2C Handle32).
  const pp = readRemoteBytes(api, handle, wowPeb + 0x10n, 4);
  if (isExitedStatus(pp.status)) return { status: 'exited' };
  if (pp.status !== STATUS_SUCCESS || !pp.buffer) return { status: 'retry' };
  const ppAddr = BigInt(new DataView(pp.buffer.buffer).getUint32(0, true));
  if (ppAddr === 0n) return { status: 'retry' };
  const curDir = readRemoteBytes(api, handle, ppAddr + 0x2cn, 4);
  if (isExitedStatus(curDir.status)) return { status: 'exited' };
  if (curDir.status !== STATUS_SUCCESS || !curDir.buffer) return { status: 'retry' };
  const cwdHandle = BigInt(new DataView(curDir.buffer.buffer).getUint32(0, true));
  return cwdHandle === 0n ? { status: 'retry' } : { status: 'ok', cwdHandle };
}

function readNative64CwdHandle(api: WindowsProcessApi, handle: Pointer): CwdHandleLocation {
  // 64-bit native processes maintain CurrentDirectory.Handle in PEB (+0x20 -> ProcessParameters, +0x48 Handle).
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
  const curDir = readRemoteBytes(api, handle, ppAddr + 0x48n, 8);
  if (isExitedStatus(curDir.status)) return { status: 'exited' };
  if (curDir.status !== STATUS_SUCCESS || !curDir.buffer) return { status: 'retry' };
  const cwdHandle = new DataView(curDir.buffer.buffer).getBigUint64(0, true);
  return cwdHandle === 0n ? { status: 'retry' } : { status: 'ok', cwdHandle };
}

function queryFinalPathNameByFlag(api: WindowsProcessApi, handle: Pointer, flags: number): string | null {
  let capacity = 1024;
  for (let attempt = 0; attempt < 2; attempt++) {
    const buffer = new Uint16Array(capacity);
    const length = api.kernel32.GetFinalPathNameByHandleW(handle, ptr(buffer), buffer.length, flags);
    if (length === 0 || length >= MAX_CWD_CHARS) return null;
    if (length < buffer.length) {
      const text = Buffer.from(buffer.buffer, 0, length * 2).toString('utf16le');
      return text && !text.includes('\0') ? text : null;
    }
    capacity = length + 1;
  }
  return null;
}

function queryFinalPathName(api: WindowsProcessApi, dupHandle: Pointer): string | null {
  if (api.kernel32.GetFileType(dupHandle) !== FILE_TYPE_DISK) return null;
  return queryFinalPathNameByFlag(api, dupHandle, FILE_NAME_NORMALIZED_VOLUME_DOS)
    ?? queryFinalPathNameByFlag(api, dupHandle, FILE_NAME_NORMALIZED_VOLUME_GUID);
}

function readRemoteCwdOnce(
  api: WindowsProcessApi,
  handle: Pointer,
): { status: 'ok'; cwd: string; canonical: true } | { status: 'exited' } | { status: 'retry' } {
  const retLen = new Uint32Array(1);
  const wowPeb = new BigUint64Array(1);
  const wowStatus = api.ntdll.NtQueryInformationProcess(handle, PROCESS_WOW64_INFORMATION_CLASS, ptr(wowPeb), 8, ptr(retLen));
  if (isExitedStatus(wowStatus)) return { status: 'exited' };
  if (wowStatus !== STATUS_SUCCESS) return { status: 'retry' };

  const readHandle = () => wowPeb[0]! !== 0n ? readWow64CwdHandle(api, handle, wowPeb[0]!) : readNative64CwdHandle(api, handle);
  const first = readHandle();
  if (first.status !== 'ok') return first;

  const dupOut = new BigUint64Array(1);
  const dupStatus = api.ntdll.NtDuplicateObject(
    handle, first.cwdHandle, api.kernel32.GetCurrentProcess(), ptr(dupOut), 0, 0, DUPLICATE_SAME_ACCESS,
  );
  if (isExitedStatus(dupStatus)) return { status: 'exited' };
  if (dupStatus !== STATUS_SUCCESS || dupOut[0]! === 0n) return { status: 'retry' };
  const dupHandle = Number(dupOut[0]!) as Pointer;
  try {
    // Confirm CurrentDirectory.Handle stayed unchanged across duplication so dupHandle cannot refer to a recycled handle.
    const second = readHandle();
    if (second.status !== 'ok') return second;
    if (second.cwdHandle !== first.cwdHandle) return { status: 'retry' };
    const finalPath = queryFinalPathName(api, dupHandle);
    return finalPath ? { status: 'ok', cwd: finalPath, canonical: true } : { status: 'retry' };
  } finally {
    api.ntdll.NtClose(dupHandle);
  }
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

function isProtectedWindowsProcess(api: WindowsProcessApi, limitedHandle: Pointer): boolean {
  const protection = new Uint8Array(1);
  const retLen = new Uint32Array(1);
  return api.ntdll.NtQueryInformationProcess(limitedHandle, PROCESS_PROTECTION_INFORMATION_CLASS, ptr(protection), 1, ptr(retLen)) === STATUS_SUCCESS
    && (protection[0]! & 0x07) !== 0;
}

export function classifyWindowsOpenFailure(
  stage: 'limited' | 'token' | 'same_user_vm',
  status: number,
  options: { readonly stillActive?: boolean | null; readonly protectedProcess?: boolean; readonly nonElevatedUiAccess?: boolean } = {},
): Exclude<WindowsProcessInspection, { readonly status: 'ok' }> {
  if (isExitedStatus(status)) return { status: 'exited' };
  if (status !== STATUS_ACCESS_DENIED) return { status: 'failed' };
  if (stage === 'limited') return { status: 'inaccessible' };
  if (options.stillActive === false) return { status: 'exited' };
  if (options.stillActive === null) return { status: 'failed' };
  if (options.protectedProcess) return { status: 'protected' };
  if (stage === 'token') return { status: 'inaccessible' };
  return options.nonElevatedUiAccess ? { status: 'ui_access' } : { status: 'denied' };
}

function isNonElevatedUiAccess(api: WindowsProcessApi, token: Pointer, ownFlags: TokenSecurityFlags): boolean {
  const targetFlags = queryTokenSecurityFlags(api, token);
  return Boolean(targetFlags && targetFlags.uiAccess && !targetFlags.elevated
    && (targetFlags.integrityRid > ownFlags.integrityRid || !ownFlags.uiAccess));
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

  const vm = ntOpenProcess(api, pid, PROCESS_QUERY_INFORMATION_VM_READ_AND_DUP_HANDLE);
  if (vm.status !== STATUS_SUCCESS || !vm.handle) {
    if (vm.status !== STATUS_ACCESS_DENIED) return classifyWindowsOpenFailure('same_user_vm', vm.status);
    const stillActive = processStillActive(api, limitedHandle);
    const protectedProcess = stillActive === true && isProtectedWindowsProcess(api, limitedHandle);
    const nonElevatedUiAccess = stillActive === true && !protectedProcess && isNonElevatedUiAccess(api, token, ownFlags);
    return classifyWindowsOpenFailure('same_user_vm', vm.status, { stillActive, protectedProcess, nonElevatedUiAccess });
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
    // Windows privilege boundary: unprivileged callers receive STATUS_ACCESS_DENIED with no
    // readable SID for OS, service, and higher-privilege processes (matching macOS lsof EPERM).
    return classifyWindowsOpenFailure('limited', limited.status);
  }
  try {
    const active = processStillActive(api, limited.handle);
    if (active === false) return { status: 'exited' };
    if (active === null) return { status: 'failed' };

    const tokenOut = new BigUint64Array(1);
    const tokenStatus = api.ntdll.NtOpenProcessToken(limited.handle, TOKEN_QUERY, ptr(tokenOut));
    if (tokenStatus !== STATUS_SUCCESS || tokenOut[0]! === 0n) {
      if (tokenStatus !== STATUS_ACCESS_DENIED) return classifyWindowsOpenFailure('token', tokenStatus);
      const stillActive = processStillActive(api, limited.handle);
      const protectedProcess = stillActive === true && isProtectedWindowsProcess(api, limited.handle);
      return classifyWindowsOpenFailure('token', tokenStatus, { stillActive, protectedProcess });
    }
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

const SKIPPED_WINDOWS_PROCESS_STATUSES: ReadonlySet<WindowsProcessInspection['status']> = new Set([
  'exited', 'other_user', 'inaccessible', 'protected', 'ui_access',
]);

function createWindowsDriveLookup(api: WindowsProcessApi): (driveRoot: string) => boolean {
  const driveCache = new Map<string, boolean>();
  return (driveRoot: string): boolean => {
    const key = driveRoot.toUpperCase();
    const cached = driveCache.get(key);
    if (cached !== undefined) return cached;
    const wide = Buffer.from(`${key}\0`, 'utf16le');
    const type = api.kernel32.GetDriveTypeW(ptr(wide));
    const local = type === DRIVE_REMOVABLE || type === DRIVE_FIXED || type === DRIVE_RAMDISK;
    driveCache.set(key, local);
    return local;
  };
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
  return {
    ownPid: process.pid,
    ownCwd: process.cwd(),
    pids: () => enumerateWindowsPids(api),
    inspect: pid => inspectWindowsProcess(api, pid, ownSid, ownFlags, deadline),
    isLocalDrive: createWindowsDriveLookup(api),
    realpath: (path: string) => realpathSync.native(path),
  };
}

const WINDOWS_VOLUME_GUID_RE = /^\\\\\?\\(Volume\{[0-9a-f-]+\})(?:\\|$)/iu;

/** Lowercase `volume{...}` identifier when a Windows path addresses a volume GUID with no DOS letter. */
export function windowsVolumeGuid(path: string): string | null {
  const match = WINDOWS_VOLUME_GUID_RE.exec(path.replace(/\//gu, '\\'));
  return match ? match[1]!.toLowerCase() : null;
}

function cleanWindowsPath(raw: string): string | null {
  let cwd = raw.replace(/\//gu, '\\');
  if (/^\\\\\?\\[A-Za-z]:\\/u.test(cwd)) cwd = cwd.slice(4);
  else if (/^\\\\\?\\UNC\\/iu.test(cwd)) cwd = `\\\\${cwd.slice(8)}`;
  const volumeGuid = windowsVolumeGuid(cwd);
  if (volumeGuid) {
    let rest = cwd.slice(`\\\\?\\${volumeGuid}`.length) || '\\';
    while (rest.length > 1 && rest.endsWith('\\')) rest = rest.slice(0, -1);
    return `\\\\?\\${volumeGuid}${rest}`;
  }
  if (/^\\\\[?.]\\/u.test(cwd)) return null;
  while (cwd.length > 3 && cwd.endsWith('\\')) cwd = cwd.slice(0, -1);
  return /^([A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/u.test(cwd) ? cwd : null;
}

/**
 * Single canonical resolver for every Windows path in occupancy comparisons: process CWDs,
 * the observer's own CWD, and checkout targets. Resolves non-canonical paths via `realpath`
 * before checking drive type so valid mapped SMB drives (`Z:\repo` -> `\\server\share\repo`),
 * SUBST drives, junctions, 8.3 names, and `\\?\UNC\...` produce the same canonical form.
 */
export function canonicalizeWindowsPath(raw: string, resolver: WindowsPathResolver, canonical = false): string | null {
  const cleaned = cleanWindowsPath(raw);
  if (!cleaned) return null;
  if (canonical) return cleaned;
  let resolved: string;
  try {
    const target = /^[A-Za-z]:\\/u.test(cleaned) && cleaned.length >= 248 ? `\\\\?\\${cleaned}` : cleaned;
    resolved = resolver.realpath(target);
  } catch {
    return null;
  }
  const canonicalPath = cleanWindowsPath(resolved);
  if (!canonicalPath) return null;
  if (/^[A-Za-z]:\\/u.test(canonicalPath) && !resolver.isLocalDrive(`${canonicalPath[0]!.toUpperCase()}:\\`)) {
    return null;
  }
  return canonicalPath;
}

/** Resolve a Windows checkout target through the same canonical resolver as process CWDs. */
export function resolveWindowsWorktreePath(path: string, resolver?: WindowsPathResolver): string | null {
  const activeResolver = resolver ?? {
    isLocalDrive: createWindowsDriveLookup(loadWindowsProcessApi()),
    realpath: (target: string) => realpathSync.native(target),
  };
  return canonicalizeWindowsPath(path, activeResolver);
}

/** Resolve a Windows directory's lowercase `volume{...}` GUID from its open kernel handle. */
export function queryWindowsPathVolumeGuid(path: string): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const api = loadWindowsProcessApi();
    const cleaned = cleanWindowsPath(path);
    if (!cleaned) return null;
    const direct = windowsVolumeGuid(cleaned);
    if (direct) return direct;
    const target = /^[A-Za-z]:\\/u.test(cleaned) && cleaned.length >= 248 ? `\\\\?\\${cleaned}` : cleaned;
    const wide = Buffer.from(`${target}\0`, 'utf16le');
    const handleRaw = api.kernel32.CreateFileW(
      ptr(wide), FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, null,
    );
    if (handleRaw === 0n || handleRaw === INVALID_HANDLE_VALUE) return null;
    const handle = Number(handleRaw) as Pointer;
    try {
      const guidPath = queryFinalPathNameByFlag(api, handle, FILE_NAME_NORMALIZED_VOLUME_GUID);
      return guidPath ? windowsVolumeGuid(guidPath) : null;
    } finally {
      api.ntdll.NtClose(handle);
    }
  } catch {
    return null;
  }
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
    if (SKIPPED_WINDOWS_PROCESS_STATUSES.has(outcome.status)) continue;
    if (outcome.status !== 'ok') return null;
    const cwd = canonicalizeWindowsPath(outcome.cwd, probe, outcome.canonical === true);
    if (cwd === null) return null;
    result.push({ pid, cwd });
    if (pid === probe.ownPid) sawOwnCwd = cwd;
  }
  const expectedOwn = sawOwnCwd ? canonicalizeWindowsPath(probe.ownCwd, probe) : null;
  return expectedOwn && sawOwnCwd!.toLowerCase() === expectedOwn.toLowerCase() ? result : null;
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
