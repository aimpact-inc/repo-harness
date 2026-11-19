import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeSync,
} from "fs";
import { randomUUID } from "crypto";
import { errorMessage } from "../core/evidence/error-message";
import { shellQuote } from "../core/shell-quote";
import { sha256Prefixed } from "../core/evidence/sha256";
import { basename, dirname, join, relative, resolve, sep } from "path";
import type {
  AdoptionOperation,
  AdoptionOperationStatus,
  AdoptionPlan,
  AppendManagedBlockOperation,
  GitUntrackOperation,
  MkdirOperation,
  RemoveOperation,
  WriteFileOperation,
} from "../core/adoption/operations";
import { resolveInsideRepo, resolveParentInsideRepo } from "./path-safety";
import { upsertManagedBlock } from "../core/adoption/managed-block";
import { ignoreBlockProof } from "./adoption/gitignore-plan";
import { withExclusiveDirectoryLock } from "./locking/exclusive-directory-lock";
import { runGit } from './git/run-git';
import { ensureSelfIgnoringDirectory, SELF_IGNORE_NAME } from './self-ignoring-directory';
import { openRepositoryWriteRun, resolveHostConfigRepository, type HostConfigRepository, type RepositoryWriteRun } from './host-config/repository';
import { acquireRuntimeTransactionLock, globalRuntimeScope, type RuntimeTransactionLock } from './locking/runtime-transaction-lock';

export const FS_BACKUP_ROOT = ".ai/harness/backups";
export const FS_TRANSACTION_BACKUP_ROOT = `${FS_BACKUP_ROOT}/fs-transaction`;
const LOCK_SUFFIX = ".repo-harness.lock";
let transactionSequence = 0;

export interface GitIndexEntry {
  readonly mode: string;
  readonly objectId: string;
}

export interface ApplyOperationResult {
  readonly id: string;
  readonly kind: AdoptionOperation["kind"];
  readonly path?: string;
  readonly to?: string;
  readonly status: AdoptionOperationStatus;
  readonly backupPath?: string;
  readonly contentHash?: string;
  readonly gitIndexEntry?: GitIndexEntry;
  readonly error?: string;
  /** Why rh left the entry as it is, for an operation that it skipped on purpose. */
  readonly kept?: string;
}

/**
 * Where an adoption keeps its record (#2903). `ledger`: each file write goes
 * through the repository gate, and `rh config restore --repo` is its undo.
 * `commit`: an rh-owned refresh worktree, whose commit and pull request are the
 * record (D7); it writes directly and is removed after the run.
 */
export type AdoptionRecord = "ledger" | "commit";

export interface ApplyAdoptionOptions {
  readonly record: AdoptionRecord;
  readonly env: NodeJS.ProcessEnv;
  readonly dryRun?: boolean;
}

export interface ApplyAdoptionPlanResult {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly results: readonly ApplyOperationResult[];
  /** The rollback of a failed run: what went back and what stayed. */
  readonly rollback?: {
    readonly ok: boolean;
    readonly results: readonly RollbackOperationResult[];
  };
  /** The undo of the recorded writes, set when the repository ledger recorded one. */
  readonly restore?: string;
  /** The run's in-checkout directory, kept only when its rollback could not put every entry back. */
  readonly transactionDir?: string;
}

export interface RollbackOperationResult {
  readonly id: string;
  readonly kind: AdoptionOperation["kind"];
  readonly path?: string;
  readonly status: "rolled_back" | "skipped" | "failed";
  readonly action: "restore_backup" | "restore_git_index" | "delete_created_file" | "remove_empty_directory" | "none";
  readonly error?: string;
}

function failure(operation: AdoptionOperation, error: string): ApplyOperationResult {
  return {
    id: operation.id,
    kind: operation.kind,
    path: operation.path,
    status: "failed",
    error,
  };
}

export function isSupportedAdoptionOperation(operation: AdoptionOperation): boolean {
  return ["mkdir", "writeFile", "appendManagedBlock", "remove", "gitUntrack"].includes(operation.kind);
}

function unsupportedOperationReason(operation: AdoptionOperation): string {
  return `unsupported operation kind: ${operation.kind}`;
}

export function assertNoSymlinkInPath(repoRoot: string, path: string): string | null {
  const target = resolveInsideRepo(repoRoot, path);
  if (!target.ok || !target.path) return target.error ?? "invalid path";
  const root = resolve(repoRoot);
  const rel = relative(root, target.path);
  let current = root;
  for (const part of rel.split(sep)) {
    if (!part) continue;
    current = resolve(current, part);
    // lstat, not existsSync: existsSync follows links and misses a dangling one.
    // Return other lstat errors (for example EACCES) as a refusal, because callers
    // such as rollback expect a structured result and do not catch a throw.
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(current, { throwIfNoEntry: false });
    } catch (error) {
      return `cannot inspect adoption path: ${path} (${(error as NodeJS.ErrnoException).code ?? errorMessage(error)})`;
    }
    if (!stat) break;
    if (stat.isSymbolicLink()) return `symlink is not allowed in adoption path: ${path}`;
    if (!stat.isDirectory()) break;
  }
  return null;
}

