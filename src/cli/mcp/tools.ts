import { sha256Hex } from '../../core/evidence/sha256';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { projectCheckRecords, type CheckRecordsV1 } from '../../core/review/check-records';
import { readChangeAssessmentRecord } from '../../effects/review/change-assessment';
import { isRegisteredRepoHarnessRoot } from '../../effects/repo-registry';
import { hashMcpInput, tryWriteMcpAuditEntry } from './audit';
import { loadMcpLocalConfig } from './auth';
import { guardedWriteFile } from './guarded-write';
import { isPathInside } from '../../effects/path-containment';
import { canonicalDirectory, resolveMcpPath } from './paths';
import { buildReaderToolDefinitions, callReaderTool, createReaderToolContext, isReaderTool } from './reader-tools';
import { isRepoHarnessAdopted, resolveMcpRepoRoot } from './repo';
import { redactMcpText } from './redaction';
import { authorizedDiscoveryRoots, discoverHarnessRepos, normalizeRepoSearchTerm, repoMatchesAliasExactly, repoSummary } from './repo-discovery';
import { errorResult, textResult, type McpToolResult } from './result';
import { buildStateToolDefinitions, callStateTool, isStateTool } from './state-tools';
import { buildFleetToolDefinitions, callFleetTool, fleetToolArgumentError, isFleetTool } from './fleet-tools';
import type { McpPolicy } from './types';
import type { WorkspaceManager } from './workspaces';
import type { GeneralRepoCodeGraphAdapter } from '../tools/codegraph-reader';

export interface McpToolContext {
  repoRoot: string;
  policy: McpPolicy;
  workspaceManager?: WorkspaceManager;
  codeGraphAdapter: GeneralRepoCodeGraphAdapter;
}

function readerContext(ctx: McpToolContext) {
  const reader = createReaderToolContext(ctx.repoRoot, ctx.policy, ctx.codeGraphAdapter, ctx.workspaceManager);
  ctx.workspaceManager = reader.workspaceManager;
  return reader;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

function audit(ctx: McpToolContext, tool: string, status: 'ok' | 'blocked' | 'failed', input: unknown, targetPath?: string, error?: string): void {
  tryWriteMcpAuditEntry(ctx.repoRoot, {
    timestamp: new Date().toISOString(),
    tool,
    status,
    targetPath,
    inputHash: hashMcpInput(input),
    error,
  });
}

/** A failed run stores its error text, which can hold a credential. */
function redactCheckRecords(records: CheckRecordsV1): CheckRecordsV1 {
  return {
    ...records,
    records: records.records.map((record) => (record.state === 'present' && record.status === 'fail' && record.message !== null
      ? { ...record, message: redactMcpText(record.message).text }
      : record)),
  };
}

function resolveAuthorizedRepoAlias(ctx: McpToolContext, raw: string): { ok: true; repoRoot: string } | { ok: false; result: McpToolResult } | null {
  const rawSegments = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  if (isAbsolute(raw) || rawSegments.includes('.') || rawSegments.includes('..')) return null;
  const candidate = resolve(ctx.repoRoot, raw);
  if (existsSync(candidate)) return null;
  const query = normalizeRepoSearchTerm(raw);
  if (!query) return null;
  const discovery = discoverHarnessRepos(ctx, { query, limit: 10 });
  const exact = discovery.repos.filter((repo) => repoMatchesAliasExactly(repo.repoRoot, query));
  const candidates = exact.length > 0 ? exact : discovery.repos;
  if (candidates.length === 1) {
    return { ok: true, repoRoot: candidates[0].repoRoot };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      result: errorResult(
        'REPO_ALIAS_AMBIGUOUS',
        'repo_path matched multiple adopted repositories; call discover_harness_repos with query and pass an exact repo_path.',
        { details: { repo_path: raw, matches: candidates.map((repo) => repo.repoRoot) } },
      ),
    };
  }
  return null;
}

