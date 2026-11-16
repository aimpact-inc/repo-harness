import { dlopen, ptr, type Pointer } from 'bun:ffi';
import { readFileSync } from 'fs';
import { processExists } from '../process-group-termination';

let linuxBootId: string | undefined;
let ownStartTime: string | undefined;

function unreadable(pid: number, detail: string): Error {
  return new Error(`cannot read the process start time of pid ${pid}: ${detail}`);
}

function readLinuxBootId(): string {
  if (linuxBootId === undefined) {
    const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error('cannot read the Linux boot ID');
    linuxBootId = value;
  }
  return linuxBootId;
}

function linuxStartTime(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return null;
    throw error;
  }
  // The command name in field 2 may hold spaces and parentheses; fields after
  // its closing parenthesis start at field 3, so field 22 is index 19.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = fields[19];
  if (ticks === undefined || !/^\d+$/.test(ticks)) throw unreadable(pid, 'malformed /proc stat');
  return `linux:${readLinuxBootId()}:${ticks}`;
}

// CTL_KERN, KERN_PROC, KERN_PROC_PID; struct kinfo_proc is 648 bytes on arm64 and x86_64.
const DARWIN_KERN_PROC_PID = [1, 14, 1] as const;
const DARWIN_KINFO_PROC_SIZE = 648;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

type LibSystem = {
  symbols: { sysctl: (name: Pointer, length: number, old: Pointer, oldLength: Pointer, value: null, valueLength: bigint) => number };
};

let libSystem: LibSystem | undefined;

function loadLibSystem(pid: number): LibSystem {
  if (libSystem === undefined) {
    try {
      libSystem = dlopen('/usr/lib/libSystem.B.dylib', {
        sysctl: { args: ['ptr', 'u32', 'ptr', 'ptr', 'ptr', 'u64'], returns: 'i32' },
      }) as unknown as LibSystem;
    } catch (error) {
      throw unreadable(pid, `cannot load libSystem: ${(error as Error).message}`);
    }
  }
  return libSystem;
}

/** Two digits, as `%H`, `%M` and `%S` print them. */
const pad = (value: number) => String(value).padStart(2, '0');

/**
 * The kern.proc entry that `ps` reads, through sysctl instead of the setuid `/bin/ps`: Seatbelt refuses
 * to exec a setuid binary, so a sandboxed review seat cannot run `ps` (#2905). The value is the text of
 * `ps -o lstart=` with LC_ALL=C and TZ=UTC after whitespace runs become one space, so owner records
 * written by the `ps` reader stay valid.
 */
function darwinStartTime(pid: number): string | null {
  const { symbols } = loadLibSystem(pid);
  const name = new Int32Array([...DARWIN_KERN_PROC_PID, pid]);
  const entry = new Uint8Array(DARWIN_KINFO_PROC_SIZE);
  const length = new BigUint64Array([BigInt(DARWIN_KINFO_PROC_SIZE)]);
  if (symbols.sysctl(ptr(name), name.length, ptr(entry), ptr(length), null, 0n) !== 0) throw unreadable(pid, 'sysctl kern.proc.pid failed');
  if (length[0] === 0n) return null;
  if (length[0] !== BigInt(DARWIN_KINFO_PROC_SIZE)) throw unreadable(pid, `kern.proc.pid returned ${length[0]} bytes`);
  // kp_proc.p_starttime.tv_sec is the first field of struct kinfo_proc.
  const started = new Date(Number(new DataView(entry.buffer).getBigInt64(0, true)) * 1000);
  return `darwin:${WEEKDAYS[started.getUTCDay()]} ${MONTHS[started.getUTCMonth()]} ${started.getUTCDate()} `
    + `${pad(started.getUTCHours())}:${pad(started.getUTCMinutes())}:${pad(started.getUTCSeconds())} ${started.getUTCFullYear()}`;
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STILL_ACTIVE = 259;

type Kernel32 = {
  symbols: {
    OpenProcess: (access: number, inheritHandle: number, pid: number) => Pointer | null;
    GetExitCodeProcess: (process: Pointer, exitCode: Uint32Array) => number;
    GetProcessTimes: (process: Pointer, creation: BigUint64Array, exit: BigUint64Array, kernel: BigUint64Array, user: BigUint64Array) => number;
    CloseHandle: (handle: Pointer) => number;
  };
};

let kernel32: Kernel32 | undefined;

// Windows BOOL is a 4-byte int and HANDLE is pointer-sized. Each FILETIME out
// buffer is one 8-byte slot. A wrong signature ends the process with no exception.
function loadKernel32(pid: number): Kernel32 {
  if (kernel32 === undefined) {
    try {
      kernel32 = dlopen('kernel32.dll', {
        OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'ptr' },
        GetExitCodeProcess: { args: ['ptr', 'ptr'], returns: 'i32' },
        GetProcessTimes: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
        CloseHandle: { args: ['ptr'], returns: 'i32' },
      }) as unknown as Kernel32;
    } catch (error) {
      throw unreadable(pid, `cannot load kernel32.dll: ${(error as Error).message}`);
    }
  }
  return kernel32;
}

