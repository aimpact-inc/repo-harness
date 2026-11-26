import { describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpWorkspace, initGitRepo, commitAll, run } from '../helpers/repo-fixture';
import { entries, inspectWorktree, protectsCwd, worktreeOccupyingPids } from '../../src/effects/state/coordination-worktree-topology';
import { prepareWorktreeTrash, renameWorktreeToTrash, worktreeTrashNames } from '../../src/effects/state/worktree-trash';
import { worktreeId, recordWorktree, readWorktreeRecord, endWorktreeRecord } from '../../src/effects/git/worktree-record';
import { resolveGitCommonDirectory } from '../../src/effects/git/common-directory';
import { decodeWorktrees } from '../../src/core/public-projections/worktrees';
import { collectRepositoryWorktrees, registeredWorktreePaths, repositoryWorktreeRow } from '../../src/effects/operator/worktree-collector-worker';
import { startWorktreeCollector } from '../../src/effects/operator/worktree-collector';
import { collectOrphanWorktrees } from '../../src/effects/operator/worktree-orphans-worker';
import { repoHarnessRepoIdFor, type RepoHarnessRegisteredRepo } from '../../src/effects/repo-registry';
import * as processProbe from '../../src/effects/git/worktree-processes';
import { classifyWindowsOpenFailure, worktreeProcesses, type LinuxWorktreeProcessProbe, type WindowsDirectoryAncestry, type WindowsProcessInspection, type WindowsWorktreeProcessProbe } from '../../src/effects/git/worktree-processes';
import { decodeWorktreeCleanupRequest, decodeWorktreeCleanupResult, worktreeDigestRow } from '../../src/core/operator/worktree-cleanup';
import { decodeWorktreeCleanupChildOutput, runWorktreeCleanup, selectionDigest, type WorktreeProcessProbe } from '../../src/effects/operator/worktree-cleanup';
import { OperatorWriteRefusal } from '../../src/effects/operator/write-run';

// /proc/self/mountinfo lines as Linux prints them (proc_show_options writes the hidepid super option).
const sysfsMount = '21 26 0:20 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw';
const procMount = (superOptions: string) => `22 26 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc ${superOptions}`;
const mountInfo = (superOptions = 'rw') => `${sysfsMount}\n${procMount(superOptions)}\n`;

