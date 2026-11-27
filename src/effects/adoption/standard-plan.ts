import { FileSyntaxError, parseJsonText } from "../../core/evidence/file-syntax";
import { renderJsonObjectUpdate } from "../../core/evidence/json-object-update";
import { sha256Prefixed } from "../../core/evidence/sha256";
import { existsSync, lstatSync, readdirSync, readFileSync } from "fs";
import { join, relative, resolve, sep } from "path";
import type { AdoptionMode } from "../../core/adoption/modes";
import type { AdoptionOperation, AdoptionWarning, WriteFileOperation } from "../../core/adoption/operations";
import { makeOperationId } from "../../core/adoption/operations";
import { adoptionTemplateFile } from "./manifest-templates";
import { gitignoreManagedBlockOperation, ignoreBlockProof } from "./gitignore-plan";
import { upsertManagedBlock } from "../../core/adoption/managed-block";
import { renderWorkflowContractMarker } from "../../core/adoption/workflow-contract-asset";
import { minimumHarnessVersionOf } from "../../core/adoption/minimum-harness-version";
import { planLegacyLeftovers } from "../upgrade/legacy-inventory";
import { runGit } from "../git/run-git";
import { pruneUnknownPolicyKeys } from "../../core/workflow/policy-schema";
import { withoutRepositorySelectingGitEnv } from "../git/runner";
import { MANAGED_PACKAGE_SCRIPTS, RETIRED_PACKAGE_SCRIPT_KEYS } from "../../core/adoption/package-scripts";
import { isReleasedPackageScript, isReleasedReferenceConfig } from "../upgrade/released-values";

const ASSET_ROOT = join(import.meta.dir, "..", "..", "..", "assets");
const TEMPLATE_ROOT = join(ASSET_ROOT, "templates");
const REFERENCE_ROOT = join(ASSET_ROOT, "reference-configs");

const STANDARD_DIRS = [
  "tasks",
  "docs",
  "docs/prds",
  "docs/researches",
  "docs/reference-configs",
  "docs/architecture/modules",
  "docs/architecture/diagrams",
  ".ai/context",
  ".ai/harness/checks",
  ".ai/harness/failures",
  ".ai/harness/security",
  ".ai/harness/planning",
  ".ai/harness/delegation",
  ".ai/harness/worktrees",
  ".ai/harness/triage",
  ".ai/harness/runs",
  "deploy/env",
  "deploy/scripts",
  "deploy/submissions",
  "deploy/runbooks",
  "deploy/release-checklists",
  "deploy/sql",
  "_ops/env",
  "_ops/secrets",
  "_ops/artifacts",
  "_ops/logs",
  "_ops/state",
  "_ops/scratch",
] as const;

const MINIMAL_DIRS = [
  "tasks",
  "docs",
  ".ai/harness/checks",
] as const;

const STATE_FILES: ReadonlyArray<{ path: string; content: string }> = [
  { path: ".ai/context/capability-source-map.json", content: '{\n  "version": 1,\n  "capabilities": {}\n}\n' },
  { path: ".ai/harness/events.jsonl", content: "" },
  { path: ".ai/harness/failures/latest.jsonl", content: "" },
  { path: ".ai/harness/security/.gitkeep", content: "" },
  { path: ".ai/harness/planning/.gitkeep", content: "" },
  { path: ".ai/harness/worktrees/.gitkeep", content: "" },
  { path: ".ai/harness/runs/.gitkeep", content: "" },
  { path: ".ai/harness/triage/.gitkeep", content: "" },
  { path: "docs/architecture/modules/.gitkeep", content: "" },
  { path: "docs/architecture/diagrams/.gitkeep", content: "" },
  { path: "deploy/env/.gitkeep", content: "" },
  { path: "deploy/scripts/.gitkeep", content: "" },
  { path: "deploy/submissions/.gitkeep", content: "" },
  { path: "deploy/runbooks/.gitkeep", content: "" },
  { path: "deploy/release-checklists/.gitkeep", content: "" },
  { path: "deploy/sql/.gitkeep", content: "" },
];

type JsonObject = Record<string, unknown>;

export interface StandardPlanOptions {
  readonly repoRoot: string;
  readonly mode: AdoptionMode;
  readonly env?: NodeJS.ProcessEnv;
}