function ensureParent(repoRoot: string, path: string): string | null {
  const symlinkError = assertNoSymlinkInPath(repoRoot, path);
  if (symlinkError) return symlinkError;
  const parent = resolveParentInsideRepo(repoRoot, path);
  if (!parent.ok || !parent.path) return parent.error ?? "failed to resolve parent directory";
  mkdirSync(parent.path, { recursive: true });
  return null;
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "EPERM", "ENOTSUP", "EISDIR"].includes(code ?? "")) throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function writeFileDurably(path: string, content: string | Buffer, mode?: number): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, mode);
    const data = typeof content === "string" ? Buffer.from(content) : content;
    let offset = 0;
    while (offset < data.length) {
      offset += writeSync(fd, data, offset, data.length - offset);
    }
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function sanitizeBackupStem(path: string): string {
  return path.replace(/[^a-zA-Z0-9._-]+/g, "__").replace(/^_+|_+$/g, "") || "file";
}

function contentHash(content: string | Buffer): string {
  return sha256Prefixed(content);
}

function checkExpectedFileState(repoRoot: string, operation: AdoptionOperation): string | null {
  if (!operation.path) return null;
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path) return target.error ?? "invalid operation path";
  const exists = existsSync(target.path);
  if (operation.expectedAbsent === true && exists) {
    return `target was created after planning: ${operation.path}`;
  }
  if (operation.expectedContentHash) {
    if (!exists || !lstatSync(target.path).isFile()) return `target changed after planning: ${operation.path}`;
    if (contentHash(readFileSync(target.path)) !== operation.expectedContentHash) {
      return `target content changed after planning: ${operation.path}`;
    }
  }
  return null;
}

/**
 * The in-checkout backup root and each directory below it that holds copies ignore themselves before the first copy
 * (#3228, #2854): a checkout gets the runtime-state exclude block only at `rh update`. `directory` is repo-relative.
 */
export function ensureCheckoutBackupDirectory(repoRoot: string, directory: string = FS_BACKUP_ROOT): void {
  for (const level of new Set([FS_BACKUP_ROOT, directory])) {
    const symlinkError = assertNoSymlinkInPath(repoRoot, `${level}/${SELF_IGNORE_NAME}`);
    if (symlinkError) throw new Error(symlinkError);
    const parentError = ensureParent(repoRoot, level);
    if (parentError) throw new Error(parentError);
    ensureSelfIgnoringDirectory(resolveInsideRepo(repoRoot, level).path!);
  }
}

function transactionDirFor(): string {
  transactionSequence += 1;
  return `${FS_TRANSACTION_BACKUP_ROOT}/${Date.now()}-${process.pid}-${transactionSequence}`;
}

export function withTargetLock<T>(targetPath: string, fn: () => T): T {
  // The shared primitive needs a canonical root; the lock stays beside its target,
  // and a lock left by a dead writer, or by one killed before it published its
  // owner record, is reclaimed instead of blocking the target.
  return withExclusiveDirectoryLock(
    realpathSync(dirname(targetPath)),
    `${basename(targetPath)}${LOCK_SUFFIX}`,
    fn,
    { reclaimStaleEmptyDirectory: true },
  );
}

/** What a file write decides from the target state it observes. */
type FileWriteDecision =
  | { readonly kind: "write"; readonly content: string | Buffer; readonly mode?: number }
  | { readonly kind: "skip" }
  | { readonly kind: "refuse"; readonly error: string };

// The decision runs again under the target lock, so a writer that waited for the
// lock never overwrites a change another writer made while it waited.
function writeFileUnderTargetLock(
  repoRoot: string,
  path: string,
  decide: (targetPath: string) => FileWriteDecision,
): { readonly content: string | Buffer } | null {
  const target = resolveInsideRepo(repoRoot, path);
  if (!target.ok || !target.path) throw new Error(target.error ?? "invalid path");
  const targetPath = target.path;
  const symlinkError = assertNoSymlinkInPath(repoRoot, path);
  if (symlinkError) throw new Error(symlinkError);
  const parentError = ensureParent(repoRoot, path);
  if (parentError) throw new Error(parentError);

  return withTargetLock(targetPath, () => {
    if (existsSync(targetPath) && !lstatSync(targetPath).isFile()) {
      throw new Error(`file target is not a regular file: ${path}`);
    }
    const decision = decide(targetPath);
    if (decision.kind === "refuse") throw new Error(decision.error);
    if (decision.kind === "skip") return null;
    const existingMode = existsSync(targetPath) ? lstatSync(targetPath).mode & 0o777 : undefined;
    const tempPath = resolve(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileDurably(tempPath, decision.content, decision.mode ?? existingMode);
      renameSync(tempPath, targetPath);
      fsyncDirectory(dirname(targetPath));
    } finally {
      rmSync(tempPath, { force: true });
    }

    return { content: decision.content };
  });
}

/** How one run puts its writes on disk: directly, or through the repository gate. */
interface RunWriter {
  /** Create the directory at the absolute `target` and its missing ancestors. */
  readonly mkdir: (target: string) => void;
  /** Write what `decide` returns at the repo-relative `path` under the target lock; null when the decision under the lock skips. */
  readonly write: (path: string, decide: (targetPath: string) => FileWriteDecision) => { readonly content: string | Buffer } | null;
}

