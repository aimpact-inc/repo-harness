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
const PROCESS_QUERY_INFORMATION_VM_READ_AND_DUP_HANDLE = 0x0450;
const TOKEN_QUERY = 0x0008;
const DUPLICATE_SAME_ACCESS = 0x2;
const FILE_TYPE_DISK = 0x1;
const FILE_NAME_NORMALIZED_VOLUME_DOS = 0x0;
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
const PROCESS_SESSION_INFORMATION_CLASS = 24;
const PROCESS_WOW64_INFORMATION_CLASS = 26;
const PROCESS_PROTECTION_INFORMATION_CLASS = 61;
const SC_MANAGER_ENUMERATE_SERVICE = 0x0004;
const SC_ENUM_PROCESS_INFO = 0;
const SERVICE_WIN32 = 0x30;
const SERVICE_ACTIVE = 0x1;
const SERVICE_QUERY_CONFIG = 0x0001;
const DRIVE_REMOVABLE = 2;
const DRIVE_FIXED = 3;
const DRIVE_RAMDISK = 6;
const MAX_ENUM_PIDS = 1_048_576;
const MAX_TOKEN_BUFFER_BYTES = 65_536;
const MAX_CWD_CHARS = 32_768;
const MAX_SCM_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_SERVICE_CONFIG_BYTES = 65_536;
const CWD_READ_ATTEMPTS = 3;