function safePath(repoRoot: string, path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    throw new Error(`unsafe adoption path: ${path}`);
  }
  const root = resolve(repoRoot);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === "..") throw new Error(`adoption path escapes repo root: ${path}`);
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`symlink is not allowed in adoption path: ${path}`);
    }
  }
  return target;
}

function fileContent(repoRoot: string, path: string): string | undefined {
  const target = safePath(repoRoot, path);
  if (!existsSync(target)) return undefined;
  if (!lstatSync(target).isFile()) throw new Error(`adoption file target is not a regular file: ${path}`);
  return readFileSync(target, "utf-8");
}

function directoryExists(repoRoot: string, path: string): boolean {
  const target = safePath(repoRoot, path);
  if (!existsSync(target)) return false;
  if (!lstatSync(target).isDirectory()) throw new Error(`adoption directory target is not a directory: ${path}`);
  return true;
}

/** The sha256 of the file's bytes, as the apply and the host-config gate compare them (#2903). */
function fileHash(repoRoot: string, path: string): string {
  return sha256Prefixed(readFileSync(safePath(repoRoot, path)));
}

function writeOperation(
  repoRoot: string,
  path: string,
  content: string,
  reason: string,
  opts: { readonly ifMissing?: boolean; readonly mode?: number; readonly risk?: "low" | "medium" | "high"; readonly existing?: string } = {},
): WriteFileOperation {
  // A caller that derived `content` from the file passes the text that it read, so apply checks those bytes.
  const existing = opts.existing ?? fileContent(repoRoot, path);
  return {
    id: makeOperationId("writeFile", path, opts.ifMissing ? "ifMissing" : "replace"),
    kind: "writeFile",
    path,
    content,
    ifMissing: opts.ifMissing,
    mode: opts.mode,
    reason,
    risk: opts.risk ?? "low",
    status: existing === undefined ? "planned" : opts.ifMissing || existing === content ? "skipped" : "planned",
    expectedAbsent: existing === undefined,
    expectedContentHash: existing === undefined ? undefined : fileHash(repoRoot, path),
  };
}

function mkdirOperation(repoRoot: string, path: string, reason: string): AdoptionOperation {
  return {
    id: makeOperationId("mkdir", path),
    kind: "mkdir",
    path,
    reason,
    risk: "low",
    status: directoryExists(repoRoot, path) ? "skipped" : "planned",
  };
}

function removeOperation(repoRoot: string, path: string, reason: string): AdoptionOperation | undefined {
  const target = safePath(repoRoot, path);
  if (!existsSync(target)) return undefined;
  const existing = lstatSync(target).isFile() ? readFileSync(target, "utf-8") : undefined;
  return {
    id: makeOperationId("remove", path),
    kind: "remove",
    path,
    reason,
    risk: "medium",
    status: "planned",
    expectedContentHash: existing === undefined ? undefined : fileHash(repoRoot, path),
  };
}