function windowsStartTime(pid: number): string | null {
  const { symbols } = loadKernel32(pid);
  // GetLastError is thread state that the runtime can change between two FFI
  // calls, so the absence of the PID comes from the process probe instead.
  const handle = symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle === null) {
    if (!processExists(pid)) return null;
    throw unreadable(pid, 'OpenProcess failed for a live process');
  }
  try {
    // An exited process stays openable while another handle holds its object.
    const exitCode = new Uint32Array(1);
    if (symbols.GetExitCodeProcess(handle, exitCode) === 0) throw unreadable(pid, 'GetExitCodeProcess failed');
    if (exitCode[0] !== STILL_ACTIVE) return null;
    const creation = new BigUint64Array(1);
    if (symbols.GetProcessTimes(handle, creation, new BigUint64Array(1), new BigUint64Array(1), new BigUint64Array(1)) === 0) {
      throw unreadable(pid, 'GetProcessTimes failed');
    }
    return `win32:${creation[0]}`;
  } finally {
    symbols.CloseHandle(handle);
  }
}

/**
 * Read the start time of the process that has this PID from the OS process
 * table. The value is opaque: two reads are equal only when they name the same
 * process instance.
 *
 * A PID names one process only while it runs. After the process exits, the OS
 * can give the number to a new process. The kernel records the start time when
 * it creates the process, and no process can change it, so a reused PID has a
 * different start time:
 * - linux: field 22 of /proc/<pid>/stat (clock ticks after boot), with the boot
 *   ID, because the tick count starts again at each boot.
 * - darwin: the kernel's p_starttime from sysctl kern.proc.pid, in the `ps -o lstart`
 *   text. The resolution is one second. Darwin gives PIDs in sequence, so a reuse in the same second needs
 *   the full PID range to wrap in that second.
 * - win32: the creation time from kernel32 GetProcessTimes, as a UTC FILETIME
 *   in 100 ns units. The value equals the earlier
 *   Process.StartTime.ToFileTimeUtc() value, so recorded owners stay valid.
 *
 * Returns null when no process has this PID. Throws when the table cannot be read.
 */
export function readProcessStartTime(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`invalid process id: ${pid}`);
  if (process.platform === 'linux') return linuxStartTime(pid);
  if (process.platform === 'darwin') return darwinStartTime(pid);
  if (process.platform === 'win32') return windowsStartTime(pid);
  throw unreadable(pid, `unsupported platform ${process.platform}`);
}

/** The start time of this process; read from the OS once per process. */
export function currentProcessStartTime(): string {
  if (ownStartTime === undefined) {
    const value = readProcessStartTime(process.pid);
    if (value === null) throw unreadable(process.pid, 'the current process is not in the process table');
    ownStartTime = value;
  }
  return ownStartTime;
}