function targetRepoRoot(ctx: McpToolContext, args: Record<string, unknown>): { ok: true; repoRoot: string } | { ok: false; result: McpToolResult } {
  const raw = typeof args.repo_path === 'string' ? args.repo_path.trim() : '';
  if (!raw) {
    return { ok: true, repoRoot: ctx.repoRoot };
  }
  const alias = resolveAuthorizedRepoAlias(ctx, raw);
  if (alias) return alias;
  const candidate = isAbsolute(raw) ? raw : resolve(ctx.repoRoot, raw);
  const repoRoot = canonicalDirectory(resolveMcpRepoRoot(candidate)) ?? resolveMcpRepoRoot(candidate);
  const currentRoot = canonicalDirectory(ctx.repoRoot) ?? ctx.repoRoot;
  if (repoRoot === currentRoot) {
    return { ok: true, repoRoot };
  }
  const registered = isRegisteredRepoHarnessRoot(repoRoot);
  const explicitlyAuthorized = isRepoHarnessAdopted(repoRoot) &&
    authorizedDiscoveryRoots(ctx).some((root) => isPathInside(root, repoRoot));
  if (!registered && !explicitlyAuthorized) {
    return {
      ok: false,
      result: errorResult(
        'POLICY_DENIED',
        'repo_path must target a repo-harness adopted repo registered in ~/.repo-harness/registered-repos.json, or an adopted repo under an explicit allowed discovery root.',
        { details: { repo_path: raw } },
      ),
    };
  }
  if (!isRepoHarnessAdopted(repoRoot)) {
    return { ok: false, result: errorResult('REPO_NOT_ADOPTED', 'repo_path is not a repo-harness adopted repository.', { details: { repo_path: raw } }) };
  }
  try {
    ctx.workspaceManager?.ensureAllowedRoot(repoRoot);
  } catch (_error) {
    // Workflow tools can still use policy-scoped files even if the workspace
    // reader cannot open the root in this session.
  }
  return { ok: true, repoRoot };
}

function isProbablyBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, Math.min(bytes.length, 8000)).includes(0);
}

function fileSummary(path: string, repoRoot: string): { path: string; size: number; modifiedAt: string } | null {
  try {
    const fileStat = statSync(join(repoRoot, path));
    if (!fileStat.isFile()) return null;
    return { path, size: fileStat.size, modifiedAt: fileStat.mtime.toISOString() };
  } catch (_error) {
    return null;
  }
}

function listFilesUnder(repoRoot: string, root: string, maxFiles: number, out: string[]): void {
  if (out.length >= maxFiles) return;
  const absoluteRoot = join(repoRoot, root);
  if (!existsSync(absoluteRoot)) return;
  const rootStat = statSync(absoluteRoot);
  if (rootStat.isFile()) {
    out.push(root);
    return;
  }
  if (!rootStat.isDirectory()) return;
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= maxFiles) return;
    const child = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      listFilesUnder(repoRoot, child, maxFiles, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(child);
    }
  }
}

function workflowFileCandidates(repoRoot: string): string[] {
  const roots = [
    'AGENTS.md',
    'CLAUDE.md',
    'SKILL.md',
    'docs/spec.md',
    'docs/reference-configs',
    'docs/prds',
    'tasks/lessons.md',
    '.ai/context',
  ];
  const files: string[] = [];
  for (const root of roots) {
    const rootFiles: string[] = [];
    listFilesUnder(repoRoot, root, 700, rootFiles);
    files.push(...rootFiles);
  }
  return Array.from(new Set(files)).sort();
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'artifact';
}

function timestampPrefix(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}

function prdArtifactPath(slug: string): string {
  const normalized = slugify(slug);
  const prefixed = /^\d{8}-\d{4}-/.test(normalized) ? normalized : `${timestampPrefix()}-${normalized}`;
  return `docs/prds/${prefixed}.prd.md`;
}

function frontmatter(title: string, kind: string): string {
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `kind: ${JSON.stringify(kind)}`,
    `created_at: ${JSON.stringify(new Date().toISOString())}`,
    `source: "repo-harness-mcp"`,
    '---',
    '',
  ].join('\n');
}