/** One applying run; a dry run has none. `transactionDir` (repo-relative) keeps the files that a `remove` takes away. */
interface OperationRun {
  readonly writer: RunWriter;
  readonly transactionDir?: string;
}

function directWriter(repoRoot: string): RunWriter {
  return {
    mkdir: (target) => { mkdirSync(target, { recursive: true }); },
    write: (path, decide) => writeFileUnderTargetLock(repoRoot, path, decide),
  };
}

/**
 * The ledger writer (#2903): each file goes through the repository gate, which
 * keeps a replaced file in the repository vault and records each directory
 * that it creates. The gate needs paths in the real worktree root. The target
 * lock stays around each write, so another rh writer of the file waits.
 */
function recordedWriter(repoRoot: string, repository: HostConfigRepository, run: RepositoryWriteRun): RunWriter {
  // The plan's root can reach the worktree through a link (`/tmp` on macOS); the gate admits only real worktree paths.
  const inWorktree = (absolute: string) => join(repository.worktree, relative(resolve(repoRoot), absolute));
  return {
    mkdir: (target) => { run.gate.createDirectories([inWorktree(target)]); },
    write: (path, decide) => {
      const resolved = resolveInsideRepo(repoRoot, path);
      if (!resolved.ok || !resolved.path) throw new Error(resolved.error ?? "invalid path");
      const symlinkError = assertNoSymlinkInPath(repoRoot, path);
      if (symlinkError) throw new Error(symlinkError);
      const targetPath = inWorktree(resolved.path);
      // The target lock lives in the parent, so the gate creates and records the parent first.
      if (!existsSync(dirname(targetPath))) run.gate.createDirectories([dirname(targetPath)]);
      return withTargetLock(targetPath, () => {
        if (existsSync(targetPath) && !lstatSync(targetPath).isFile()) throw new Error(`file target is not a regular file: ${path}`);
        const decision = decide(targetPath);
        if (decision.kind === "refuse") throw new Error(decision.error);
        if (decision.kind === "skip") return null;
        const before = existsSync(targetPath) ? readFileSync(targetPath) : null;
        const mode = decision.mode ?? (before ? lstatSync(targetPath).mode & 0o777 : undefined);
        run.gate.writePaths([{
          path: targetPath, owner: "core",
          entry: { type: "file", bytes: Buffer.from(decision.content), ...(mode === undefined ? {} : { mode }) },
          ...(before ? { replace: true, expected: contentHash(before) } : {}),
        }]);
        return { content: decision.content };
      });
    },
  };
}

function applyMkdirOperation(repoRoot: string, operation: MkdirOperation, run: OperationRun | null): ApplyOperationResult {
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path) return failure(operation, target.error ?? "invalid path");
  const symlinkError = assertNoSymlinkInPath(repoRoot, operation.path);
  if (symlinkError) return failure(operation, symlinkError);
  if (!run) return { id: operation.id, kind: operation.kind, path: operation.path, status: "planned" };
  // Only report an applied (rollback-eligible) result when we actually create the
  // directory. A directory that already existed must never be removed during rollback.
  if (existsSync(target.path)) {
    return { id: operation.id, kind: operation.kind, path: operation.path, status: "skipped" };
  }
  run.writer.mkdir(target.path);
  return { id: operation.id, kind: operation.kind, path: operation.path, status: "applied" };
}

/** What a file operation writes, decided from the target as it is now. */
function fileDecision(repoRoot: string, operation: WriteFileOperation | AppendManagedBlockOperation): (targetPath: string) => FileWriteDecision {
  return (targetPath) => {
    const preconditionError = checkExpectedFileState(repoRoot, operation);
    if (preconditionError) return { kind: "refuse", error: preconditionError };
    if (operation.kind === "writeFile") {
      if (operation.ifMissing === true && existsSync(targetPath)) return { kind: "skip" };
      if (existsSync(targetPath) && readFileSync(targetPath).equals(Buffer.from(operation.content))) return { kind: "skip" };
      return { kind: "write", content: operation.content, mode: operation.mode };
    }
    const existing = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : "";
    const update = upsertManagedBlock(existing, operation, ignoreBlockProof(operation));
    if (!update.ok) return { kind: "refuse", error: update.error ?? "failed to update managed block" };
    if (!update.changed) return { kind: "skip" };
    return { kind: "write", content: update.content ?? "" };
  };
}

function applyFileWriteOperation(
  repoRoot: string,
  operation: WriteFileOperation | AppendManagedBlockOperation,
  run: OperationRun | null,
): ApplyOperationResult {
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path) return failure(operation, target.error ?? "invalid path");
  const symlinkError = assertNoSymlinkInPath(repoRoot, operation.path);
  if (symlinkError) return failure(operation, symlinkError);
  // The unlocked decision settles dry-run and skips the lock for unchanged targets;
  // a write decides again under the lock before it touches the target.
  const decide = fileDecision(repoRoot, operation);
  const decision = decide(target.path);
  if (decision.kind === "refuse") return failure(operation, decision.error);
  const skipped: ApplyOperationResult = { id: operation.id, kind: operation.kind, path: operation.path, status: "skipped" };
  if (decision.kind === "skip") return skipped;
  if (!run) return { id: operation.id, kind: operation.kind, path: operation.path, status: "planned" };
  try {
    const write = run.writer.write(operation.path, decide);
    if (!write) return skipped;
    return { id: operation.id, kind: operation.kind, path: operation.path, status: "applied", contentHash: contentHash(write.content) };
  } catch (error) {
    return failure(operation, errorMessage(error));
  }
}

