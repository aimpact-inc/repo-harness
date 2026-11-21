import { readGlobalArchitectureConfiguration } from '../../effects/architecture/projection-config';
import { ARCHITECTURE_DOCS_PROJECTION_MANIFEST_PATH, architectureDocsProjectionManifestIssues, type ArchitectureDocsProjectionManifestV4, type ProjectionHumanActionReasonCode, type ProjectionHumanActionV1, type ProjectionMode } from 'archctx-contracts';
import { ArchctxClient, architectureProjectionRequest, inspectArchitectureProjectionReadiness, readArchitectureDocsAnchors, runArchitectureProjection } from '../../effects/architecture/archctx-provider';
import { architectureModelReady, readArchitectureHandEdits } from '../../effects/architecture/architecture-read';
import { ARCHCTX_REQUIRED_VERSION, ARCHITECTURE_DEBT_COMMAND, decodeProjectionSlice, summarizeArchitectureRender } from '../../core/architecture/projection';
import { applyArchitectureProjection } from '../../effects/architecture/projection-apply';
import { runArchitectureWriter } from '../../effects/architecture/projection-writer';
import { gitExecFileSync, gitSpawnSync } from '../../effects/git/runner';
import { githubRemoteRepository } from '../../core/board/source';
import { runArch } from './arch-actions';
import { resolveCommit } from './arch-verify';
import type { ProjectionCommandOptions } from './architecture-projection';

/** `rh arch projection` loads this module only after the architecture selection check. */
export function policy(): void {
  try {
    const { path, initialized, policy } = readGlobalArchitectureConfiguration();
    write({ ...policy, configuration: { scope: 'global', path, initialized } });
  } catch (error) { fail(error); }
}

export function status(): void {
  try {
    const root = repositoryRoot();
    const { path, initialized } = readGlobalArchitectureConfiguration();
    write({ ...inspectArchitectureProjectionReadiness(root, architectureModelReady), configuration: { scope: 'global', path, initialized } });
  }
  catch (error) { fail(error); }
}