function bodyWithFrontmatter(title: string, kind: string, body: string): string {
  return body.trimStart().startsWith('---') ? body.trimEnd() + '\n' : `${frontmatter(title, kind)}${body.trimEnd()}\n`;
}

/**
 * The workflow-artifact write tools. Each one commits through
 * `guardedWriteFile` and accepts `expected_sha256` as its revision
 * precondition.
 */
const GUARDED_WRITE_TOOLS: readonly string[] = [
  'write_prd',
  'write_prd_from_idea',
];

/**
 * Parameters removed from the write surface, mapped to their replacement.
 * `server.ts` dispatches through the low-level SDK path, so per-tool
 * `inputSchema` is advisory and a retired key would otherwise be silently
 * ignored — which is exactly the last-writer-wins behavior this release
 * removes. Bounded migration window: rejected through 0.16.x, this table is
 * deleted at 0.17.0.
 */
const RETIRED_WRITE_PARAMETERS: Record<string, string> = {
  overwrite: 'expected_sha256',
};

function expectedSha256Arg(args: Record<string, unknown>): string | undefined {
  return typeof args.expected_sha256 === 'string' ? args.expected_sha256 : undefined;
}

function checkWriteToolParameters(ctx: McpToolContext, tool: string, args: Record<string, unknown>): McpToolResult | null {
  const definition = buildMcpToolDefinitions(ctx.policy).find((entry) => entry.name === tool);
  const properties = (definition?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!properties) return null;
  const allowed = Object.keys(properties);
  const supplied = Object.keys(args);

  const retired = supplied.find((key) => !allowed.includes(key) && RETIRED_WRITE_PARAMETERS[key] !== undefined);
  if (retired !== undefined) {
    const replacement = RETIRED_WRITE_PARAMETERS[retired];
    audit(ctx, tool, 'blocked', args, undefined, `retired parameter: ${retired}`);
    return errorResult(
      'RETIRED_PARAMETER',
      `${retired} was removed from the repo-harness MCP workflow write tools in 0.16.1; pass ${replacement} instead. Read the target with read_workflow_file and send its sha256 as ${replacement} to replace an existing file, or omit ${replacement} to create a new one.`,
      { details: { retired, replacement, version: '0.16.1' } },
    );
  }

  const unknown = supplied.filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    audit(ctx, tool, 'blocked', args, undefined, `unknown parameters: ${unknown.join(', ')}`);
    return errorResult('UNKNOWN_PARAMETER', `unknown parameter for ${tool}: ${unknown.join(', ')}`, { details: { unknown, allowed } });
  }
  return null;
}

function writeMarkdownArtifact(
  ctx: McpToolContext,
  repoRoot: string,
  tool: string,
  relativePath: string,
  title: string,
  kind: string,
  body: string,
  expectedSha256: string | undefined,
  input: unknown,
  extra?: Record<string, unknown>,
): McpToolResult {
  const decision = resolveMcpPath(repoRoot, relativePath, ctx.policy, 'write');
  if (!decision.ok || !decision.absolutePath) {
    audit(ctx, tool, 'blocked', input, relativePath, decision.reason);
    return errorResult('POLICY_DENIED', decision.reason ?? 'path denied', { details: { path: relativePath } });
  }
  const outcome = guardedWriteFile(decision.absolutePath, relativePath, bodyWithFrontmatter(title, kind, body), expectedSha256);
  if (!outcome.ok) {
    audit(ctx, tool, outcome.code === 'WRITE_FAILED' ? 'failed' : 'blocked', input, relativePath, outcome.code);
    return errorResult(outcome.code, outcome.message, { details: outcome.details });
  }
  audit(ctx, tool, 'ok', input, relativePath);
  return textResult({
    status: 'written',
    repoRoot,
    path: relativePath,
    sha256: outcome.sha256,
    previousSha256: outcome.previousSha256,
    ...(extra ?? {}),
  });
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
}