function moveIntoTransactionBackup(repoRoot: string, path: string, transactionDir: string): string {
  const source = resolveInsideRepo(repoRoot, path);
  if (!source.ok || !source.path) throw new Error(source.error ?? "invalid source path");
  ensureCheckoutBackupDirectory(repoRoot, `${transactionDir}/removed`);
  const backupPath = `${transactionDir}/removed/${sanitizeBackupStem(path)}.${randomUUID()}`;
  const backup = resolveInsideRepo(repoRoot, backupPath);
  if (!backup.ok || !backup.path) throw new Error(backup.error ?? "invalid backup path");
  renameSync(source.path, backup.path);
  fsyncDirectory(dirname(source.path));
  fsyncDirectory(dirname(backup.path));
  return backupPath;
}

function applyRemoveOperation(repoRoot: string, operation: RemoveOperation, run: OperationRun | null): ApplyOperationResult {
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path) return failure(operation, target.error ?? "invalid remove path");
  const symlinkError = assertNoSymlinkInPath(repoRoot, operation.path);
  if (symlinkError) return failure(operation, symlinkError);
  const preconditionError = checkExpectedFileState(repoRoot, operation);
  if (preconditionError) return failure(operation, preconditionError);
  if (!existsSync(target.path)) return { id: operation.id, kind: operation.kind, path: operation.path, status: "skipped" };
  if (!lstatSync(target.path).isFile()) return failure(operation, `remove target is not a regular file: ${operation.path}`);
  if (!run) return { id: operation.id, kind: operation.kind, path: operation.path, status: "planned" };
  try {
    // A run with no transaction directory (`commit`) has no rollback: its worktree goes after the run.
    if (!run.transactionDir) {
      rmSync(target.path);
      fsyncDirectory(dirname(target.path));
      return { id: operation.id, kind: operation.kind, path: operation.path, status: "applied" };
    }
    const backupPath = moveIntoTransactionBackup(repoRoot, operation.path, run.transactionDir);
    return { id: operation.id, kind: operation.kind, path: operation.path, status: "applied", backupPath };
  } catch (error) {
    return failure(operation, errorMessage(error));
  }
}

type GitIndexRead =
  | { readonly kind: "git_failed"; readonly error: string }
  | { readonly kind: "absent" }
  | { readonly kind: "entry"; readonly entry: GitIndexEntry }
  | { readonly kind: "unsupported"; readonly error: string };

const GIT_INDEX_FILE_MODES = new Set(["100644", "100755"]);

// Reads the single stage-0 regular-file index entry for path. Rollback restores
// this exact entry, because the staged blob can differ from the working-tree bytes.
function readGitIndexEntry(repoRoot: string, path: string): GitIndexRead {
  const listed = runGit(["-C", repoRoot, "ls-files", "-z", "--stage", "--", path]);
  if (!listed.ok) return { kind: "git_failed", error: listed.stderr || listed.error || "git ls-files failed" };
  const records = listed.stdout.split("\0").filter(Boolean);
  if (records.length === 0) return { kind: "absent" };
  const match = records.length === 1 ? /^(\d{6}) ([0-9a-f]+) 0\t(.*)$/s.exec(records[0]) : null;
  if (!match || match[3] !== path) return { kind: "unsupported", error: `git index entry is unmerged or ambiguous: ${path}` };
  if (!GIT_INDEX_FILE_MODES.has(match[1])) {
    return { kind: "unsupported", error: `git index mode ${match[1]} is not a regular file entry: ${path}` };
  }
  // An intent-to-add entry lists the empty blob but stages no content. Porcelain v2
  // reports it with index mode 000000; restoring the blob would stage an empty file.
  const status = runGit(["--no-optional-locks", "-C", repoRoot, "status", "--porcelain=v2", "-z", "--untracked-files=no", "--", path]);
  if (!status.ok) return { kind: "git_failed", error: status.stderr || status.error || "git status failed" };
  if (status.stdout.split("\0").some((record) => record.startsWith("1 ") && record.split(" ")[4] === "000000")) {
    return { kind: "unsupported", error: `git index entry is intent-to-add: ${path}` };
  }
  return { kind: "entry", entry: { mode: match[1], objectId: match[2] } };
}

function applyGitUntrackOperation(repoRoot: string, operation: GitUntrackOperation, dryRun: boolean): ApplyOperationResult {
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path) return failure(operation, target.error ?? "invalid git untrack path");
  const symlinkError = assertNoSymlinkInPath(repoRoot, operation.path);
  if (symlinkError) return failure(operation, symlinkError);
  const preconditionError = checkExpectedFileState(repoRoot, operation);
  if (preconditionError) return failure(operation, preconditionError);
  // A target outside a Git work tree has no index entry to untrack.
  const indexed = readGitIndexEntry(repoRoot, operation.path);
  if (indexed.kind === "git_failed" || indexed.kind === "absent") {
    return { id: operation.id, kind: operation.kind, path: operation.path, status: "skipped" };
  }
  if (indexed.kind === "unsupported") return failure(operation, indexed.error);
  if (dryRun) return { id: operation.id, kind: operation.kind, path: operation.path, status: "planned" };
  const result = runGit(["-C", repoRoot, "rm", "--cached", "--force", "--quiet", "--", operation.path]);
  return result.ok
    ? { id: operation.id, kind: operation.kind, path: operation.path, status: "applied", gitIndexEntry: indexed.entry }
    : failure(operation, result.stderr || result.error || "git rm --cached failed");
}