interface WindowsProcessApi {
  readonly kernel32: {
    K32EnumProcesses(pids: Pointer, byteLength: number, needed: Pointer): number;
    GetCurrentProcess(): Pointer;
    GetExitCodeProcess(handle: Pointer, exitCode: Pointer): number;
    GetDriveTypeW(rootPath: Pointer): number;
    GetFileType(handle: Pointer): number;
    GetFinalPathNameByHandleW(handle: Pointer, filePath: Pointer, charCapacity: number, flags: number): number;
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

interface WindowsScmApi {
  OpenSCManagerW(machineName: Pointer | null, databaseName: Pointer | null, desiredAccess: number): Pointer | null;
  EnumServicesStatusExW(
    scManager: Pointer,
    infoLevel: number,
    serviceType: number,
    serviceState: number,
    services: Pointer | null,
    bufSize: number,
    bytesNeeded: Pointer,
    servicesReturned: Pointer,
    resumeHandle: Pointer,
    groupName: Pointer | null,
  ): number;
  OpenServiceW(scManager: Pointer, serviceName: Pointer, desiredAccess: number): Pointer | null;
  QueryServiceConfigW(service: Pointer, serviceConfig: Pointer, bufSize: number, bytesNeeded: Pointer): number;
  CloseServiceHandle(handle: Pointer): number;
}

let windowsProcessApi: WindowsProcessApi | undefined;
let windowsScmApi: WindowsScmApi | undefined;

function loadWindowsProcessApi(): WindowsProcessApi {
  if (windowsProcessApi === undefined) {
    const kernel32 = dlopen('kernel32.dll', {
      K32EnumProcesses: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      GetCurrentProcess: { args: [], returns: FFIType.ptr },
      GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      GetDriveTypeW: { args: [FFIType.ptr], returns: FFIType.u32 },
      GetFileType: { args: [FFIType.ptr], returns: FFIType.u32 },
      GetFinalPathNameByHandleW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
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

function loadWindowsScmApi(): WindowsScmApi {
  if (windowsScmApi === undefined) {
    const advapi32 = dlopen('advapi32.dll', {
      OpenSCManagerW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
      EnumServicesStatusExW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      OpenServiceW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
      QueryServiceConfigW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      CloseServiceHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    });
    // SAFETY: bun:ffi dlopen returns loosely typed symbol wrappers; each entry above matches the 64-bit Windows advapi32 ABI.
    windowsScmApi = advapi32.symbols as unknown as WindowsScmApi;
  }
  return windowsScmApi;
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

function queryFinalPathName(api: WindowsProcessApi, dupHandle: Pointer): string | null {
  if (api.kernel32.GetFileType(dupHandle) !== FILE_TYPE_DISK) return null;
  let capacity = 1024;
  for (let attempt = 0; attempt < 2; attempt++) {
    const buffer = new Uint16Array(capacity);
    const length = api.kernel32.GetFinalPathNameByHandleW(dupHandle, ptr(buffer), buffer.length, FILE_NAME_NORMALIZED_VOLUME_DOS);
    if (length === 0 || length > MAX_CWD_CHARS) return null;
    if (length < buffer.length) {
      const text = Buffer.from(buffer.buffer, 0, length * 2).toString('utf16le');
      return text && !text.includes('\0') ? text : null;
    }
    capacity = length;
  }
  return null;
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

function processSessionId(api: WindowsProcessApi, limitedHandle: Pointer): number | null {
  const session = new Uint32Array(1);
  const retLen = new Uint32Array(1);
  return api.ntdll.NtQueryInformationProcess(limitedHandle, PROCESS_SESSION_INFORMATION_CLASS, ptr(session), 4, ptr(retLen)) === STATUS_SUCCESS
    ? session[0]! : null;
}

function isSystemServiceSid(sid: Uint8Array): boolean {
  // SECURITY_NT_AUTHORITY (0,0,0,0,0,5): S-1-5-18 (LocalSystem), S-1-5-19 (LocalService),
  // S-1-5-20 (NetworkService), and S-1-5-80-* (NT SERVICE).
  if (sid.length < 12 || sid[0] !== 1 || sid[1]! < 1) return false;
  if (sid[2] !== 0 || sid[3] !== 0 || sid[4] !== 0 || sid[5] !== 0 || sid[6] !== 0 || sid[7] !== 5) return false;
  const sub0 = new DataView(sid.buffer, sid.byteOffset, sid.byteLength).getUint32(8, true);
  return (sid[1] === 1 && (sub0 === 18 || sub0 === 19 || sub0 === 20)) || sub0 === 80;
}

function isSystemServiceAccountName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower === '' || lower === 'localsystem' || lower === '.\\localsystem'
    || lower === 'nt authority\\system' || lower === 'nt authority\\localservice'
    || lower === 'nt authority\\networkservice' || lower.startsWith('nt service\\');
}

function readWideStringInBuffer(buffer: Uint8Array, baseAddress: bigint, stringAddress: bigint): string | null {
  if (stringAddress === 0n) return null;
  const offset = Number(stringAddress - baseAddress);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % 2 !== 0 || offset >= buffer.byteLength) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let end = offset;
  while (end + 1 < buffer.byteLength && view.getUint16(end, true) !== 0) end += 2;
  if (end + 1 >= buffer.byteLength || view.getUint16(end, true) !== 0) return null;
  return Buffer.from(buffer.buffer, buffer.byteOffset + offset, end - offset).toString('utf16le');
}

function enumerateActiveServiceNamesByPid(scmApi: WindowsScmApi, scm: Pointer): Map<number, string[]> | null {
  const needed = new Uint32Array(1);
  const returned = new Uint32Array(1);
  const resume = new Uint32Array(1);
  scmApi.EnumServicesStatusExW(scm, SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_ACTIVE, null, 0, ptr(needed), ptr(returned), ptr(resume), null);
  if (needed[0]! === 0 || needed[0]! + 4096 > MAX_SCM_BUFFER_BYTES) return null;
  const buffer = new Uint8Array(new ArrayBuffer(needed[0]! + 4096));
  const baseAddress = BigInt(ptr(buffer));
  resume[0] = 0;
  if (scmApi.EnumServicesStatusExW(
    scm, SC_ENUM_PROCESS_INFO, SERVICE_WIN32, SERVICE_ACTIVE, ptr(buffer), buffer.byteLength, ptr(needed), ptr(returned), ptr(resume), null,
  ) === 0 || resume[0]! !== 0) {
    return null;
  }
  const view = new DataView(buffer.buffer);
  const byPid = new Map<number, string[]>();
  // 64-bit ENUM_SERVICE_STATUS_PROCESSW is 56 bytes: lpServiceName (+0), dwProcessId (+44).
  for (let index = 0; index < returned[0]!; index++) {
    const offset = index * 56;
    if (offset + 56 > buffer.byteLength) return null;
    const pid = view.getUint32(offset + 44, true);
    if (pid === 0) continue;
    const name = readWideStringInBuffer(buffer, baseAddress, view.getBigUint64(offset, true));
    if (!name) return null;
    const names = byPid.get(pid);
    if (names) names.push(name); else byPid.set(pid, [name]);
  }
  return byPid;
}

function queryServiceStartName(scmApi: WindowsScmApi, scm: Pointer, serviceName: string): string | null {
  const wideName = Buffer.from(`${serviceName}\0`, 'utf16le');
  const service = scmApi.OpenServiceW(scm, ptr(wideName), SERVICE_QUERY_CONFIG);
  if (!service) return null;
  try {
    let capacity = 8192;
    for (let attempt = 0; attempt < 2; attempt++) {
      const buffer = new Uint8Array(new ArrayBuffer(capacity));
      const baseAddress = BigInt(ptr(buffer));
      const needed = new Uint32Array(1);
      if (scmApi.QueryServiceConfigW(service, ptr(buffer), buffer.byteLength, ptr(needed)) !== 0) {
        // 64-bit QUERY_SERVICE_CONFIGW has lpServiceStartName at +48; NULL means LocalSystem.
        const startNameAddr = new DataView(buffer.buffer).getBigUint64(48, true);
        return startNameAddr === 0n ? '' : readWideStringInBuffer(buffer, baseAddress, startNameAddr);
      }
      if (needed[0]! <= capacity || needed[0]! > MAX_SERVICE_CONFIG_BYTES) return null;
      capacity = needed[0]!;
    }
    return null;
  } finally {
    scmApi.CloseServiceHandle(service);
  }
}

export function classifyWindowsDeniedToken(evidence: {
  readonly stillActive: boolean | null;
  readonly protectedProcess: boolean;
  readonly ownIsSystemService: boolean;
  readonly sessionId: number | null;
  readonly systemServiceAccounts: readonly string[] | null;
}): Exclude<WindowsProcessInspection, { readonly status: 'ok' }> {
  if (evidence.stillActive === false) return { status: 'exited' };
  if (evidence.stillActive === null) return { status: 'failed' };
  if (evidence.protectedProcess) return { status: 'protected' };
  if (!evidence.ownIsSystemService && evidence.sessionId === 0
    && evidence.systemServiceAccounts && evidence.systemServiceAccounts.length > 0
    && evidence.systemServiceAccounts.every(isSystemServiceAccountName)) {
    return { status: 'other_user' };
  }
  return { status: 'denied' };
}

function classifyDeniedTokenProcess(
  api: WindowsProcessApi,
  pid: number,
  limitedHandle: Pointer,
  ownSid: Uint8Array,
  serviceAccountsForPid: (pid: number) => readonly string[] | null,
): WindowsProcessInspection {
  const stillActive = processStillActive(api, limitedHandle);
  if (stillActive !== true) return stillActive === false ? { status: 'exited' } : { status: 'failed' };
  const protectedProcess = isProtectedWindowsProcess(api, limitedHandle);
  if (protectedProcess) return { status: 'protected' };
  const ownIsSystemService = isSystemServiceSid(ownSid);
  const sessionId = ownIsSystemService ? null : processSessionId(api, limitedHandle);
  const systemServiceAccounts = sessionId === 0 ? serviceAccountsForPid(pid) : null;
  // Reconfirm the handle stayed alive after querying SCM so a recycled PID cannot match.
  const stillActiveAfter = systemServiceAccounts ? processStillActive(api, limitedHandle) : true;
  return classifyWindowsDeniedToken({ stillActive: stillActiveAfter, protectedProcess, ownIsSystemService, sessionId, systemServiceAccounts });
}

function classifyDeniedWindowsProcess(
  api: WindowsProcessApi,
  limitedHandle: Pointer,
  token: Pointer,
  ownFlags: TokenSecurityFlags,
): WindowsProcessInspection {
  const stillActive = processStillActive(api, limitedHandle);
  if (stillActive === false) return { status: 'exited' };
  if (stillActive === null) return { status: 'failed' };
  if (isProtectedWindowsProcess(api, limitedHandle)) return { status: 'protected' };
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

  const vm = ntOpenProcess(api, pid, PROCESS_QUERY_INFORMATION_VM_READ_AND_DUP_HANDLE);
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
  serviceAccountsForPid: (pid: number) => readonly string[] | null,
  deadline: number,
): WindowsProcessInspection {
  if (pid === 0) return { status: 'other_user' };
  const limited = ntOpenProcess(api, pid, PROCESS_QUERY_LIMITED_INFORMATION);
  if (limited.status !== STATUS_SUCCESS || !limited.handle) {
    if (isExitedStatus(limited.status)) return { status: 'exited' };
    // Unprivileged Windows callers receive STATUS_ACCESS_DENIED here for OS, service, and
    // higher-privilege processes (System, csrss, winlogon, dwm, svchost, elevated/other-user
    // shells) with no unprivileged API to read their SID — the same scope boundary as unprivileged
    // macOS lsof omitting EPERM processes.
    return limited.status === STATUS_ACCESS_DENIED ? { status: 'inaccessible' } : { status: 'failed' };
  }
  try {
    const active = processStillActive(api, limited.handle);
    if (active === false) return { status: 'exited' };
    if (active === null) return { status: 'failed' };

    const tokenOut = new BigUint64Array(1);
    const tokenStatus = api.ntdll.NtOpenProcessToken(limited.handle, TOKEN_QUERY, ptr(tokenOut));
    if (isExitedStatus(tokenStatus)) return { status: 'exited' };
    if (tokenStatus === STATUS_ACCESS_DENIED) {
      return classifyDeniedTokenProcess(api, pid, limited.handle, ownSid, serviceAccountsForPid);
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

function createWindowsServiceAccountLookup(): (pid: number) => readonly string[] | null {
  let serviceNamesByPid: Map<number, string[]> | null | undefined;
  const serviceAccountsCache = new Map<number, readonly string[] | null>();
  return (pid: number): readonly string[] | null => {
    if (serviceAccountsCache.has(pid)) return serviceAccountsCache.get(pid) ?? null;
    const scmApi = loadWindowsScmApi();
    const scm = scmApi.OpenSCManagerW(null, null, SC_MANAGER_ENUMERATE_SERVICE);
    if (!scm) {
      serviceAccountsCache.set(pid, null);
      return null;
    }
    try {
      if (serviceNamesByPid === undefined) serviceNamesByPid = enumerateActiveServiceNamesByPid(scmApi, scm);
      const names = serviceNamesByPid?.get(pid);
      if (!names || names.length === 0) {
        serviceAccountsCache.set(pid, null);
        return null;
      }
      const accounts: string[] = [];
      for (const name of names) {
        const startName = queryServiceStartName(scmApi, scm, name);
        if (startName === null) {
          serviceAccountsCache.set(pid, null);
          return null;
        }
        accounts.push(startName);
      }
      serviceAccountsCache.set(pid, accounts);
      return accounts;
    } finally {
      scmApi.CloseServiceHandle(scm);
    }
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
  const serviceAccountsForPid = createWindowsServiceAccountLookup();
  return {
    ownPid: process.pid,
    ownCwd: process.cwd(),
    pids: () => enumerateWindowsPids(api),
    inspect: pid => inspectWindowsProcess(api, pid, ownSid, ownFlags, serviceAccountsForPid, deadline),
    isLocalDrive: createWindowsDriveLookup(api),
    realpath: (path: string) => realpathSync.native(path),
  };
}

function cleanWindowsPath(raw: string): string | null {
  let cwd = raw.replace(/\//gu, '\\');
  if (/^\\\\\?\\[A-Za-z]:\\/u.test(cwd)) cwd = cwd.slice(4);
  else if (/^\\\\\?\\UNC\\/iu.test(cwd)) cwd = `\\\\${cwd.slice(8)}`;
  if (/^\\\\[?.]\\/u.test(cwd)) return null;
  while (cwd.length > 3 && cwd.endsWith('\\')) cwd = cwd.slice(0, -1);
  return /^([A-Za-z]:\\|\\\\[^\\]+\\[^\\]+)/u.test(cwd) ? cwd : null;
}

function normalizeWindowsCwd(
  raw: string,
  resolveRealpath: (path: string) => string,
  isLocalDrive: (driveRoot: string) => boolean,
  canonical = false,
): string | null {
  const cwd = cleanWindowsPath(raw);
  if (!cwd) return null;
  if (canonical) return cwd;
  if (/^[A-Za-z]:\\/u.test(cwd) && !isLocalDrive(`${cwd[0]!.toUpperCase()}:\\`)) return null;
  try {
    const target = /^[A-Za-z]:\\/u.test(cwd) && cwd.length >= 248 ? `\\\\?\\${cwd}` : cwd;
    return cleanWindowsPath(resolveRealpath(target));
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
    const cwd = normalizeWindowsCwd(outcome.cwd, probe.realpath, probe.isLocalDrive, outcome.canonical === true);
    if (cwd === null) return null;
    result.push({ pid, cwd });
    if (pid === probe.ownPid) sawOwnCwd = cwd;
  }
  const expectedOwn = sawOwnCwd ? normalizeWindowsCwd(probe.ownCwd, probe.realpath, probe.isLocalDrive) : null;
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