export function slice(options: { base: string; json?: boolean }): void {
  try {
    const root = repositoryRoot();
    const base = resolveCommit(root, options.base);
    if (base === null) throw new Error(`Projection slice base does not resolve to a commit: ${options.base}`);
    const args = ['projection', 'slice', '--base', base, '--json'];
    if (options.json) return runArch(args, root);

    const head = resolveCommit(root, 'HEAD');
    if (head === null) throw new Error('Projection slice needs a resolvable HEAD.');
    const { policy } = readGlobalArchitectureConfiguration();
    if (policy.provider === 'disabled') throw new Error('architecture projection provider is disabled');
    const client = new ArchctxClient(root, ARCHCTX_REQUIRED_VERSION);
    const report = decodeProjectionSlice(client.data(args, policy.timeoutMs), base, head);
    if (!report.changed) { process.stdout.write(report.markdown); return; }
    const paths = baseModulePaths(root, base);
    const origin = gitSpawnSync(['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
    const repository = origin.status === 0 ? githubRemoteRepository(origin.stdout) : null;
    const sections = report.affectedCapabilities.map(entry => {
      const path = paths === null ? entry.modulePath : paths.get(entry.capabilityId);
      const location = path && baseDocumentExists(root, base, path) ? { repository, path } : null;
      const reference = baseModuleReference(base, location);
      const divider = entry.markdown.indexOf('\n');
      if (divider < 0) throw new Error('Projection slice omitted its capability heading.');
      // ArchContext owns the body. Replace its relative heading link with the base evidence.
      return `### ${entry.capabilityId}\n\n${reference}${entry.markdown.slice(divider)}`;
    });
    process.stdout.write(`## Architecture slice\n\n${sections.join('\n\n')}\n`);
  } catch (error) { fail(error); }
}

function baseDocumentExists(root: string, sha: string, path: string): boolean {
  return /^100(?:644|755) blob /.test(git(root, ['--literal-pathspecs', 'ls-tree', sha, '--', path]));
}

function baseModulePaths(root: string, sha: string): ReadonlyMap<string, string> | null {
  const path = ARCHITECTURE_DOCS_PROJECTION_MANIFEST_PATH;
  if (!baseDocumentExists(root, sha, path)) return null;
  const value: unknown = JSON.parse(git(root, ['show', `${sha}:${path}`]));
  const issues = architectureDocsProjectionManifestIssues(value);
  if (issues.length > 0) throw new Error(`Projection manifest at ${sha} is invalid: ${issues.join(', ')}`);
  const paths = new Map<string, string>();
  for (const target of Object.values((value as ArchitectureDocsProjectionManifestV4).targets)) {
    if (target.type === 'entity-summary' && target.scope.entityKind === 'capability' && target.scope.id) {
      paths.set(target.scope.id, target.path);
    }
  }
  return paths;
}

function baseModuleReference(base: string, location: { repository: string | null; path: string } | null): string {
  if (location === null) return `Capability document absent at base \`${base}\`.`;
  const { repository, path } = location;
  if (repository === null) return `Base document at \`${base}:${path}\`.`;
  const url = `https://github.com/${repository}/blob/${base}/${path.split('/').map(encodeURIComponent).join('/')}`;
  return `[Base document](<${url}>)`;
}

export function anchors(): void {
  try { write(readArchitectureDocsAnchors(repositoryRoot())); }
  catch (error) { fail(error); }
}

export function renderCheck(): void {
  try {
    const root = repositoryRoot();
    const summary = summarizeArchitectureRender(runArchitectureProjection(architectureProjectionRequest('check', root), root));
    write(summary);
    if (summary.renderEquivalent !== true) process.exitCode = 1;
  } catch (error) { fail(error); }
}

export function handEdits(options: { base?: string }): void {
  try {
    const root = repositoryRoot();
    const base = options.base ? git(root, ['rev-parse', '--verify', `${options.base}^{commit}`]) : null;
    const paths = base ? new Set(gitExecFileSync(['-C', root, 'diff', '--name-only', '-z', `${base}...HEAD`, '--'], { encoding: 'utf8' }).split('\0').filter(Boolean)) : null;
    write({ edits: readArchitectureHandEdits(root).filter(edit => paths === null || paths.has(edit.path)) });
  } catch (error) { fail(error); }
}

export async function publish(mode: string): Promise<void> {
  try { process.exitCode = await runArchitectureWriter(repositoryRoot(), mode, process.env); }
  catch (error) { fail(error); }
}

export function execute(mode: ProjectionMode, options: ProjectionCommandOptions): void {
  try {
    const root = repositoryRoot();
    const requestOptions = { adoptionPlanId: options.adoptionPlanId, changedPaths: options.changedPath, requestId: options.requestId, expectedWorktreeDigest: options.expectedWorktreeDigest };
    const result = mode === 'apply' || mode === 'adopt'
      ? applyArchitectureProjection(root, { mode, ...requestOptions })
      : runArchitectureProjection(architectureProjectionRequest(mode, root, requestOptions), root);

    write(result);
    for (const action of result.humanActions) process.stderr.write(`${humanActionLine(action)}\n`);
    if (architectureProjectionExitCode(mode, result.status) !== 0) process.exitCode = 1;
  } catch (error) {
    fail(error);
  }
}

const ADOPTION_NEXT = 'preview rh arch docs adopt --profile repo-harness/v1, then run rh arch projection adopt --json --adoption-plan-id <id> (repo-harness-architecture worker, "Adopt ArchContext" step 8)';
const ROLLING_PR_NEXT = 'inspect rh arch projection publish status (with the writer\'s own ARCHCONTEXT_STATE_DIR) and the open rolling PR; its merge is the acceptance; a feature worker does not apply or commit generated docs (repo-harness-architecture worker, "Rolling writer")';
const UNPROVABLE_FLOW_NEXT = `${ARCHITECTURE_DEBT_COMMAND}, then add the missing P1/P2 proof in a model PR; the rolling PR merge is the acceptance (repo-harness-architecture worker, "Adopt ArchContext" step 4)`;
const OWNER_DECISION_NEXT = 'the reported model, proof or ownership decision (external-tooling, "Rolling writer"); a feature worker does not apply or commit generated docs';

export function humanActionLine(action: ProjectionHumanActionV1): string {
  const subject = [...action.affectedNodeIds, ...(action.path ? [action.path] : [])].join(', ');
  return `archctx needs human action: ${action.reasonCode} [${subject}]; next: ${humanActionRemedy(action)}`;
}

function humanActionRemedy(action: ProjectionHumanActionV1): string {
  const code: ProjectionHumanActionReasonCode = action.reasonCode;
  switch (code) {
    case 'adoption-required': return ADOPTION_NEXT;
    case 'unresolved-major-change': return ROLLING_PR_NEXT;
    case 'unprovable-required-flow': return UNPROVABLE_FLOW_NEXT;
    case 'orphaned-document-review': return `a human must review, move or remove ${action.path ?? 'the orphaned document'}; apply never deletes it`;
    case 'manual-region-conflict': return 'inspect rh arch projection hand-edits --json; the writer or model owner repairs generated regions, and a feature worker does not apply or commit generated docs (external-tooling, "architecture checks in CI")';
    case 'target-collision': return OWNER_DECISION_NEXT;
    default: return assertNever(code);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled projection human-action reason code: ${String(value)}`);
}

export function architectureProjectionExitCode(mode: ProjectionMode, status: string): 0 | 1 {
  if (status === 'noop') return 0;
  if (status === 'applied') return mode === 'apply' || mode === 'adopt' ? 0 : 1;
  return mode === 'plan' && status === 'planned' ? 0 : 1;
}

function fail(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function repositoryRoot(): string { return git(process.cwd(), ['rev-parse', '--show-toplevel']); }
function git(cwd: string, args: string[]): string { return gitExecFileSync(['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