function preflightOperation(repoRoot: string, operation: AdoptionOperation): string | null {
  if (!isSupportedAdoptionOperation(operation)) return unsupportedOperationReason(operation);
  if (!operation.path) return `operation kind ${operation.kind} is missing a path`;
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path) return target.error ?? "invalid operation path";
  const symlinkError = assertNoSymlinkInPath(repoRoot, operation.path);
  if (symlinkError) return symlinkError;
  const preconditionError = checkExpectedFileState(repoRoot, operation);
  if (preconditionError) return preconditionError;

  if (operation.kind === "remove" && existsSync(target.path) && !lstatSync(target.path).isFile()) {
    return `remove target is not a regular file: ${operation.path}`;
  }

  // Refuse an index entry that rollback cannot restore exactly before the paired
  // remove moves the file away.
  if (operation.kind === "gitUntrack") {
    const indexed = readGitIndexEntry(repoRoot, operation.path);
    return indexed.kind === "unsupported" ? indexed.error : null;
  }

  if (operation.kind === "mkdir") {
    if (existsSync(target.path) && !lstatSync(target.path).isDirectory()) return `mkdir target is not a directory: ${operation.path}`;
    return null;
  }

  if ((operation.kind === "writeFile" || operation.kind === "appendManagedBlock") && existsSync(target.path) && !lstatSync(target.path).isFile()) {
    return `file target is not a regular file: ${operation.path}`;
  }

  return null;
}

/** Where an adoption writes, or why it must not write at all. */
export type AdoptionTarget =
  | { readonly kind: "repository"; readonly repository: HostConfigRepository }
  | { readonly kind: "direct" }
  | { readonly kind: "refused"; readonly reason: string };

/** A planned operation that changes or removes something that is already there. */
function changesExistingEntry(operation: AdoptionOperation): boolean {
  if (operation.status !== "planned") return false;
  if (operation.kind === "writeFile" || operation.kind === "appendManagedBlock") return operation.expectedAbsent !== true;
  return operation.kind !== "mkdir";
}

/**
 * The one target rule of `rh init` for its dry run and its apply (#2903). A
 * worktree root (it holds `.git`) records each write in its repository ledger.
 * A directory below a worktree root has no ledger of its own, so it is
 * refused. A directory outside Git has no ledger either: it gets only new
 * files, since a change to an existing file would have no undo. A `commit`
 * run writes directly. The Git lookup ignores the caller's `GIT_*` variables,
 * as the repository identity does.
 */
export function adoptionTarget(plan: AdoptionPlan, record: AdoptionRecord, env: NodeJS.ProcessEnv): AdoptionTarget {
  if (record === "commit") return { kind: "direct" };
  const root = resolve(plan.repoRoot);
  if (lstatSync(join(root, ".git"), { throwIfNoEntry: false })) {
    try { return { kind: "repository", repository: resolveHostConfigRepository(root) }; }
    catch (error) { return { kind: "refused", reason: errorMessage(error) }; }
  }
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("GIT_")));
  const top = runGit(["-C", root, "rev-parse", "--show-toplevel"], { env: gitEnv, inheritEnv: false });
  if (top.ok && top.stdout.trim()) {
    const worktree = top.stdout.trim();
    return { kind: "refused", reason: `${root} is inside the Git worktree ${worktree}; rh init writes only at a worktree root. Run: rh init --repo ${worktree}, or run git init in ${root} to make it a repository` };
  }
  const changed = plan.operations.filter(changesExistingEntry).map((operation) => operation.path);
  if (changed.length) {
    return { kind: "refused", reason: `${root} is not a Git repository, so rh has no record to undo a change to an existing file there: ${changed.join(", ")}. Run git init in ${root}, then run rh init again` };
  }
  return { kind: "direct" };
}

function refusedResult(dryRun: boolean, results: readonly ApplyOperationResult[], id: string, error: string): ApplyAdoptionPlanResult {
  return { ok: false, dryRun, results: [...results, { id, kind: "runCheck", status: "failed", error }] };
}