function renderPrdFromIdeaBody(args: Record<string, unknown>): string {
  const title = String(args.title ?? 'Untitled PRD').trim() || 'Untitled PRD';
  const idea = String(args.idea ?? '').trim();
  const problem = String(args.problem ?? '').trim() || 'TBD: clarify the concrete user or workflow pain.';
  const users = stringList(args.users);
  const goals = stringList(args.goals);
  const nonGoals = stringList(args.non_goals);
  const success = stringList(args.success_criteria);
  const notes = String(args.notes ?? '').trim();
  return [
    `# ${title}`,
    '',
    '> **Status**: Draft',
    '',
    '## Idea',
    '',
    idea || 'TBD: summarize the originating idea.',
    '',
    '## Problem',
    '',
    problem,
    '',
    '## Users',
    '',
    ...(users.length > 0 ? users.map((entry) => `- ${entry}`) : ['- TBD']),
    '',
    '## Goals',
    '',
    ...(goals.length > 0 ? goals.map((entry) => `- ${entry}`) : ['- Turn the idea into a reviewable repo-harness PRD.']),
    '',
    '## Non-goals',
    '',
    ...(nonGoals.length > 0 ? nonGoals.map((entry) => `- ${entry}`) : ['- Directly executing implementation work through MCP.']),
    '',
    '## Acceptance Criteria',
    '',
    ...(success.length > 0 ? success.map((entry) => `- [ ] ${entry}`) : ['- [ ] The PRD states reviewable acceptance criteria.']),
    '',
    '## Workflow Contract',
    '',
    '- PRD is the source of product intent.',
    '- The GitHub issue owns task identity and execution scope.',
    '- Codex execution must happen through a host-native `/goal` prompt or local Codex session, not through remote MCP execution.',
    '',
    '## Handoff Notes',
    '',
    notes || '- Generated from an idea through repo-harness MCP.',
  ].join('\n');
}

export function buildMcpToolDefinitions(policy: McpPolicy): McpToolDefinition[] {
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
  const optionalRepoSchema = {
    type: 'object',
    properties: { repo_path: { type: 'string' } },
    additionalProperties: false,
  };
  const discoverySchema = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      name: { type: 'string' },
      repo_path: { type: 'string' },
      roots: { type: 'array', items: { type: 'string' } },
      max_depth: { type: 'number' },
      limit: { type: 'number' },
    },
    additionalProperties: false,
  };
  const stringPathSchema = {
    type: 'object',
    properties: { path: { type: 'string' }, repo_path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  };
  const markdownWriterSchema = {
    type: 'object',
    properties: {
      repo_path: { type: 'string' },
      title: { type: 'string' },
      slug: { type: 'string' },
      body: { type: 'string' },
      expected_sha256: { type: 'string' },
    },
    required: ['title', 'slug', 'body'],
    additionalProperties: false,
  };
  const ideaPrdSchema = {
    type: 'object',
    properties: {
      repo_path: { type: 'string' },
      title: { type: 'string' },
      slug: { type: 'string' },
      idea: { type: 'string' },
      problem: { type: 'string' },
      users: { type: 'array', items: { type: 'string' } },
      goals: { type: 'array', items: { type: 'string' } },
      non_goals: { type: 'array', items: { type: 'string' } },
      success_criteria: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
      expected_sha256: { type: 'string' },
    },
    required: ['title', 'slug', 'idea'],
    additionalProperties: false,
  };
  const tools: McpToolDefinition[] = [
    { name: 'harness_status', description: 'Return repo-harness adoption and workflow status. Pass repo_path after discover_harness_repos when targeting another adopted repo.', inputSchema: optionalRepoSchema, annotations: readOnly },
    { name: 'harness_doctor', description: 'Return compact MCP setup diagnostics.', inputSchema: optionalRepoSchema, annotations: readOnly },
    { name: 'discover_harness_repos', description: 'Discover repo-harness adopted repositories from the global registry and explicit allowed discovery roots. Pass query, name, or repo_path for repo-like user inputs such as "my-app/".', inputSchema: discoverySchema, annotations: readOnly },
    { name: 'list_workflow_files', description: 'List policy-readable workflow files. Pass repo_path to target a registered adopted repo.', inputSchema: optionalRepoSchema, annotations: readOnly },
    { name: 'read_workflow_file', description: 'Read one policy-allowed workflow file path from the current or target registered repo.', inputSchema: stringPathSchema, annotations: readOnly },
    { name: 'latest_checks', description: 'Return the typed repo-harness check records (protocol 1): the Change Assessment record is present, absent or invalid.', inputSchema: optionalRepoSchema, annotations: readOnly },
    { name: 'list_prds', description: 'List PRD artifacts under docs/prds.', inputSchema: optionalRepoSchema, annotations: readOnly },
    ...buildStateToolDefinitions(),
    ...buildFleetToolDefinitions(),
    { name: 'write_prd', description: 'Write a PRD under docs/prds/*.prd.md.', inputSchema: markdownWriterSchema, annotations: write },
    { name: 'write_prd_from_idea', description: 'Turn a product idea into a strict-compatible draft PRD under docs/prds/*.prd.md.', inputSchema: ideaPrdSchema, annotations: write },
  ];

  if (policy.capabilities.workspaceReader) {
    tools.push(...buildReaderToolDefinitions(policy));
  }
  return tools;
}