function jsonFile(repoRoot: string, path: string): JsonObject | undefined {
  const raw = fileContent(repoRoot, path);
  if (raw === undefined) return undefined;
  try {
    const value = parseJsonText(raw, path);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("not an object");
    return value as JsonObject;
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${error instanceof FileSyntaxError ? error.detail : error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The target repo's capability authority selector, read from the merged policy.
 * Anything other than the explicit `archcontext` opt-in stays on the registry
 * default so downstream scaffolding is unaffected.
 */
function capabilitySourceOf(policy: JsonObject): "registry" | "archcontext" {
  const context = policy.context;
  const value = context && typeof context === "object" && !Array.isArray(context)
    ? (context as JsonObject).capability_source
    : undefined;
  return value === "archcontext" ? "archcontext" : "registry";
}

function deepMergeDefaults(defaults: JsonObject, current: JsonObject | undefined): JsonObject {
  const result: JsonObject = { ...defaults };
  if (!current) return result;
  for (const [key, value] of Object.entries(current)) {
    const defaultValue = defaults[key];
    result[key] = isObject(defaultValue) && isObject(value) ? deepMergeDefaults(defaultValue, value) : value;
  }
  return result;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && !Array.isArray(value) && typeof value === "object";
}

function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const DOCUMENTATION_LANGUAGES = ["en", "zh-CN", "follow-user"] as const;

export type DocumentationLanguage = (typeof DOCUMENTATION_LANGUAGES)[number];

/**
 * Human-facing document language is one repo-level datum. It is authored by
 * `REPO_HARNESS_DOCUMENTATION_LANGUAGE` at init and stored in
 * `.ai/harness/policy.json#documentation.language`; both the incoming env value
 * and an already-stored value are rejected fail-closed rather than silently
 * falling back to the default, because a silent default would make a typo look
 * like a deliberate English choice.
 */
export function requireDocumentationLanguage(value: unknown): DocumentationLanguage {
  if (typeof value === "string" && (DOCUMENTATION_LANGUAGES as readonly string[]).includes(value)) {
    return value as DocumentationLanguage;
  }
  throw new Error(
    `invalid documentation language ${JSON.stringify(value)}: REPO_HARNESS_DOCUMENTATION_LANGUAGE and .ai/harness/policy.json#documentation.language accept only ${DOCUMENTATION_LANGUAGES.join(" | ")}`,
  );
}

const REMOTE_HEAD_PREFIX = "refs/remotes/origin/";

/** No git ref names a default branch, so `init` cannot author `review_base`. */
export class ReviewBaseUnresolvedError extends Error {
  readonly code = "review_base_unresolved";

  constructor(repoRoot: string) {
    super(
      `cannot set .ai/harness/policy.json#worktree_strategy.review_base: ${repoRoot} has no refs/remotes/origin/HEAD and no current branch (detached HEAD or not a git repository). Check out a branch or run \`git remote set-head origin --auto\`, then run rh init again. Use --mode minimal for a non-git scaffold.`,
    );
    this.name = "ReviewBaseUnresolvedError";
  }
}

function symbolicRef(repoRoot: string, env: NodeJS.ProcessEnv | undefined, args: readonly string[]): string | null {
  // `-C` does not win over GIT_DIR, and the runner re-merges process.env unless inheritance is off.
  const read = runGit(["-C", repoRoot, "symbolic-ref", "--quiet", ...args], { env: withoutRepositorySelectingGitEnv({ ...process.env, ...env }), inheritEnv: false });
  if (read.ok) return read.stdout.trim();
  // Exit 1 is the one answer that means "not a symbolic ref". Any other failure must not select a lower authority.
  if (read.status === 1 && !read.timedOut) return null;
  throw new ReviewBaseUnresolvedError(repoRoot);
}

/** An unborn HEAD still names its branch. The git refs are the authority, read once when the policy is created. */
function defaultBranchOf(repoRoot: string, env: NodeJS.ProcessEnv | undefined): string {
  const remoteHead = symbolicRef(repoRoot, env, ["refs/remotes/origin/HEAD"]);
  if (remoteHead?.startsWith(REMOTE_HEAD_PREFIX)) return remoteHead.slice(REMOTE_HEAD_PREFIX.length);
  const currentBranch = symbolicRef(repoRoot, env, ["--short", "HEAD"]);
  if (currentBranch) return currentBranch;
  throw new ReviewBaseUnresolvedError(repoRoot);
}

const BRANCH_KEYS = ["base_branch", "review_base", "merge_back"] as const;

/**
 * Only a new policy reads git, once, so its three keys cannot differ. An existing policy
 * supplies its own values here so that each key keeps its position in the merged bytes, and a
 * missing key stays missing.
 */
function branchKeysFor(opts: StandardPlanOptions, policyCurrent: JsonObject | undefined): JsonObject {
  if (policyCurrent !== undefined) {
    const strategy = isObject(policyCurrent.worktree_strategy) ? policyCurrent.worktree_strategy : {};
    return Object.fromEntries(BRANCH_KEYS.filter((key) => key in strategy).map((key) => [key, strategy[key]]));
  }
  if (opts.mode === "minimal") return {};
  const branch = defaultBranchOf(opts.repoRoot, opts.env);
  return { base_branch: branch, review_base: branch, merge_back: { target: branch } };
}

/**
 * A new policy holds only the keys that need a repository value. A reader with
 * a package default (`tasks.research_dir`, `context.map_file`, `harness.runs_dir`)
 * gets no key.
 */
export function defaultPolicy(documentationLanguage: string, branchKeys: JsonObject = {}): JsonObject {
  return {
    context: { capability_source: "registry" },
    ...(Object.keys(branchKeys).length > 0 ? { worktree_strategy: branchKeys } : {}),
    documentation: { language: requireDocumentationLanguage(documentationLanguage) },
    internal_pr_authors: [],
  };
}

/**
 * Adoption rewrites the marker but keeps a declared minimum harness version.
 * A marker that is not JSON is replaced as before. An invalid declared value
 * fails the plan.
 */
function declaredMinimumHarnessVersion(markerText: string | undefined): string | undefined {
  if (markerText === undefined) return undefined;
  let marker: unknown;
  try {
    marker = JSON.parse(markerText);
  } catch {
    return undefined;
  }
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return undefined;
  return minimumHarnessVersionOf(marker) ?? undefined;
}

/** The downstream root context. assets/templates/root-context.md is its only source. */
function rootContextContent(): string {
  return readFileSync(join(TEMPLATE_ROOT, "root-context.md"), "utf-8");
}

function deployReadmeContent(): string {
  return `# Deployment Operations

\`deploy/\` is the tracked deployment and operations surface for runbooks, submission material, release checklists, helper scripts, ordered SQL files, and env examples. Keep private keys, real env values, provider state, artifacts, logs, and scratch files in ignored \`_ops/\` only.
`;
}

function researchReadmeContent(): string {
  return `# Research Reports

Durable research reports live in this directory as topic-scoped Markdown files. Keep correction-derived rules in \`tasks/lessons.md\`.
`;
}

function referenceStub(name: string): string {
  const docId = name.replace(/\.md$/, "");
  return `<!-- repo-harness: reference-config-stub v1 -->
# repo-harness Reference: ${docId}

> **Runtime Docs**: user-level repo-harness reference
> **Doc ID**: ${docId}
> **Source Command**: \`rh docs path ${docId}\`

This repo keeps workflow facts and runtime artifacts locally under \`.ai/\`.
Use \`rh docs show ${docId}\` for the full generic runtime guide.
`;
}

function addLegacyCleanup(repoRoot: string, operations: AdoptionOperation[]): AdoptionWarning[] {
  const plan = planLegacyLeftovers({ scope: "project", cwd: repoRoot, home: repoRoot, packageRoot: join(ASSET_ROOT, ".."), installOwnership: () => () => null });
  const warnings: AdoptionWarning[] = [];
  for (const item of plan.items) {
    const path = relative(resolve(repoRoot), item.path).split(sep).join("/");
    // The repository hook strip is a host-config gate write after the transaction (#2854): its file copy stays out of the working tree.
    if (item.action === "strip-entry") continue;
    if (item.action === "report") {
      if (item.surface === "hook-entry") {
        warnings.push({ code: "hook-settings-not-editable", message: `Preserving ${path}: ${item.reason}`, risk: "medium" });
      } else if (item.reason === "Current bytes do not match the declared retired generated asset.") {
        warnings.push({ code: "known-generated-fingerprint-mismatch", message: `Preserving ${path}: current bytes do not match the declared retired generated asset`, risk: "medium" });
      }
      continue;
    }
    if (item.action !== "remove") continue;
    // Adoption's existing transaction format snapshots regular files only.
    if (item.surface !== "file") continue;
    const remove = removeOperation(repoRoot, path, "Remove known-generated retired workflow asset");
    if (remove) operations.push(remove);
    operations.push({
      id: makeOperationId("gitUntrack", path), kind: "gitUntrack", path,
      reason: "Untrack removed known-generated workflow asset from the git index", risk: "medium", status: "planned",
    });
  }
  return warnings;
}

function addReferenceOperations(repoRoot: string, documentationProfile: string, operations: AdoptionOperation[]): AdoptionWarning[] {
  const minimal = new Set([
    "harness-overview.md",
    "agentic-development-flow.md",
    "design-options.md",
    "ux-feature-guard.md",
    "external-tooling.md",
    "heartbeat-triage.md",
    "document-generation.md",
    "global-working-rules.md",
    "change-assessment.md",
  ]);
  const warnings: AdoptionWarning[] = [];
  for (const name of readdirSync(REFERENCE_ROOT).filter((entry) => entry.endsWith(".md")).sort()) {
    if (!documentationProfile.startsWith("full") && !minimal.has(name)) continue;
    const target = `docs/reference-configs/${name}`;
    const existing = fileContent(repoRoot, target);
    const stub = referenceStub(name);
    // A Windows checkout converts LF to CRLF; only other byte differences are edits.
    if (existing !== undefined && existing.replaceAll("\r\n", "\n") !== stub && !isReleasedReferenceConfig(name.replace(/\.md$/, ""), existing)) {
      warnings.push({ code: "customized-managed-value", message: `Preserving ${target}: it is not a reference-config stub that a release wrote; delete it to get the current stub`, risk: "low" });
      continue;
    }
    operations.push(writeOperation(repoRoot, target, stub, "Install deterministic reference-config runtime stub", { risk: "low" }));
  }
  return warnings;
}

function addPackageOperation(repoRoot: string, operations: AdoptionOperation[]): AdoptionWarning[] {
  const current = jsonFile(repoRoot, "package.json");
  if (!current) return [];
  const scripts = isObject(current.scripts) ? { ...current.scripts } : {};
  const kept: string[] = [];
  for (const key of RETIRED_PACKAGE_SCRIPT_KEYS) {
    if (!Object.hasOwn(scripts, key)) continue;
    if (isReleasedPackageScript(key, scripts[key])) delete scripts[key];
    else kept.push(`${key}: ${JSON.stringify(scripts[key])}`);
  }
  for (const [key, value] of Object.entries(MANAGED_PACKAGE_SCRIPTS)) {
    if (!Object.hasOwn(scripts, key) || scripts[key] === value || isReleasedPackageScript(key, scripts[key])) scripts[key] = value;
    else kept.push(`${key}: ${JSON.stringify(scripts[key])} (current value: ${JSON.stringify(value)})`);
  }
  const raw = fileContent(repoRoot, "package.json")!;
  const content = renderJsonObjectUpdate(raw, { ...current, private: current.private ?? true, scripts });
  operations.push(writeOperation(repoRoot, "package.json", content, "Install canonical repo-harness workflow package scripts", { risk: "medium" }));
  return kept.length === 0 ? [] : [{
    code: "customized-managed-value",
    message: `Preserving package.json scripts that differ from every released value: ${kept.join("; ")}`,
    risk: "medium",
  }];
}

export function planStandardAdoption(opts: StandardPlanOptions): { operations: AdoptionOperation[]; warnings: AdoptionWarning[] } {
  const operations: AdoptionOperation[] = [];
  const documentationProfile = opts.env?.REPO_HARNESS_DOCUMENTATION_PROFILE ?? "minimal-agentic";
  const documentationLanguage = requireDocumentationLanguage(opts.env?.REPO_HARNESS_DOCUMENTATION_LANGUAGE ?? "en");
  const policyCurrent = jsonFile(opts.repoRoot, ".ai/harness/policy.json");
  const merged = deepMergeDefaults(defaultPolicy(documentationLanguage, branchKeysFor(opts, policyCurrent)), policyCurrent);
  requireDocumentationLanguage(isObject(merged.documentation) ? merged.documentation.language : undefined);
  // The schema lists every key that a reader uses. Any other key leaves, so a
  // retired key needs no retirement rule; a schema key keeps its value.
  const { policy, removed: unknownKeys } = pruneUnknownPolicyKeys(merged);
  const policyRaw = fileContent(opts.repoRoot, ".ai/harness/policy.json");
  const policyText = policyRaw === undefined ? jsonContent(policy) : renderJsonObjectUpdate(policyRaw, policy);

  for (const path of opts.mode === "minimal" ? MINIMAL_DIRS : STANDARD_DIRS) {
    operations.push(mkdirOperation(opts.repoRoot, path, "Ensure canonical repo-harness workflow directory exists"));
  }
  for (const template of ["spec", "lessonsLog"] as const) {
    const file = adoptionTemplateFile(opts.repoRoot, template);
    operations.push(writeOperation(opts.repoRoot, file.path, file.content, file.reason, { ifMissing: true }));
  }
  operations.push(writeOperation(opts.repoRoot, ".ai/harness/workflow-contract.json", renderWorkflowContractMarker(declaredMinimumHarnessVersion(fileContent(opts.repoRoot, ".ai/harness/workflow-contract.json"))), "Install the repo-harness opt-in marker"));

  const gitignore = fileContent(opts.repoRoot, ".gitignore") ?? "";
  const gitignoreOperation = gitignoreManagedBlockOperation(opts.repoRoot, "planned");
  const gitignoreUpdate = upsertManagedBlock(gitignore, gitignoreOperation, ignoreBlockProof(gitignoreOperation));
  const gitignoreWarnings: AdoptionWarning[] = gitignoreUpdate.kept === undefined ? [] : [{
    code: "customized-managed-value",
    message: `Preserving the edited block "${gitignoreUpdate.kept}" in .gitignore: it differs from every released block; delete the block to get the current one`,
    risk: "low",
  }];
  operations.push({
    ...gitignoreOperation,
    status: !gitignoreUpdate.ok || gitignoreUpdate.changed ? "planned" : "skipped",
    expectedAbsent: fileContent(opts.repoRoot, ".gitignore") === undefined,
    expectedContentHash: fileContent(opts.repoRoot, ".gitignore") === undefined ? undefined : fileHash(opts.repoRoot, ".gitignore"),
  });

  const unknownKeyWarnings: AdoptionWarning[] = unknownKeys.length > 0
    ? [{ code: "unknown-policy-keys", message: `Removed policy keys that no reader uses: ${unknownKeys.join(", ")}`, risk: "medium" }]
    : [];
  if (opts.mode === "minimal") {
    // A minimal scaffold creates no policy. When one exists, the same key
    // removal runs and is reported.
    if (policyCurrent !== undefined) {
      operations.push(writeOperation(opts.repoRoot, ".ai/harness/policy.json", policyText, "Remove policy keys that no reader uses", { risk: "medium" }));
    }
    return { operations, warnings: [...gitignoreWarnings, ...addLegacyCleanup(opts.repoRoot, operations), ...unknownKeyWarnings] };
  }

  operations.push(writeOperation(opts.repoRoot, ".ai/harness/policy.json", policyText, "Merge harness policy defaults and remove policy keys that no reader uses", { risk: "medium" }));
  // Seeding an empty registry into an archcontext-authority repo would
  // reinstate the retired second authority, so the capability_source selector
  // gates the seed. Registry-mode repos (the scaffold default) are unchanged.
  if (capabilitySourceOf(policy) === "registry") {
    operations.push(writeOperation(opts.repoRoot, ".ai/context/capabilities.json", jsonContent(jsonFile(opts.repoRoot, ".ai/context/capabilities.json") ?? { version: 1, capabilities: [] }), "Install canonical empty capability registry when absent", { ifMissing: true }));
  }
  operations.push(writeOperation(opts.repoRoot, ".ai/context/context-map.json", jsonContent(jsonFile(opts.repoRoot, ".ai/context/context-map.json") ?? {
    version: 1,
    root_context_files: ["CLAUDE.md", "AGENTS.md", "docs/spec.md", ".ai/context/capabilities.json", ".ai/harness/policy.json"],
    discoverable_contexts: [],
  }), "Install canonical context map when absent", { ifMissing: true }));
  for (const state of STATE_FILES) operations.push(writeOperation(opts.repoRoot, state.path, state.content, "Ensure canonical harness state artifact exists", { ifMissing: true }));
  for (const file of [
    { path: "docs/researches/README.md", content: researchReadmeContent() },
    { path: "deploy/README.md", content: deployReadmeContent() },
    { path: "CLAUDE.md", content: rootContextContent() },
    { path: "AGENTS.md", content: rootContextContent() },
  ]) operations.push(writeOperation(opts.repoRoot, file.path, file.content, "Install canonical root workflow context when absent", { ifMissing: true, risk: "medium" }));

  const referenceWarnings = addReferenceOperations(opts.repoRoot, documentationProfile, operations);
  const packageWarnings = addPackageOperation(opts.repoRoot, operations);
  const cleanupWarnings = addLegacyCleanup(opts.repoRoot, operations);

  const warnings: AdoptionWarning[] = [
    ...gitignoreWarnings,
    ...referenceWarnings,
    ...packageWarnings,
    ...cleanupWarnings,
    ...unknownKeyWarnings,
    ...(opts.mode === "self-host"
      ? [{ code: "self-host-review", message: "Self-host adoption requires an explicit hook/runtime review and is intentionally not applied by the public command.", risk: "high" } as const]
      : []),
  ];
  if (opts.mode === "self-host") {
    operations.push({
      id: makeOperationId("runCheck", "self-host-adoption-boundary-review"),
      kind: "runCheck",
      command: "manual:self-host-hook-helper-pin-review",
      reason: "Self-host adoption must fail before writes until the hook/helper runtime review is deterministic.",
      risk: "high",
      status: "planned",
    });
  }
  return { operations, warnings };
}