export function applyAdoptionPlan(plan: AdoptionPlan, options: ApplyAdoptionOptions): ApplyAdoptionPlanResult {
  const dryRun = options.dryRun === true;
  const preflight = plan.operations.map((operation) => ({ operation, error: preflightOperation(plan.repoRoot, operation) }));
  const planned = preflight.map(({ operation, error }): ApplyOperationResult =>
    error ? failure(operation, error) : { id: operation.id, kind: operation.kind, path: operation.path, status: "planned" });
  if (preflight.some((entry) => entry.error)) return { ok: false, dryRun, results: planned };
  const target = adoptionTarget(plan, options.record, options.env);
  if (target.kind === "refused") return refusedResult(dryRun, planned, "adoption-target", target.reason);
  if (dryRun) {
    const kept = stagedUserRetirements(plan);
    const results = plan.operations.map((operation) => applyOperation(plan.repoRoot, operation, null, kept));
    return { ok: results.every((result) => result.status !== "failed"), dryRun, results };
  }
  if (target.kind === "direct") return applyDirect(plan, options.record);
  // The repository ledger has other writers (the hook strip, `rh config restore --repo`, `rh update`): they share the runtime lock.
  let lock: RuntimeTransactionLock;
  try { lock = acquireRuntimeTransactionLock(globalRuntimeScope(options.env)); }
  catch (error) { return refusedResult(dryRun, planned, "runtime-lock", `another rh run holds the runtime lock, so rh init writes nothing: ${errorMessage(error)}`); }
  try { return applyRecorded(plan, planned, target.repository, options.env); }
  finally { lock.release(); }
}

/** Apply in order and stop at the first failure; the operations after it stay planned. */
function applyInOrder(plan: AdoptionPlan, run: OperationRun): ApplyOperationResult[] {
  const kept = stagedUserRetirements(plan);
  const results: ApplyOperationResult[] = [];
  for (const operation of plan.operations) {
    const result = applyOperation(plan.repoRoot, operation, run, kept);
    results.push(result);
    if (result.status === "failed") break;
  }
  for (const operation of plan.operations.slice(results.length)) {
    results.push({ id: operation.id, kind: operation.kind, path: operation.path, status: "planned" });
  }
  return results;
}

/**
 * A `commit` run or a create-only run outside Git. A failed create-only run
 * takes back the files and directories that it created; a `commit` run has no
 * rollback, since its worktree goes after the run.
 */
function applyDirect(plan: AdoptionPlan, record: AdoptionRecord): ApplyAdoptionPlanResult {
  const results = applyInOrder(plan, { writer: directWriter(plan.repoRoot) });
  const ok = results.every((result) => result.status !== "failed");
  if (ok || record === "commit") return { ok, dryRun: false, results };
  const rollback = rollbackLocal(resolve(plan.repoRoot), results);
  return { ok, dryRun: false, results, rollback: { ok: rollback.every((result) => result.status !== "failed"), results: rollback } };
}

/**
 * A worktree root: every file write and created directory goes through the
 * repository gate in one run, under the global runtime lock (#2903). A
 * retired-file `remove` keeps the file in the run's guarded in-checkout
 * directory until the run ends, and a `gitUntrack` keeps the index entry in
 * memory. A failure rolls back the gate writes from the ledger before the run,
 * then the local operations. The run's directory goes at the end, except when
 * a rollback leaves an entry that it could not put back.
 */
function applyRecorded(plan: AdoptionPlan, planned: readonly ApplyOperationResult[], repository: HostConfigRepository, env: NodeJS.ProcessEnv): ApplyAdoptionPlanResult {
  const repoRoot = resolve(plan.repoRoot);
  const transactionDir = transactionDirFor();
  try { ensureCheckoutBackupDirectory(repoRoot, transactionDir); }
  catch (error) { return refusedResult(false, planned, "transaction-dir", `rh cannot keep its run directory ${transactionDir}: ${errorMessage(error)}`); }
  const transaction = join(repository.worktree, transactionDir);
  const run = openRepositoryWriteRun(env, repository, transaction);
  const results = applyInOrder(plan, { writer: recordedWriter(repoRoot, repository, run), transactionDir });
  const ok = results.every((result) => result.status !== "failed");
  const restore = `rh config restore --repo ${shellQuote(repository.worktree)}`;
  const recorded = results.some((result) => result.status === "applied" && ["mkdir", "writeFile", "appendManagedBlock"].includes(result.kind));
  if (ok) {
    rmSync(transaction, { recursive: true, force: true });
    return { ok, dryRun: false, results, ...(recorded ? { restore } : {}) };
  }
  const local = results.filter((result) => !["mkdir", "writeFile", "appendManagedBlock"].includes(result.kind));
  const rollback = [...rollbackGateWrites(repository, run, results), ...rollbackLocal(repoRoot, local)];
  const rollbackOk = rollback.every((result) => result.status !== "failed");
  if (rollbackOk) rmSync(transaction, { recursive: true, force: true });
  return { ok, dryRun: false, results, rollback: { ok: rollbackOk, results: rollback }, ...(rollbackOk ? {} : { transactionDir, restore }) };
}

/** The gate writes of the run go back from the ledger before it; an entry that changed since stays with its record. */
function rollbackGateWrites(repository: HostConfigRepository, run: RepositoryWriteRun, results: readonly ApplyOperationResult[]): RollbackOperationResult[] {
  const written = results.filter((result) => result.status === "applied" && ["mkdir", "writeFile", "appendManagedBlock"].includes(result.kind));
  let unresolved: readonly string[];
  try { unresolved = run.rollback().unresolved; }
  catch (error) {
    return written.map((result) => ({ id: result.id, kind: result.kind, path: result.path, status: "failed", action: "restore_backup", error: errorMessage(error) }));
  }
  return written.map((result): RollbackOperationResult => {
    const action = result.kind === "mkdir" ? "remove_empty_directory" : "restore_backup";
    return unresolved.includes(join(repository.worktree, result.path!))
      ? { id: result.id, kind: result.kind, path: result.path, status: "failed", action, error: "the entry changed after rh wrote it; it and its record stay" }
      : { id: result.id, kind: result.kind, path: result.path, status: "rolled_back", action };
  });
}