export async function callMcpTool(ctx: McpToolContext, name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
  try {
    if (isReaderTool(name, ctx.policy)) {
      if (!ctx.policy.capabilities.workspaceReader) {
        return errorResult('TOOL_NOT_AVAILABLE', 'reader tools require the workspace reader capability to be enabled in MCP config.');
      }
      return callReaderTool(readerContext(ctx), name, args);
    }
    if (isStateTool(name)) {
      const target = targetRepoRoot(ctx, args);
      if (!target.ok) return target.result;
      const result = callStateTool({
        repoRoot: target.repoRoot,
        mcpPolicyProfile: ctx.policy.profile,
      }, name);
      audit(ctx, name, 'ok', args);
      return textResult(result);
    }
    if (isFleetTool(name)) {
      const argumentError = fleetToolArgumentError(name, args);
      if (argumentError !== undefined) return errorResult('INVALID_ARGUMENT', argumentError);
      return callFleetTool({ repoRoot: ctx.repoRoot, policy: ctx.policy }, name, args);
    }
    if (GUARDED_WRITE_TOOLS.includes(name)) {
      // The low-level SDK dispatch does not enforce per-tool inputSchema, so an
      // undeclared or retired key must be rejected here, before any repo is
      // targeted or any path is resolved.
      const rejected = checkWriteToolParameters(ctx, name, args);
      if (rejected) return rejected;
    }
    switch (name) {
      case 'harness_status': {
        const target = targetRepoRoot(ctx, args);
        if (!target.ok) return target.result;
        const summary = repoSummary(target.repoRoot);
        audit(ctx, name, 'ok', args);
        return textResult({
          protocol: 1,
          kind: 'repo-harness.mcp-harness-status',
          repoRoot: summary.repoRoot,
          adopted: summary.adopted,
          profile: ctx.policy.profile,
          branch: summary.branch,
          workflowRoots: summary.workflowRoots,
        });
      }
      case 'harness_doctor': {
        const target = targetRepoRoot(ctx, args);
        if (!target.ok) return target.result;
        // MCP config has one storage authority (~/.repo-harness, or
        // REPO_HARNESS_HOME); it is not per-repo, so this must not probe the
        // retired <repo>/.repo-harness path. Same shape as runMcpDoctor.
        const localConfig = Boolean(loadMcpLocalConfig());
        audit(ctx, name, 'ok', args);
        return textResult({
          status: isRepoHarnessAdopted(target.repoRoot) ? 'ready_local' : 'not_adopted',
          repo: target.repoRoot,
          profile: ctx.policy.profile,
          mcp: {
            localConfig,
            policy: 'builtin',
            deniedPaths: ctx.policy.denyGlobs.length,
          },
        });
      }
      case 'discover_harness_repos': {
        const discovery = discoverHarnessRepos(ctx, args);
        audit(ctx, name, 'ok', args);
        return textResult(discovery);
      }
      case 'list_workflow_files': {
        const target = targetRepoRoot(ctx, args);
        if (!target.ok) return target.result;
        const files = workflowFileCandidates(target.repoRoot)
          .filter((path) => resolveMcpPath(target.repoRoot, path, ctx.policy, 'read').ok)
          .map((path) => fileSummary(path, target.repoRoot))
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .filter((entry) => entry.size <= ctx.policy.maxFileBytes);
        audit(ctx, name, 'ok', args);
        return textResult({ files });
      }
      case 'read_workflow_file': {
        const target = targetRepoRoot(ctx, args);
        if (!target.ok) return target.result;
        const path = typeof args.path === 'string' ? args.path : '';
        const decision = resolveMcpPath(target.repoRoot, path, ctx.policy, 'read');
        if (!decision.ok || !decision.absolutePath || !decision.relativePath) {
          audit(ctx, name, 'blocked', args, path, decision.reason);
          return errorResult('POLICY_DENIED', decision.reason ?? 'path denied', { details: { path } });
        }
        const fileStat = statSync(decision.absolutePath);
        if (!fileStat.isFile()) return errorResult('NOT_A_FILE', `path is not a file: ${decision.relativePath}`);
        if (fileStat.size > ctx.policy.maxFileBytes) return errorResult('FILE_TOO_LARGE', `file exceeds ${ctx.policy.maxFileBytes} bytes`);
        const bytes = readFileSync(decision.absolutePath);
        if (isProbablyBinary(bytes)) return errorResult('BINARY_FILE', 'binary files are not supported');
        const raw = bytes.toString('utf-8');
        const redacted = redactMcpText(raw);
        audit(ctx, name, 'ok', args, decision.relativePath);
        return textResult({
          path: decision.relativePath,
          size: fileStat.size,
          sha256: sha256Hex(raw),
          redactions: redacted.redactions,
          content: redacted.text,
        });
      }
      case 'latest_checks': {
        const target = targetRepoRoot(ctx, args);
        if (!target.ok) return target.result;
        const records = projectCheckRecords({ changeAssessment: readChangeAssessmentRecord(target.repoRoot, ctx.policy.maxFileBytes) });
        audit(ctx, name, 'ok', args);
        return textResult(redactCheckRecords(records));
      }
      case 'list_prds': {
        const target = targetRepoRoot(ctx, args);
        if (!target.ok) return target.result;
        const files: string[] = [];
        listFilesUnder(target.repoRoot, 'docs/prds', 200, files);
        audit(ctx, name, 'ok', args);
        return textResult({ files: files.map((path) => fileSummary(path, target.repoRoot)).filter(Boolean) });
      }
      case 'write_prd': {
        const target = targetRepoRoot(ctx, args);
        if (!target.ok) return target.result;
        const title = String(args.title ?? '').trim();
        const slug = slugify(String(args.slug ?? title));
        return writeMarkdownArtifact(ctx, target.repoRoot, name, prdArtifactPath(slug), title, 'prd', String(args.body ?? ''), expectedSha256Arg(args), args);
      }
      case 'write_prd_from_idea': {
        const target = targetRepoRoot(ctx, args);
        if (!target.ok) return target.result;
        const title = String(args.title ?? '').trim();
        const slug = slugify(String(args.slug ?? title));
        const body = renderPrdFromIdeaBody(args);
        return writeMarkdownArtifact(ctx, target.repoRoot, name, prdArtifactPath(slug), title, 'prd', body, expectedSha256Arg(args), args);
      }
      default:
        return errorResult('UNKNOWN_TOOL', `unknown MCP tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit(ctx, name, 'failed', args, undefined, message);
    return errorResult('TOOL_FAILED', message);
  }
}
