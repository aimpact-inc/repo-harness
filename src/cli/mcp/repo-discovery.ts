import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import { isPathInside } from '../../effects/path-containment';
import { readRegisteredRepoHarnessRepos } from '../../effects/repo-registry';
import { numberArg } from './general-repo-access';
import { canonicalDirectory } from './paths';
import { currentGitBranch, isRepoHarnessAdopted, resolveMcpRepoRoot } from './repo';
import type { McpToolContext } from './tools';

const DEFAULT_DISCOVERY_DEPTH = 7;
const DEFAULT_DISCOVERY_LIMIT = 25;
const DISCOVERY_SKIP_DIRS = new Set([
  '.bun',
  '.codegraph',
  '.local',
  '.Trash',
  '.worktrees',
  '.cache',
  '.git',
  '.npm',
  '.pnpm-store',
  '.repo-harness',
  '.rustup',
  'Applications',
  'Caches',
  'Library',
  'Movies',
  'Music',
  'Pictures',
  'System',
  'Volumes',
  'bin',
  'build',
  'coverage',
  'codex-backups',
  'dev',
  'dist',
  'node_modules',
  'private',
  'proc',
  'sbin',
  'usr',
]);

export function repoSummary(repoRoot: string): { repoRoot: string; adopted: boolean; branch: string | null; workflowRoots: Array<{ path: string; exists: boolean }> } {
  const roots = ['docs/spec.md', 'docs/prds'];
  return {
    repoRoot,
    adopted: isRepoHarnessAdopted(repoRoot),
    branch: currentGitBranch(repoRoot),
    workflowRoots: roots.map((path) => ({ path, exists: existsSync(join(repoRoot, path)) })),
  };
}

function isDiscoverableHarnessRepo(path: string): boolean {
  return isRepoHarnessAdopted(path);
}

export function normalizeRepoSearchTerm(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
  if (normalized === '.' || normalized === '..') return '';
  return normalized;
}

function repoMatchesQuery(repoRoot: string, query: string): boolean {
  const normalizedQuery = normalizeRepoSearchTerm(query);
  if (!normalizedQuery) return true;
  const normalizedRoot = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const repoName = basename(repoRoot).toLowerCase();
  return repoName === normalizedQuery ||
    repoName.includes(normalizedQuery) ||
    normalizedRoot === normalizedQuery ||
    normalizedRoot.endsWith(`/${normalizedQuery}`) ||
    normalizedRoot.includes(`/${normalizedQuery}/`) ||
    normalizedRoot.includes(normalizedQuery);
}

export function repoMatchesAliasExactly(repoRoot: string, query: string): boolean {
  const normalizedQuery = normalizeRepoSearchTerm(query);
  if (!normalizedQuery) return false;
  const normalizedRoot = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return basename(repoRoot).toLowerCase() === normalizedQuery ||
    normalizedRoot === normalizedQuery ||
    normalizedRoot.endsWith(`/${normalizedQuery}`);
}

function discoveryDefaultRoots(ctx: McpToolContext): string[] {
  const configured = [...(ctx.policy.discoveryRoots ?? []), ...(ctx.policy.allowedRoots ?? [])]
    .map((path) => resolve(path))
    .filter((path) => existsSync(path));
  if (configured.length > 0) return Array.from(new Set(configured));
  if (ctx.repoRoot !== '/') return [ctx.repoRoot];
  const home = homedir();
  const candidates = [
    join(home, 'Projects'),
    join(home, 'Documents'),
    join(home, 'Developer'),
    home,
    '/Users',
    '/Volumes',
    '/opt',
    '/tmp',
  ];
  return Array.from(new Set(candidates.map((path) => resolve(path)))).filter((path) => existsSync(path));
}