/**
 * The retirements that rh keeps whole (#2903 review P1). `gitUntrack` drops the
 * index entry, and neither the run nor the repository ledger keeps a copy of
 * it. The proof of a retired file covers its working-tree bytes only, so a
 * retirement goes ahead only while the index entry holds exactly those bytes;
 * a staged edit of the user keeps the file and the entry. The working tree
 * matches the proof here, else the remove refuses on its own.
 */
function stagedUserRetirements(plan: AdoptionPlan): ReadonlyMap<string, string> {
  const kept = new Map<string, string>();
  for (const untrack of plan.operations.filter((operation) => operation.kind === "gitUntrack")) {
    const indexed = readGitIndexEntry(plan.repoRoot, untrack.path!);
    if (indexed.kind !== "entry") continue;
    const remove = plan.operations.find((operation) => operation.kind === "remove" && operation.path === untrack.path);
    const proved = remove !== undefined && checkExpectedFileState(plan.repoRoot, remove) === null
      && runGit(["-C", plan.repoRoot, "hash-object", "--no-filters", "--", untrack.path!]).stdout.trim() === indexed.entry.objectId;
    if (!proved) kept.set(untrack.path!, "the Git index holds other bytes than the retired rh file (a staged edit), so rh keeps the file and its index entry");
  }
  return kept;
}

function applyOperation(repoRoot: string, operation: AdoptionOperation, run: OperationRun | null, kept: ReadonlyMap<string, string>): ApplyOperationResult {
  const reason = (operation.kind === "remove" || operation.kind === "gitUntrack") ? kept.get(operation.path) : undefined;
  if (reason !== undefined) return { id: operation.id, kind: operation.kind, path: operation.path, status: "skipped", kept: reason };
  // A thrown error is this operation's failure: it must stop the transaction and
  // trigger rollback, not escape with earlier operations applied and unrecorded.
  try {
    switch (operation.kind) {
      case "mkdir":
        return applyMkdirOperation(repoRoot, operation, run);
      case "writeFile":
      case "appendManagedBlock":
        return applyFileWriteOperation(repoRoot, operation, run);
      case "remove":
        return applyRemoveOperation(repoRoot, operation, run);
      case "gitUntrack":
        return applyGitUntrackOperation(repoRoot, operation, !run);
      default:
        return failure(operation, `unsupported operation kind: ${operation.kind}`);
    }
  } catch (error) {
    return failure(operation, errorMessage(error));
  }
}

function rollbackFailed(operation: ApplyOperationResult, action: RollbackOperationResult["action"], error: string): RollbackOperationResult {
  return { id: operation.id, kind: operation.kind, path: operation.path, status: "failed", action, error };
}

/** A file that a create-only run wrote goes only while it still holds the bytes that the run wrote. */
function rollbackCreatedFile(repoRoot: string, operation: ApplyOperationResult): RollbackOperationResult {
  if (!operation.path) return rollbackFailed(operation, "none", "file operation is missing path");
  const targetSymlinkError = assertNoSymlinkInPath(repoRoot, operation.path);
  if (targetSymlinkError) return rollbackFailed(operation, "none", targetSymlinkError);
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path) return rollbackFailed(operation, "none", target.error ?? "invalid path");
  if (!operation.contentHash) return rollbackFailed(operation, "delete_created_file", "missing content hash for created file rollback");
  if (!existsSync(target.path)) {
    return { id: operation.id, kind: operation.kind, path: operation.path, status: "skipped", action: "delete_created_file" };
  }
  const targetPath = target.path;
  const createdHash = operation.contentHash;
  try {
    // Read + hash inside the try so an unreadable target (e.g. replaced by a
    // directory) returns a structured failed result instead of throwing to the CLI.
    const deleted = withTargetLock(targetPath, () => {
      if (contentHash(readFileSync(targetPath)) !== createdHash) return false;
      rmSync(targetPath);
      fsyncDirectory(dirname(targetPath));
      return true;
    });
    if (!deleted) {
      return rollbackFailed(operation, "delete_created_file", "current file hash differs from transaction content hash");
    }
    return { id: operation.id, kind: operation.kind, path: operation.path, status: "rolled_back", action: "delete_created_file" };
  } catch (error) {
    return rollbackFailed(operation, "delete_created_file", errorMessage(error));
  }
}

function rollbackMkdirOperation(repoRoot: string, operation: ApplyOperationResult): RollbackOperationResult {
  if (!operation.path) return rollbackFailed(operation, "remove_empty_directory", "mkdir operation is missing path");
  const symlinkError = assertNoSymlinkInPath(repoRoot, operation.path);
  if (symlinkError) return rollbackFailed(operation, "remove_empty_directory", symlinkError);
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path) return rollbackFailed(operation, "remove_empty_directory", target.error ?? "invalid path");
  if (!existsSync(target.path)) {
    return { id: operation.id, kind: operation.kind, path: operation.path, status: "skipped", action: "remove_empty_directory" };
  }
  try {
    rmdirSync(target.path);
    fsyncDirectory(dirname(target.path));
    return { id: operation.id, kind: operation.kind, path: operation.path, status: "rolled_back", action: "remove_empty_directory" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code ?? "")) {
      return { id: operation.id, kind: operation.kind, path: operation.path, status: "skipped", action: "remove_empty_directory" };
    }
    return rollbackFailed(operation, "remove_empty_directory", errorMessage(error));
  }
}