function fixture() {
  const parent = tmpWorkspace('operator-worktrees');
  const main = join(parent, 'repo'), root = join(parent, 'managed'), home = join(parent, 'home');
  mkdirSync(main); mkdirSync(root); mkdirSync(home);
  initGitRepo(main);
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n.env\n');
  commitAll(main, 'base');
  const tree = join(root, 'repo-wt-feature');
  const git = (cwd: string, ...args: string[]) => { const result = run('git', args, cwd); if (result.status) throw new Error(result.stderr); return result.stdout.trim(); };
  git(main, 'worktree', 'add', '-b', 'feature', tree);
  writeFileSync(join(tree, 'feature.txt'), 'feature'); commitAll(tree, 'feature');
  git(main, 'update-ref', 'refs/remotes/origin/main', git(tree, 'rev-parse', 'HEAD'));
  const env = { ...process.env, REPO_HARNESS_WORKTREE_ROOT: root, REPO_HARNESS_HOME: home };
  const repo: RepoHarnessRegisteredRepo = { id: repoHarnessRepoIdFor(main), path: main, accessMode: 'read_only', source: 'adopt', registeredAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
  const inspect = () => inspectWorktree(main, tree, main, { env, processes: [] });
  return { parent, main, root, home, tree, git, env, repo, inspect, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

describe('read-only worktree judgment and lifecycle', () => {
  test('a process probe does not occupy the checkout that its observer inventories', () => {
    const f = fixture();
    try {
      const module = join(import.meta.dir, '../../src/effects/git/worktree-processes.ts');
      const script = `const { worktreeProcesses } = await import(${JSON.stringify(module)}); const rows = worktreeProcesses(Date.now() + 5000, { uid: 1001, entries: () => [String(process.pid), '42'], owner: () => 1001, cwd: pid => pid === String(process.pid) ? process.cwd() : '/', mountInfo: () => ${JSON.stringify(mountInfo())} }); console.log(JSON.stringify(rows?.filter(row => row.pid !== process.pid && row.cwd === process.cwd())));`;
      const output = execFileSync(process.execPath, ['-e', script], { cwd: f.tree, encoding: 'utf8', timeout: 6000 });
      expect(JSON.parse(output)).toEqual([]);
    } finally { f.cleanup(); }
  });

  test.each(['EACCES', 'EPERM'])('a same-UID cwd read denied with %s makes the inventory unknown', code => {
    const probe: LinuxWorktreeProcessProbe = {
      uid: 1001, entries: () => ['41', '42'], owner: () => 1001,
      cwd: pid => { if (pid === '42') throw Object.assign(new Error('denied cwd'), { code }); return '/checkout'; },
      mountInfo: () => mountInfo(),
    };
    expect(worktreeProcesses(Date.now() + 5000, probe)).toBeNull();
  });

  test.skipIf(process.platform !== 'darwin')('the macOS process observer launches lsof outside the checkout', () => {
    const output = `p${process.pid}\0n/checkout\0\np42\0n/\0`;
    const command = spyOn(childProcess, 'execFileSync').mockReturnValue(output);
    try {
      expect(worktreeProcesses(Date.now() + 5000)).toEqual([{ pid: process.pid, cwd: '/checkout' }, { pid: 42, cwd: '/' }]);
      expect(command).toHaveBeenCalledWith('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fpn0'], expect.objectContaining({ cwd: '/' }));
    } finally { command.mockRestore(); }
  });

  test('the controlled Linux inventory keeps readable occupants and ignores vanished or other-UID processes', () => {
    const read: string[] = [];
    const probe: LinuxWorktreeProcessProbe = {
      uid: 1001, entries: () => ['41', '42', '43', '44', 'not-a-pid'], owner: pid => pid === '42' ? 1002 : 1001,
      cwd: pid => {
        read.push(pid);
        if (pid === '43' || pid === '44') throw Object.assign(new Error('vanished'), { code: pid === '43' ? 'ENOENT' : 'ESRCH' });
        return '/checkout';
      },
      mountInfo: () => mountInfo(),
    };
    expect(worktreeProcesses(Date.now() + 5000, probe)).toEqual([{ pid: 41, cwd: '/checkout' }]);
    expect(read).toEqual(['41', '43', '44']);
  });

  const procMountProbe = (text: () => string): LinuxWorktreeProcessProbe => ({
    uid: 1001, entries: () => ['41'], owner: () => 1001, cwd: () => '/checkout', mountInfo: text,
  });

  test.each(['hidepid=invisible', 'hidepid=2', 'hidepid=ptraceable', 'hidepid=4'])('a /proc mounted with %s makes the inventory unknown', option => {
    expect(worktreeProcesses(Date.now() + 5000, procMountProbe(() => mountInfo(`rw,${option},gid=1001`)))).toBeNull();
  });

  test.each(['rw', 'rw,hidepid=noaccess', 'rw,hidepid=1', 'rw,hidepid=off', 'rw,hidepid=0', 'rw,subset=pid'])('a /proc mounted with super options %s keeps the inventory', options => {
    expect(worktreeProcesses(Date.now() + 5000, procMountProbe(() => mountInfo(options)))).toEqual([{ pid: 41, cwd: '/checkout' }]);
  });

  test('more than one mount on /proc makes the inventory unknown, whatever the row order', () => {
    const hiddenOnTop = `${mountInfo()}${procMount('rw,hidepid=invisible').replace('22 26', '40 22')}\n`;
    expect(worktreeProcesses(Date.now() + 5000, procMountProbe(() => hiddenOnTop))).toBeNull();
    const tmpfsOnTop = `${mountInfo()}41 22 0:30 / /proc rw,relatime shared:20 - tmpfs tmpfs rw\n`;
    expect(worktreeProcesses(Date.now() + 5000, procMountProbe(() => tmpfsOnTop))).toBeNull();
    // An older hidden mount moved on top of a newer plain mount keeps its earlier row.
    const olderHiddenOnNewerParent = '22 40 0:21 / /proc rw - proc proc rw,hidepid=invisible\n40 26 0:30 / /proc rw - proc proc rw\n';
    expect(worktreeProcesses(Date.now() + 5000, procMountProbe(() => olderHiddenOnNewerParent))).toBeNull();
  });

  test.each([
    ['an unreadable mountinfo', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }],
    ['a mountinfo without a /proc mount', () => `${sysfsMount}\n`],
    ['a mountinfo line without the separator', () => `${sysfsMount}\n22 26 0:21 / /proc rw,nosuid shared:12 proc proc rw\n`],
    ['empty /proc super options', () => '22 26 0:21 / /proc rw - proc proc \n'],
    ['a field after the /proc super options', () => '22 26 0:21 / /proc rw - proc proc rw hidepid=2\n'],
    ['a /proc row truncated after the source', () => '22 26 0:21 / /proc rw - proc proc\n'],
    ['an empty /proc super option token', () => '22 26 0:21 / /proc rw - proc proc rw,,subset=pid\n'],
    ['a malformed unrelated row', () => `${sysfsMount} extra\n${procMount('rw')}\n`],
    ['a non-numeric mount ID', () => `${procMount('rw').replace('22 26', 'x 26')}\n`],
    ['an unknown hidepid value', () => mountInfo('rw,hidepid=5')],
    ['a bare hidepid option', () => mountInfo('rw,hidepid')],
  ])('%s makes the inventory unknown', (_name, text) => {
    expect(worktreeProcesses(Date.now() + 5000, procMountProbe(text as () => string))).toBeNull();
  });

  const winProbe = (overrides: Partial<WindowsWorktreeProcessProbe> = {}): WindowsWorktreeProcessProbe => ({
    ownPid: 100, ownCwd: 'C:\\Users\\win\\repo', pids: () => [100, 101],
    inspect: pid => pid === 100 ? { status: 'ok', cwd: 'C:\\Users\\win\\repo\\' } : { status: 'ok', cwd: 'C:\\Users\\win\\repo-wt-1\\' },
    isLocalDrive: drive => drive === 'C:\\',
    realpath: path => path,
    ...overrides,
  });

  test('windows process probe normalizes handle-canonicalized and local paths, skips denied/out-of-scope entries, and keeps volume GUID paths for target matching', () => {
    const resolved: string[] = [];
    const byPid: Record<number, WindowsProcessInspection> = {
      100: { status: 'ok', cwd: 'c:\\users\\win\\repo\\' },
      101: { status: 'ok', cwd: '\\\\?\\C:\\Users\\win\\junc-wt\\' },
      102: { status: 'ok', cwd: 'C:\\' },
      103: { status: 'ok', cwd: '\\\\?\\C:\\Users\\win\\repo-wt-subst\\', canonical: true },
      104: { status: 'ok', cwd: '\\\\?\\UNC\\server\\share\\sub\\', canonical: true },
      105: { status: 'ok', cwd: '\\\\?\\Volume{AAAA-1111}\\sub\\', canonical: true },
      106: { status: 'exited' },
      107: { status: 'other_user' },
      108: { status: 'inaccessible' },
      109: { status: 'protected' },
      110: { status: 'ui_access' },
    };
    const rows = worktreeProcesses(Date.now() + 5000, undefined, winProbe({
      pids: () => Object.keys(byPid).map(Number),
      inspect: pid => byPid[pid]!,
      realpath: path => {
        resolved.push(path);
        return path.toLowerCase().endsWith('junc-wt') ? 'C:\\Users\\win\\repo-wt-1' : path.replace(/^c:\\users\\win/i, 'C:\\Users\\win');
      },
    }));
    expect(rows).toEqual([
      { pid: 100, cwd: 'C:\\Users\\win\\repo' },
      { pid: 101, cwd: 'C:\\Users\\win\\repo-wt-1' },
      { pid: 102, cwd: 'C:\\' },
      { pid: 103, cwd: 'C:\\Users\\win\\repo-wt-subst' },
      { pid: 104, cwd: '\\\\server\\share\\sub' },
      { pid: 105, cwd: '\\\\?\\volume{aaaa-1111}\\sub' },
    ]);
    expect(resolved.some(path => path.includes('repo-wt-subst') || path.startsWith('\\\\server') || path.includes('Volume'))).toBe(false);
    expect(protectsCwd('C:\\Users\\win\\repo-wt-1', 'c:\\users\\win\\repo-wt-1\\sub\\', 'win32')).toBe(true);
    expect(protectsCwd('C:\\Users\\win\\repo-wt-1', '\\\\?\\C:/Users/win/repo-wt-1', 'win32')).toBe(true);
    expect(protectsCwd('C:\\Users\\win\\repo-wt-1', 'C:\\Users\\win\\repo-wt-10', 'win32')).toBe(false);
  });

  test('windows probe self-check accepts a valid mapped SMB drive and matches another process on it', () => {
    const mapShare = (path: string) => path.replace(/^Z:\\/iu, '\\\\?\\UNC\\server\\share\\');
    const resolver = { isLocalDrive: (drive: string) => drive === 'C:\\', realpath: mapShare };
    const checkout: WindowsDirectoryAncestry = { ids: ['checkout', 'share'], volumeRoot: false };
    const own: WindowsDirectoryAncestry = { ids: ['primary', 'share'], volumeRoot: false };
    const sub: WindowsDirectoryAncestry = { ids: ['sub', ...checkout.ids], volumeRoot: false };
    const rows = worktreeProcesses(Date.now() + 5000, undefined, winProbe({
      ownPid: 100,
      ownCwd: 'Z:\\repo',
      pids: () => [100, 101, 102],
      inspect: pid => pid === 100
        ? { status: 'ok', cwd: '\\\\?\\UNC\\server\\share\\repo', canonical: true, windowsDirectory: own }
        : pid === 101
          ? { status: 'ok', cwd: '\\\\?\\UNC\\server\\share\\repo-wt-1\\sub', canonical: true, windowsDirectory: sub }
          : { status: 'ok', cwd: 'Z:\\repo-wt-1\\', windowsDirectory: checkout },
      ...resolver,
    }));
    expect(rows).toEqual([
      { pid: 100, cwd: '\\\\server\\share\\repo', windowsDirectory: own },
      { pid: 101, cwd: '\\\\server\\share\\repo-wt-1\\sub', windowsDirectory: sub },
      { pid: 102, cwd: '\\\\server\\share\\repo-wt-1', windowsDirectory: checkout },
    ]);
    const options = { platform: 'win32' as const, readTargetAncestry: () => checkout };
    expect(worktreeOccupyingPids('Z:\\repo-wt-1', rows, options)).toEqual([101, 102]);
    expect(worktreeOccupyingPids('\\\\?\\UNC\\server\\share\\repo-wt-1', rows, options)).toEqual([101, 102]);
  });

  test('windows target matching uses complete local ancestry and fails closed on unreadable identities', () => {
    const checkout: WindowsDirectoryAncestry = { ids: ['checkout', 'volume-root'], volumeRoot: true };
    const options = { platform: 'win32' as const, readTargetAncestry: () => checkout };
    const target = 'C:\\Users\\RUNNER~1\\repo-wt-1';
    const own = { pid: 100, cwd: 'C:\\Users\\runneradmin\\repo',
      windowsDirectory: { ids: ['primary', 'volume-root'] as const, volumeRoot: true } };
    const volumeCwd = '\\\\?\\Volume{AAAA-1111}\\sub';
    expect(worktreeOccupyingPids(target, [own, { pid: 105, cwd: volumeCwd,
      windowsDirectory: { ids: ['sub', 'different-volume-root'], volumeRoot: true } }], options)).toEqual([]);
    expect(worktreeOccupyingPids(target, [own, { pid: 105, cwd: volumeCwd,
      windowsDirectory: { ids: ['sub', ...checkout.ids], volumeRoot: true } }], options)).toEqual([105]);
    expect(worktreeOccupyingPids(target, [own, { pid: 105, cwd: volumeCwd }], options)).toBeNull();
    expect(worktreeOccupyingPids('X:\\repo-wt-1', [own], { ...options, readTargetAncestry: () => null })).toBeNull();
  });

  test('windows occupancy counts a UNC loopback CWD under a local checkout', () => {
    const observed = [{ pid: 101, cwd: '\\\\127.0.0.1\\C$\\repo-wt-1\\src',
      windowsDirectory: { ids: ['src', 'checkout', 'volume-root'] as const, volumeRoot: false } }];
    const options = {
      platform: 'win32' as const,
      readTargetAncestry: () => ({ ids: ['checkout', 'volume-root'] as const, volumeRoot: true }),
    };
    expect(worktreeOccupyingPids('C:\\repo-wt-1', observed, options)).toEqual([101]);
  });

  test.each([
    ['a different backing volume', '00000000000000bb', []],
    ['the same backing volume', '00000000000000aa', null],
    ['an unverified backing volume', undefined, null],
  ])('windows occupancy with a share-limited CWD on %s', (_label, volumeSerial, expected) => {
    const observed = [{ pid: 101, cwd: '\\\\server\\share\\repo', windowsDirectory: {
      ids: ['remote-primary', 'remote-share'] as const, volumeRoot: false, volumeSerial,
    } }];
    const options = {
      platform: 'win32' as const,
      readTargetAncestry: () => ({ ids: ['checkout', 'volume-root'] as const, volumeRoot: true, volumeSerial: '00000000000000aa' }),
    };
    expect(worktreeOccupyingPids('C:\\repo-wt-1', observed, options)).toEqual(expected);
  });

  test('windows occupancy proves a share-limited checkout disjoint from a local CWD on a different volume', () => {
    const observed = [{ pid: 101, cwd: 'C:\\repo', windowsDirectory: {
      ids: ['primary', 'volume-root'] as const, volumeRoot: true, volumeSerial: '00000000000000aa',
    } }];
    const options = {
      platform: 'win32' as const,
      readTargetAncestry: () => ({ ids: ['checkout', 'share-root'] as const, volumeRoot: false, volumeSerial: '00000000000000bb' }),
    };
    expect(worktreeOccupyingPids('\\\\server\\share\\repo-wt-demo', observed, options)).toEqual([]);
  });

  test('windows occupancy is unknown for a UNC target and a volume-GUID CWD with no common identity', () => {
    const observed = [{ pid: 105, cwd: '\\\\?\\Volume{AAAA-1111}\\src',
      windowsDirectory: { ids: ['src', 'volume-root'] as const, volumeRoot: true } }];
    const options = {
      platform: 'win32' as const,
      readTargetAncestry: () => ({ ids: ['checkout', 'share-root'] as const, volumeRoot: false }),
    };
    expect(worktreeOccupyingPids('\\\\server\\share\\repo-wt-1', observed, options)).toBeNull();
  });

  test.each([
    ['proven same-user SID followed by denied read', { inspect: (pid: number) => pid === 100 ? { status: 'ok', cwd: 'C:\\Users\\win\\repo\\' } : { status: 'denied' } } as Partial<WindowsWorktreeProcessProbe>],
    ['non-access-denied or post-SID failed read', { inspect: (pid: number) => pid === 100 ? { status: 'ok', cwd: 'C:\\Users\\win\\repo\\' } : { status: 'failed' } } as Partial<WindowsWorktreeProcessProbe>],
    ['truncated or failed PID enumeration', { pids: () => null }],
    ['missing own process', { pids: () => [101] }],
    ['mismatched own CWD', { inspect: () => ({ status: 'ok', cwd: 'C:\\elsewhere\\' }) } as Partial<WindowsWorktreeProcessProbe>],
    ['relative CWD', { inspect: (pid: number) => pid === 100 ? { status: 'ok', cwd: 'C:\\Users\\win\\repo\\' } : { status: 'ok', cwd: 'relative\\path' } } as Partial<WindowsWorktreeProcessProbe>],
    ['removed SUBST or unrecognized drive', { inspect: (pid: number) => pid === 100 ? { status: 'ok', cwd: 'C:\\Users\\win\\repo\\' } : { status: 'ok', cwd: 'X:\\repo-wt-alias\\' } } as Partial<WindowsWorktreeProcessProbe>],
    ['unresolved mapped network drive', { inspect: (pid: number) => pid === 100 ? { status: 'ok', cwd: 'C:\\Users\\win\\repo\\' } : { status: 'ok', cwd: 'Z:\\mapped\\dir\\' } } as Partial<WindowsWorktreeProcessProbe>],
    ['unresolvable mapped own CWD', { ownCwd: 'Z:\\repo', inspect: () => ({ status: 'ok', cwd: '\\\\?\\UNC\\server\\share\\repo', canonical: true }), realpath: () => { throw new Error('ENOENT'); } } as Partial<WindowsWorktreeProcessProbe>],
    ['unresolvable local alias or junction', { realpath: (path: string) => { if (path.includes('repo-wt-1')) throw new Error('ENOENT'); return path; } }],
    ['unresolvable non-canonical UNC path', { inspect: (pid: number) => pid === 100 ? { status: 'ok', cwd: 'C:\\Users\\win\\repo\\' } : { status: 'ok', cwd: '\\\\server\\share\\dir\\' }, realpath: (path: string) => { if (path.startsWith('\\\\')) throw new Error('ENOENT'); return path; } } as Partial<WindowsWorktreeProcessProbe>],
    ['device namespace path without volume GUID', { inspect: (pid: number) => pid === 100 ? { status: 'ok', cwd: 'C:\\Users\\win\\repo\\' } : { status: 'ok', cwd: '\\\\.\\PhysicalDrive0', canonical: true } } as Partial<WindowsWorktreeProcessProbe>],
  ])('windows probe fails closed on %s', (_name, overrides) => {
    expect(worktreeProcesses(Date.now() + 5000, undefined, winProbe(overrides))).toBeNull();
  });

  test('windows open failure classification skips denied opens with no readable SID and fails closed on post-SID or non-access-denied errors', () => {
    const ACCESS_DENIED = 0xc0000022, NON_ACCESS_ERROR = 0xc0000001, INVALID_CID = 0xc000000b;
    // (2) Denied limited or token open with no readable SID is skipped (`inaccessible` / `protected`).
    expect(classifyWindowsOpenFailure('limited', ACCESS_DENIED)).toEqual({ status: 'inaccessible' });
    expect(classifyWindowsOpenFailure('token', ACCESS_DENIED, { stillActive: true, protectedProcess: false })).toEqual({ status: 'inaccessible' });
    expect(classifyWindowsOpenFailure('token', ACCESS_DENIED, { stillActive: true, protectedProcess: true })).toEqual({ status: 'protected' });
    expect(classifyWindowsOpenFailure('token', ACCESS_DENIED, { stillActive: false })).toEqual({ status: 'exited' });
    expect(worktreeProcesses(Date.now() + 5000, undefined, winProbe({
      inspect: pid => pid === 100 ? { status: 'ok', cwd: 'C:\\Users\\win\\repo\\' } : classifyWindowsOpenFailure('limited', ACCESS_DENIED),
    }))).toEqual([{ pid: 100, cwd: 'C:\\Users\\win\\repo' }]);
    // (3) Proven same-user SID followed by denied/failed read fails closed unless proven PPL or non-elevated UIAccess.
    expect(classifyWindowsOpenFailure('same_user_vm', ACCESS_DENIED, { stillActive: true, protectedProcess: true })).toEqual({ status: 'protected' });
    expect(classifyWindowsOpenFailure('same_user_vm', ACCESS_DENIED, { stillActive: true, nonElevatedUiAccess: true })).toEqual({ status: 'ui_access' });
    expect(classifyWindowsOpenFailure('same_user_vm', ACCESS_DENIED, { stillActive: true })).toEqual({ status: 'denied' });
    expect(worktreeProcesses(Date.now() + 5000, undefined, winProbe({
      inspect: pid => pid === 100 ? { status: 'ok', cwd: 'C:\\Users\\win\\repo\\' } : classifyWindowsOpenFailure('same_user_vm', ACCESS_DENIED, { stillActive: true }),
    }))).toBeNull();
    // (4) Any failure that is not access denied (and not exited) gives unknown (`failed` -> `null`).
    for (const stage of ['limited', 'token', 'same_user_vm'] as const) {
      expect(classifyWindowsOpenFailure(stage, INVALID_CID)).toEqual({ status: 'exited' });
      const nonAccess = classifyWindowsOpenFailure(stage, NON_ACCESS_ERROR);
      expect(nonAccess).toEqual({ status: 'failed' });
      expect(worktreeProcesses(Date.now() + 5000, undefined, winProbe({
        inspect: pid => pid === 100 ? { status: 'ok', cwd: 'C:\\Users\\win\\repo\\' } : nonAccess,
      }))).toBeNull();
    }
    expect(classifyWindowsOpenFailure('token', ACCESS_DENIED, { stillActive: null })).toEqual({ status: 'failed' });
  });

  test('windows probe fails closed when its deadline is already reached', () => {
    expect(worktreeProcesses(Date.now() - 1, undefined, winProbe())).toBeNull();
  });

  test.if(process.platform === 'win32')('native Windows observer reports a live child in the worktree and clears once it exits', async () => {
    const f = fixture();
    const sub = join(f.tree, 'sub');
    mkdirSync(sub);
    const child = Bun.spawn([process.execPath, '-e', 'console.log("ready"); await Bun.sleep(30_000);'], {
      cwd: sub, stdout: 'pipe', stderr: 'ignore',
    });
    try {
      const reader = child.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      const occupied = worktreeProcesses(Date.now() + 5_000);
      expect(occupied).not.toBeNull();
      expect(occupied!.some(row => row.pid === child.pid && protectsCwd(f.tree, row.cwd))).toBe(true);
      child.kill();
      await child.exited;
      const idle = worktreeProcesses(Date.now() + 5_000);
      expect(idle).not.toBeNull();
      expect(idle!.some(row => protectsCwd(f.tree, row.cwd))).toBe(false);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
      f.cleanup();
    }
  });

  test('uses merge, ownership, loss and occupancy predicates without removing anything', () => {
    const f = fixture();
    try {
      expect(f.inspect()).toMatchObject({ judgment: 'green', reasons: [], merge: 'ancestor', unpushed_commits: 0, dirty_files: 0 });
      mkdirSync(join(f.tree, 'node_modules')); writeFileSync(join(f.tree, 'node_modules/output'), 'rebuild');
      // The uncollapsed names exceed execFileSync's default 1 MiB buffer.
      for (let index = 0; index < 5000; index++) writeFileSync(join(f.tree, 'node_modules', `${index}-${'x'.repeat(220)}`), '');
      expect(f.inspect()).toMatchObject({ judgment: 'green', ignored_entries: 1 });
      writeFileSync(join(f.tree, '.env'), 'private');
      expect(f.inspect()).toMatchObject({ judgment: 'yellow', reasons: ['ignored_data'] });
      writeFileSync(join(f.tree, 'feature.txt'), 'changed');
      expect(f.inspect().reasons).toContain('dirty');
      expect(inspectWorktree(f.main, f.tree, f.main, { env: f.env, processes: [{ pid: 99, cwd: join(f.tree, 'subdir') }] })).toMatchObject({ judgment: 'red', process_count: 1 });
      expect(inspectWorktree(f.main, f.tree, f.main, { env: f.env, processes: null }).reasons).toContain('process_unknown');
      f.git(f.main, 'worktree', 'lock', f.tree);
      expect(f.inspect().reasons).toContain('locked');
      expect(f.git(f.main, 'worktree', 'list', '--porcelain')).toContain(f.tree);
    } finally { f.cleanup(); }
  });

  test('a clean checkout with a gitlink is kept without .gitmodules or module metadata', () => {
    const f = fixture();
    try {
      const head = f.git(f.tree, 'rev-parse', 'HEAD');
      f.git(f.tree, 'update-index', '--add', '--cacheinfo', `160000,${head},submodule`);
      f.git(f.tree, 'commit', '-m', 'add gitlink');
      mkdirSync(join(f.tree, 'submodule'));
      f.git(f.main, 'update-ref', 'refs/remotes/origin/main', f.git(f.tree, 'rev-parse', 'HEAD'));
      expect(f.inspect()).toMatchObject({ judgment: 'yellow', reasons: ['submodules'], dirty_files: 0, merge: 'ancestor' });
    } finally { f.cleanup(); }
  });

  test('fresh branches and unpushed commits are not green', () => {
    const f = fixture();
    try {
      f.git(f.tree, 'checkout', '-b', 'fresh');
      expect(f.inspect().reasons).toContain('no_own_commits');
      writeFileSync(join(f.tree, 'new.txt'), 'new'); commitAll(f.tree, 'unpublished');
      const result = f.inspect();
      expect(result.judgment).toBe('yellow');
      expect(result.unpushed_commits).toBe(1);
      expect(result.merge).toBe('unmerged');
      expect(result.reasons).toContain('merge_unproven');
    } finally { f.cleanup(); }
  });

  test('records creator and end state outside the checkout with a stable incarnation id', () => {
    const f = fixture();
    try {
      const common = resolveGitCommonDirectory(f.main);
      const before = worktreeId(common, f.tree);
      const record = recordWorktree(f.main, f.tree, { creator: 'portal', purpose: 'worktree page', task_id: '1011', pull_request: 123 });
      expect(record.id).toBe(before);
      expect(recordWorktree(f.main, f.tree, { creator: 'task', purpose: 'attachment' })).toEqual(record);
      endWorktreeRecord(common, record, 'closed');
      expect(readWorktreeRecord(common, f.tree)).toMatchObject({ id: before, creator: 'portal', end_state: 'closed', ended_at: expect.any(String) });
      renameSync(f.tree, f.tree + '-old'); mkdirSync(f.tree);
      expect(worktreeId(common, f.tree)).not.toBe(before);
      expect(readWorktreeRecord(common, f.tree)).toBeNull();
    } finally { f.cleanup(); }
  });

  test('judges a pushed squash merge before directory sizing spends the collection budget', () => {
    const f = fixture();
    const processes = spyOn(processProbe, 'worktreeProcesses').mockReturnValue([]);
    const du = join(f.parent, 'du');
    const path = process.env.PATH;
    const now = Date.now;
    const clock = spyOn(Date, 'now').mockImplementation(() => now() + (existsSync(`${du}.ran`) ? 20_000 : 0));
    try {
      writeFileSync(du, '#!/bin/sh\n: > "$0.ran"\nprintf "1\\t%s\\n" "$2"\n');
      chmodSync(du, 0o755);
      process.env.PATH = `${f.parent}:${path ?? ''}`;
      f.git(f.main, 'update-ref', 'refs/remotes/origin/feature', 'feature');
      f.git(f.main, 'merge', '--squash', 'feature'); commitAll(f.main, 'squash feature');
      f.git(f.main, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      const rows = collectRepositoryWorktrees(f.repo, {}, f.env).snapshot.repositories[0]!.worktrees;
      expect(rows.find(row => row.directory === 'repo-wt-feature')).toMatchObject({ judgment: 'green', merge: 'absorbed', reasons: [], size_bytes: 1024 });
      expect(rows.find(row => row.directory === 'repo')).toMatchObject({ size_bytes: null, size_observed_at: null });
    } finally {
      if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
      clock.mockRestore(); processes.mockRestore(); f.cleanup();
    }
  });

  test('projects basenames, discovers orphan directories, caches du and rejects private egress', () => {
    const f = fixture();
    try {
      recordWorktree(f.main, f.tree, { creator: 'contract', purpose: `plan at ${f.main}/plans/secret.md`, task_id: `${f.main}/task` });
      mkdirSync(join(f.root, 'repo-wt-orphan'));
      const first = collectRepositoryWorktrees(f.repo, {}, f.env);
      const again = collectRepositoryWorktrees(f.repo, first.sizes, f.env);
      const rows = again.snapshot.repositories[0]!.worktrees;
      expect(rows.find(row => row.directory === 'repo')!.reasons).not.toContain('session_cwd');
      expect(rows).toHaveLength(2);
      const orphans = collectOrphanWorktrees([f.repo], {}, f.env, [{ path: f.root, source: 'manual', depth: 1, prefix: 'repo-wt-' }]);
      expect(orphans.snapshot.unassigned[0]!.directory).toBe('repo-wt-orphan');
      expect(orphans.snapshot.unassigned[0]!.reasons).toContain('unregistered');
      expect(again.sizes).toEqual(first.sizes);
      expect(JSON.stringify(again.snapshot)).not.toContain(f.parent);
      expect(decodeWorktrees(again.snapshot)).toEqual(again.snapshot);
      const tainted = structuredClone(again.snapshot);
      tainted.repositories[0]!.worktrees[0]!.directory = f.tree;
      expect(() => decodeWorktrees(tainted)).toThrow('worktrees_invalid');
      const extra = structuredClone(again.snapshot) as any;
      extra.repositories[0].worktrees[0].path = f.tree;
      expect(() => decodeWorktrees(extra)).toThrow('worktrees_invalid');
    } finally { f.cleanup(); }
  });

  test('orphan discovery uses retained Git pointers and leaves unknown directories unassigned', () => {
    const f = fixture();
    try {
      const legacy = join(f.parent, 'legacy');
      const pointed = join(legacy, 'generation', 'retained'), unknown = join(legacy, 'other', 'unknown');
      mkdirSync(pointed, { recursive: true }); mkdirSync(unknown, { recursive: true });
      const common = resolveGitCommonDirectory(f.main);
      writeFileSync(join(pointed, '.git'), `gitdir: ${join(common, 'worktrees/removed')}\n`);
      const other = join(f.parent, 'another', 'repo'); mkdirSync(other, { recursive: true }); initGitRepo(other);
      writeFileSync(join(other, 'base'), 'base'); commitAll(other, 'base');
      const second = { ...f.repo, id: repoHarnessRepoIdFor(other), path: other };
      expect(collectRepositoryWorktrees(second, {}, f.env).snapshot.repositories[0]!.worktrees.map(row => row.directory)).toEqual(['repo']);
      const result = collectOrphanWorktrees([f.repo, second], {}, f.env, [{ path: legacy, source: 'codex' }]);
      expect(result.snapshot.repositories[0]!.worktrees[0]).toMatchObject({ directory: 'retained', judgment: 'yellow', repository_id: f.repo.id });
      expect(result.snapshot.unassigned[0]).toMatchObject({ directory: 'unknown', repository_id: null, judgment: 'yellow' });
      expect(result.snapshot.repositories).toHaveLength(1);
      expect(JSON.stringify(result.snapshot)).not.toContain(f.parent);
    } finally { f.cleanup(); }
  });

  test('collector GET reads are inert and failed probes are unavailable', async () => {
    const f = fixture();
    let calls = 0;
    try {
      writeFileSync(join(f.home, 'registered-repos.json'), JSON.stringify({ version: 1, authorizationRevision: 1, repos: [f.repo] }));
      const collector = startWorktreeCollector({ env: f.env, interval_ms: 60_000, run_process: async () => { calls++; return { ok: false, code: 'timeout' }; } });
      try {
        await collector.settled();
        for (let index = 0; index < 5; index++) expect(collector.read()).toMatchObject({ status: 'partial', repositories: [{ status: 'unavailable', worktrees: [] }] });
        expect(calls).toBe(2);
      } finally { await collector.close(); }
    } finally { f.cleanup(); }
  });
});

/** A registered fixture whose `repo-wt-feature` row is green, with the effect bound to it. */
function cleanupFixture() {
  const f = fixture();
  writeFileSync(join(f.home, 'registered-repos.json'), JSON.stringify({ version: 1, authorizationRevision: 1, repos: [f.repo] }));
  // The page row comes from the collector's row builder. The process inventory is
  // injected: a runner whose /proc probe is unknown never shows a green row.
  const row = (directory: string) => {
    const common = resolveGitCommonDirectory(f.main), managed = realpathSync(f.root);
    const found = registeredWorktreePaths(entries(f.main)).find(item => basename(item.path) === directory)!;
    return repositoryWorktreeRow({ repo: f.repo, common, managed_root: managed, id: worktreeId(common, found.path), path: found.path, entry: found.entry,
      size_bytes: null, size_observed_at: null, caller_cwd: null, env: f.env, deadline: Date.now() + 10_000, processes: [] });
  };
  const digest = (...directories: string[]) => selectionDigest(directories.map(directory => worktreeDigestRow(row(directory))));
  const clean = (ids: string[], expected: string, processes: WorktreeProcessProbe = () => []) =>
    runWorktreeCleanup(decodeWorktreeCleanupRequest({ ids, expected_digest: expected }), { env: f.env, caller_cwd: f.main, deadline_ms: 30_000, processes });
  const refusal = (action: () => unknown): string => {
    try { action(); } catch (error) { if (error instanceof OperatorWriteRefusal) return `${error.status} ${error.code}`; throw error; }
    return 'none';
  };
  const branchExists = (branch: string) => f.git(f.main, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`) !== '';
  return { ...f, row, digest, clean, refusal, branchExists };
}

describe('green worktree cleanup effect', () => {
  test('removes the selected green worktree and its local branch, and keeps the remote refs', () => {
    const f = cleanupFixture();
    try {
      f.git(f.main, 'update-ref', 'refs/remotes/origin/feature', f.git(f.tree, 'rev-parse', 'HEAD'));
      const row = f.row('repo-wt-feature');
      expect(row.judgment).toBe('green');
      const result = f.clean([row.id], f.digest('repo-wt-feature'));
      expect(result).toEqual({ protocol: 1, kind: 'operator_worktree_cleanup', items: [
        { id: row.id, repository_id: f.repo.id, directory: 'repo-wt-feature', outcome: 'removed', reason: null },
      ] });
      expect(existsSync(f.tree)).toBe(false);
      expect(f.branchExists('feature')).toBe(false);
      expect(f.git(f.main, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin')).toContain('refs/remotes/origin/feature');
      expect(f.git(f.main, 'worktree', 'list', '--porcelain')).not.toContain(f.tree);
      expect(JSON.stringify(result)).not.toContain(f.parent);
    } finally { f.cleanup(); }
  });

  test('a non-green, in-use, unknown or changed selection removes nothing', () => {
    const f = cleanupFixture();
    try {
      const other = join(f.root, 'repo-wt-other');
      f.git(f.main, 'worktree', 'add', '-b', 'other', other, 'feature');
      writeFileSync(join(other, 'other.txt'), 'other'); commitAll(other, 'other');
      f.git(f.main, 'update-ref', 'refs/remotes/origin/main', f.git(other, 'rev-parse', 'HEAD'));
      writeFileSync(join(other, '.env'), 'private');
      const green = f.row('repo-wt-feature'), yellow = f.row('repo-wt-other');
      expect([green.judgment, yellow.judgment, yellow.reasons]).toEqual(['green', 'yellow', ['ignored_data']]);
      const both = f.digest('repo-wt-feature', 'repo-wt-other');
      expect(f.refusal(() => f.clean([green.id, yellow.id], both))).toBe('422 not_approved');
      expect(f.refusal(() => f.clean([yellow.id], f.digest('repo-wt-other')))).toBe('422 not_approved');
      expect(f.refusal(() => f.clean([green.id], f.digest('repo-wt-feature'), () => [{ pid: 99, cwd: join(f.tree, 'src') }]))).toBe('422 in_use');
      // An unknown occupancy inventory is never green (#1128).
      expect(f.refusal(() => f.clean([green.id], f.digest('repo-wt-feature'), () => null))).toBe('422 not_approved');
      expect(f.refusal(() => f.clean([green.id], 'f'.repeat(64)))).toBe('409 digest_changed');
      expect(f.refusal(() => f.clean([`wt_${'0'.repeat(64)}`], f.digest('repo-wt-feature')))).toBe('409 digest_changed');
      expect(existsSync(f.tree) && existsSync(other) && f.branchExists('feature') && f.branchExists('other')).toBe(true);
      writeFileSync(join(f.home, 'registered-repos.json'), '{');
      expect(f.refusal(() => f.clean([green.id], f.digest('repo-wt-feature')))).toBe('503 inventory_unavailable');
      expect(existsSync(f.tree)).toBe(true);
    } finally { f.cleanup(); }
  });

  test('a row that becomes in use inside the topology barrier is skipped and kept', () => {
    const f = cleanupFixture();
    try {
      const row = f.row('repo-wt-feature');
      const lock = join(resolveGitCommonDirectory(f.main), 'repo-harness/coordination/locks/worktree-topology.lock');
      // The occupant appears only while the barrier holds the topology lock.
      const result = f.clean([row.id], f.digest('repo-wt-feature'), () => existsSync(lock) ? [{ pid: 99, cwd: f.tree }] : []);
      expect(result.items).toEqual([{ id: row.id, repository_id: f.repo.id, directory: 'repo-wt-feature', outcome: 'skipped', reason: 'process_in_use' }]);
      expect(existsSync(join(f.tree, 'feature.txt')) && f.branchExists('feature')).toBe(true);
      expect(readdirSync(f.root)).toEqual(['repo-wt-feature']);
    } finally { f.cleanup(); }
  });

  /** A second green tree whose removal published its trash approval and then stopped, as after a SIGKILL at `intent`. */
  function interruptedApproval(f: ReturnType<typeof cleanupFixture>) {
    const other = join(f.root, 'repo-wt-other');
    f.git(f.main, 'worktree', 'add', '-b', 'other', other, 'feature');
    writeFileSync(join(other, 'other.txt'), 'other'); commitAll(other, 'other');
    const head = f.git(other, 'rev-parse', 'HEAD');
    f.git(f.main, 'update-ref', 'refs/remotes/origin/main', head);
    expect(f.row('repo-wt-other').judgment).toBe('green');
    const common = resolveGitCommonDirectory(f.main);
    const receipt = prepareWorktreeTrash(common, realpathSync(f.root), {
      worktree: realpathSync(other), branch: 'other', head_sha: head, target_ref: 'refs/remotes/origin/main', target_oid: head, merge_commit_sha: head,
    }, f.git(other, 'rev-parse', '--absolute-git-dir'));
    return { other, receipt, common };
  }

  test.each(['ignored data', 'occupying process'])('an unused trash approval of an unselected tree that later gained %s does not remove it', change => {
    const f = cleanupFixture();
    try {
      const { other, receipt } = interruptedApproval(f);
      const occupant = { pid: 99, cwd: join(other, 'src') };
      if (change === 'ignored data') writeFileSync(join(other, '.env'), 'private');
      const probe: WorktreeProcessProbe = () => change === 'ignored data' ? [] : [occupant];
      const green = f.row('repo-wt-feature');
      const result = f.clean([green.id], f.digest('repo-wt-feature'), probe);
      expect(result.items).toEqual([{ id: green.id, repository_id: f.repo.id, directory: 'repo-wt-feature', outcome: 'removed', reason: null }]);
      expect(existsSync(f.tree)).toBe(false);
      expect(existsSync(join(other, 'other.txt')) && f.branchExists('other')).toBe(true);
      if (change === 'ignored data') expect(readFileSync(join(other, '.env'), 'utf8')).toBe('private');
      expect(f.git(f.main, 'worktree', 'list', '--porcelain')).toContain(realpathSync(other));
      expect(existsSync(receipt.directory)).toBe(false);
    } finally { f.cleanup(); }
  });

  test('a trash approval whose payload was already renamed still completes before the selected removal', () => {
    const f = cleanupFixture();
    try {
      const { other, receipt, common } = interruptedApproval(f);
      renameWorktreeToTrash(receipt);
      expect(existsSync(other)).toBe(false);
      const green = f.row('repo-wt-feature');
      const result = f.clean([green.id], f.digest('repo-wt-feature'));
      expect(result.items.map(item => item.outcome)).toEqual(['removed']);
      expect(existsSync(f.tree) || f.branchExists('feature') || f.branchExists('other')).toBe(false);
      expect(worktreeTrashNames(common, realpathSync(f.root))).toEqual([]);
    } finally { f.cleanup(); }
  });

  test('the request and child output decoders are closed', () => {
    const id = `wt_${'a'.repeat(64)}`, other = `wt_${'b'.repeat(64)}`, digest = 'c'.repeat(64);
    expect(decodeWorktreeCleanupRequest({ ids: [other, id], expected_digest: digest })).toEqual({ ids: [id, other], expected_digest: digest });
    for (const fields of [
      { ids: [id], expected_digest: digest, session_id: 'session' },
      { ids: [id], expected_digest: digest, approvals: [] },
      { ids: [], expected_digest: digest },
      { ids: [id, id], expected_digest: digest },
      { ids: Array.from({ length: 17 }, (_, index) => `wt_${index.toString(16).padStart(64, '0')}`), expected_digest: digest },
      { ids: ['/tmp/repo-wt-feature'], expected_digest: digest },
      { ids: [id], expected_digest: digest.toUpperCase() },
    ]) expect(() => decodeWorktreeCleanupRequest(fields)).toThrow('worktree_cleanup_request_invalid');
    const item = { id, repository_id: 'repo_0123456789abcdef', directory: 'repo-wt-feature', outcome: 'removed', reason: null };
    expect(decodeWorktreeCleanupChildOutput(JSON.stringify({ ok: true, result: { protocol: 1, kind: 'operator_worktree_cleanup', items: [item] } })).items).toEqual([item as never]);
    expect(() => decodeWorktreeCleanupChildOutput(JSON.stringify({ ok: false, refusal: 'in_use' }))).toThrow(OperatorWriteRefusal);
    for (const output of [{ ok: false, refusal: 'reconcile_required' }, { ok: true, result: { protocol: 1, kind: 'operator_worktree_cleanup', items: [{ ...item, directory: '/tmp/private' }] } }, { ok: true }]) {
      expect(() => decodeWorktreeCleanupChildOutput(JSON.stringify(output))).toThrow(Error);
      try { decodeWorktreeCleanupChildOutput(JSON.stringify(output)); } catch (error) { expect(error).not.toBeInstanceOf(OperatorWriteRefusal); }
    }
    expect(() => decodeWorktreeCleanupResult({ protocol: 1, kind: 'operator_worktree_cleanup', items: [{ ...item, outcome: 'skipped', reason: 'stale' }] })).toThrow('worktree_cleanup_result_invalid');
  });
});