function discoverySortWeight(repoRoot: string, query = ''): string {
  const normalizedQuery = normalizeRepoSearchTerm(query);
  const repoName = basename(repoRoot).toLowerCase();
  const normalizedRoot = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const queryWeight = !normalizedQuery
    ? '0'
    : repoName === normalizedQuery || normalizedRoot.endsWith(`/${normalizedQuery}`)
      ? '0'
      : repoName.startsWith(normalizedQuery)
        ? '1'
        : repoName.includes(normalizedQuery)
          ? '2'
          : normalizedRoot.includes(normalizedQuery)
            ? '3'
            : '4';
  const home = homedir();
  const projects = join(home, 'Projects');
  const locationWeight = repoRoot.startsWith(`${projects}/`) || repoRoot === projects
    ? '0'
    : repoRoot.startsWith(`${home}/`) || repoRoot === home
      ? '1'
      : repoRoot.startsWith('/Volumes/')
        ? '2'
        : repoRoot.startsWith('/tmp/') || repoRoot.startsWith('/private/tmp/')
          ? '9'
          : '5';
  return `${queryWeight}:${locationWeight}:${repoRoot}`;
}

function stringArgList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

export function authorizedDiscoveryRoots(ctx: McpToolContext): string[] {
  return Array.from(new Set([
    ...(isRepoHarnessAdopted(ctx.repoRoot) ? [ctx.repoRoot] : []),
    ...(ctx.policy.discoveryRoots ?? []),
    ...(ctx.policy.allowedRoots ?? []),
  ].map((path) => canonicalDirectory(path)).filter((path): path is string => path !== null)));
}

function isAuthorizedDiscoveryRoot(ctx: McpToolContext, root: string): boolean {
  const canonical = canonicalDirectory(root);
  if (!canonical) return false;
  return authorizedDiscoveryRoots(ctx).some((authorized) => isPathInside(authorized, canonical));
}

function addDiscoveredRepo(ctx: McpToolContext, repos: Map<string, ReturnType<typeof repoSummary>>, repoRoot: string, query = ''): void {
  const root = canonicalDirectory(resolveMcpRepoRoot(repoRoot));
  if (!root || !isRepoHarnessAdopted(root)) return;
  if (!repoMatchesQuery(root, query)) return;
  if (!repos.has(root)) repos.set(root, repoSummary(root));
  try {
    ctx.workspaceManager?.ensureAllowedRoot(root);
  } catch (_error) {
    // Discovery should report the repo even if a transient filesystem error
    // prevents opening it as a workspace in this session.
  }
}

export function discoverHarnessRepos(ctx: McpToolContext, args: Record<string, unknown> = {}): { scannedRoots: string[]; query: string | null; repos: ReturnType<typeof repoSummary>[]; truncated: boolean } {
  const query = normalizeRepoSearchTerm(args.query) || normalizeRepoSearchTerm(args.name) || normalizeRepoSearchTerm(args.repo_path);
  const requestedRoots = stringArgList(args.roots);
  const roots = (requestedRoots.length > 0 ? requestedRoots : discoveryDefaultRoots(ctx))
    .map((path) => resolve(path))
    .filter((path) => existsSync(path))
    .filter((path) => isAuthorizedDiscoveryRoot(ctx, path));
  const maxDepth = numberArg(args.max_depth, DEFAULT_DISCOVERY_DEPTH, 1, 12);
  const limit = numberArg(args.limit, DEFAULT_DISCOVERY_LIMIT, 1, 100);
  const repos = new Map<string, ReturnType<typeof repoSummary>>();
  for (const entry of readRegisteredRepoHarnessRepos({ adoptedOnly: true })) {
    addDiscoveredRepo(ctx, repos, entry.path, query);
    if (repos.size >= limit) break;
  }
  const queue = roots.map((path) => ({ path, depth: 0 }));
  let truncated = false;

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) continue;
    if (repos.size >= limit) {
      truncated = true;
      break;
    }
    let currentStat;
    try {
      currentStat = statSync(current.path);
    } catch (_error) {
      continue;
    }
    if (!currentStat.isDirectory()) continue;
    if (isDiscoverableHarnessRepo(current.path)) {
      addDiscoveredRepo(ctx, repos, current.path, query);
      if (!query) continue;
    }
    if (current.depth >= maxDepth) continue;
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || DISCOVERY_SKIP_DIRS.has(entry.name)) continue;
      queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }

  return {
    scannedRoots: roots,
    query: query || null,
    repos: Array.from(repos.values()).sort((a, b) => discoverySortWeight(a.repoRoot, query).localeCompare(discoverySortWeight(b.repoRoot, query))),
    truncated,
  };
}