function rollbackRemoveOperation(repoRoot: string, operation: ApplyOperationResult): RollbackOperationResult {
  if (!operation.path || !operation.backupPath) return rollbackFailed(operation, "restore_backup", "remove operation is missing path or backup");
  const targetSymlinkError = assertNoSymlinkInPath(repoRoot, operation.path);
  const backupSymlinkError = assertNoSymlinkInPath(repoRoot, operation.backupPath);
  if (targetSymlinkError || backupSymlinkError) {
    return rollbackFailed(operation, "restore_backup", targetSymlinkError ?? backupSymlinkError ?? "invalid remove path");
  }
  const target = resolveInsideRepo(repoRoot, operation.path);
  const backup = resolveInsideRepo(repoRoot, operation.backupPath);
  if (!target.ok || !target.path) return rollbackFailed(operation, "restore_backup", target.error ?? "invalid removed path");
  if (!backup.ok || !backup.path) return rollbackFailed(operation, "restore_backup", backup.error ?? "invalid remove backup");
  if (existsSync(target.path)) return rollbackFailed(operation, "restore_backup", "removed path is occupied; refusing to overwrite it");
  if (!existsSync(backup.path)) return rollbackFailed(operation, "restore_backup", `missing backup: ${operation.backupPath}`);
  try {
    const parentError = ensureParent(repoRoot, operation.path);
    if (parentError) throw new Error(parentError);
    renameSync(backup.path, target.path);
    fsyncDirectory(dirname(backup.path));
    fsyncDirectory(dirname(target.path));
    return { id: operation.id, kind: operation.kind, path: operation.path, status: "rolled_back", action: "restore_backup" };
  } catch (error) {
    return rollbackFailed(operation, "restore_backup", errorMessage(error));
  }
}

function rollbackGitUntrackOperation(repoRoot: string, operation: ApplyOperationResult): RollbackOperationResult {
  if (!operation.path) return rollbackFailed(operation, "restore_git_index", "git untrack operation is missing path");
  const symlinkError = assertNoSymlinkInPath(repoRoot, operation.path);
  if (symlinkError) return rollbackFailed(operation, "restore_git_index", symlinkError);
  const target = resolveInsideRepo(repoRoot, operation.path);
  if (!target.ok || !target.path) return rollbackFailed(operation, "restore_git_index", target.error ?? "invalid git path");
  // An applied untrack always kept its entry (`applyGitUntrackOperation`).
  const recorded = operation.gitIndexEntry!;
  const current = readGitIndexEntry(repoRoot, operation.path);
  if (current.kind === "git_failed" || current.kind === "unsupported") {
    return rollbackFailed(operation, "restore_git_index", current.error);
  }
  if (current.kind === "entry") {
    return current.entry.mode === recorded.mode && current.entry.objectId === recorded.objectId
      ? { id: operation.id, kind: operation.kind, path: operation.path, status: "skipped", action: "restore_git_index" }
      : rollbackFailed(operation, "restore_git_index", "git index entry changed after apply; refusing to replace it");
  }
  // update-index accepts an absent object, so prove the recorded blob still exists.
  const object = runGit(["-C", repoRoot, "cat-file", "-e", `${recorded.objectId}^{blob}`]);
  if (!object.ok) return rollbackFailed(operation, "restore_git_index", `recorded git object is missing: ${recorded.objectId}`);
  const restore = runGit([
    "-C", repoRoot, "update-index", "--add", "--cacheinfo", `${recorded.mode},${recorded.objectId},${operation.path}`,
  ]);
  return restore.ok
    ? { id: operation.id, kind: operation.kind, path: operation.path, status: "rolled_back", action: "restore_git_index" }
    : rollbackFailed(operation, "restore_git_index", restore.stderr || restore.error || "git update-index failed");
}

/**
 * The local operations of a failed run go back in reverse order: files first,
 * then the Git index entries, so each restored entry names a file that is
 * there again.
 */
function rollbackLocal(repoRoot: string, results: readonly ApplyOperationResult[]): RollbackOperationResult[] {
  const applied = [...results].reverse().filter((result) => result.status === "applied");
  const rolledBack = applied.filter((result) => result.kind !== "gitUntrack").map((operation) => {
    if (operation.kind === "mkdir") return rollbackMkdirOperation(repoRoot, operation);
    if (operation.kind === "writeFile" || operation.kind === "appendManagedBlock") return rollbackCreatedFile(repoRoot, operation);
    if (operation.kind === "remove") return rollbackRemoveOperation(repoRoot, operation);
    return rollbackFailed(operation, "none", `unsupported rollback operation kind: ${operation.kind}`);
  });
  return [...rolledBack, ...applied.filter((result) => result.kind === "gitUntrack").map((operation) => rollbackGitUntrackOperation(repoRoot, operation))];
}
