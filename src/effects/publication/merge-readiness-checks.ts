import {
  assessRequiredCheckFailure,
  type RequiredCheckAttemptObservationV1,
  type RequiredCheckChildObservationV1,
  type RequiredCheckFailureEvidenceV1,
} from '../../core/evidence/required-check-evidence';
import type { RequiredCheckTestExecutionV1 } from '../../core/evidence/test-execution-evidence';
import { parseWorkflowGraph, placeFailedJobs } from '../../core/evidence/workflow-needs';
import type { RequiredCheckBucketV1 } from '../../core/publication/merge-readiness';
import type { ProviderIdentityData, ProviderReader, ProviderRequest } from './merge-readiness-transport';

type ProviderCheckBucket = RequiredCheckBucketV1;

export interface ProviderCheck {
  readonly name: string;
  readonly bucket: ProviderCheckBucket;
  readonly link: string;
  readonly workflow: string;
}

export function providerCheck(value: unknown, reader: ProviderReader): ProviderCheck {
  const check = reader.object(value, 'provider required check');
  if (typeof check.bucket !== 'string'
    || !['pass', 'fail', 'pending', 'skipping', 'cancel'].includes(check.bucket)) {
    reader.fail('provider_data_incomplete', 'provider required check bucket is unknown');
  }
  return Object.freeze({
    name: reader.string(check.name, 'provider required check name'),
    bucket: check.bucket as ProviderCheckBucket,
    // External status checks need no Actions link.
    link: typeof check.link === 'string' ? check.link : '',
    workflow: typeof check.workflow === 'string' ? check.workflow : '',
  });
}

export function checkArray(value: unknown, reader: ProviderReader): ProviderCheck[] {
  if (!Array.isArray(value)) reader.fail('provider_data_incomplete', 'provider required checks must be an array');
  return value.map(entry => providerCheck(entry, reader));
}

export function protectedChecks(
  identity: ProviderIdentityData,
  prNumber: number,
  requiredStatusChecksAtBase: unknown,
  reader: ProviderReader,
): ProviderCheck[] {
  const required = requiredStatusChecksAtBase === undefined
    ? reader.object(
      reader.gh(['api', `repos/${identity.repo_name_with_owner}/branches/${encodeURIComponent(identity.base_ref)}/protection`]),
      'base protection',
    ).required_status_checks
    : requiredStatusChecksAtBase;
  const contexts = reader.object(required, 'base required status checks').contexts;
  if (!Array.isArray(contexts) || contexts.length === 0) {
    reader.fail('provider_data_incomplete', 'base protection must require at least one status check context');
  }
  const names = new Set(contexts.map(context => reader.string(context, 'protected check context')));
  const checks = checkArray(reader.gh([
    'pr', 'checks', String(prNumber), '--required', '--json', 'name,bucket,link,workflow',
  ], [0, 1, 8]), reader);
  for (const name of names) {
    if (!checks.some(check => check.name === name)) {
      reader.fail(
        'provider_data_incomplete',
        `protected check context is missing: ${name}`,
        undefined,
        'a base protection required_status_checks context is missing from the required checks',
      );
    }
  }
  return checks;
}

interface RequiredCheckLink {
  readonly run_id: number;
  readonly job_id: number;
  readonly run_api_path: string;
  readonly job_url: string;
}

function checkLink(identity: ProviderIdentityData, link: string, reader: ProviderReader): RequiredCheckLink {
  let url: URL;
  try { url = new URL(link); } catch { reader.fail('provider_data_incomplete', 'required Actions check URL unavailable'); }
  const segments = url.pathname.split('/').filter(Boolean);
  const [owner, repo] = identity.repo_name_with_owner.split('/');
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || segments.length !== 7
    || segments[0] !== owner || segments[1] !== repo || segments[2] !== 'actions'
    || segments[3] !== 'runs' || segments[5] !== 'job' || !/^\d+$/.test(segments[4]!) || !/^\d+$/.test(segments[6]!)) {
    reader.fail('provider_data_incomplete', 'required check is not a repository Actions check');
  }
  return Object.freeze({
    run_id: Number(segments[4]),
    job_id: Number(segments[6]),
    run_api_path: `repos/${identity.repo_name_with_owner}/actions/runs/${segments[4]}`,
    job_url: link,
  });
}

interface RequiredCheckRunFacts {
  readonly path: string;
  readonly head_sha: string;
  readonly run_attempt: number;
  readonly workflow_id: number | null;
}

function requiredCheckRunFacts(
  identity: ProviderIdentityData,
  value: unknown,
  label: string,
  reader: ProviderReader,
): RequiredCheckRunFacts {
  const run = reader.object(value, label);
  if (typeof run.path !== 'string' || run.path.trim() === '' || typeof run.event !== 'string'
    || run.head_sha !== identity.head_sha
    || !Array.isArray(run.pull_requests) || !run.pull_requests.some(pr => pr?.number === identity.pr_number
      && pr.head?.sha === identity.head_sha && pr.base?.sha === identity.base_sha)) {
    reader.fail('provider_data_incomplete', `${label} does not bind this PR/head/base`);
  }
  const attempt = run.run_attempt === undefined ? 1 : run.run_attempt;
  if (!Number.isSafeInteger(attempt) || Number(attempt) < 1) {
    reader.fail('provider_data_incomplete', `${label} attempt is invalid`);
  }
  return Object.freeze({
    path: run.path,
    head_sha: run.head_sha,
    run_attempt: Number(attempt),
    workflow_id: Number.isSafeInteger(run.workflow_id) && Number(run.workflow_id) > 0 ? Number(run.workflow_id) : null,
  });
}

type AttemptConclusion = 'success' | 'failure' | 'timed_out' | 'cancelled' | 'skipped' | 'unknown';

function attemptConclusion(value: unknown): AttemptConclusion {
  return ['success', 'failure', 'timed_out', 'cancelled', 'skipped'].includes(String(value))
    ? value as AttemptConclusion : 'unknown';
}

interface AttemptJob {
  readonly id: number;
  readonly name: string;
  readonly conclusion: AttemptConclusion;
  readonly check_run_id: number | null;
  readonly steps: readonly { readonly name: string; readonly conclusion: AttemptConclusion }[];
}

function attemptJob(value: unknown, reader: ProviderReader): AttemptJob {
  const job = reader.object(value, 'required check attempt job');
  if (!Number.isSafeInteger(job.id) || Number(job.id) < 1 || typeof job.name !== 'string' || job.name.trim() === '') {
    reader.fail('provider_data_incomplete', 'required check attempt job identity is incomplete');
  }
  if (!Array.isArray(job.steps)) reader.fail('provider_data_incomplete', 'required check attempt steps are unavailable');
  const steps = job.steps.map(entry => {
    const step = reader.object(entry, 'required check attempt step');
    return Object.freeze({
      name: reader.string(step.name, 'required check attempt step name'),
      conclusion: attemptConclusion(step.conclusion),
    });
  });
  const checkRun = typeof job.check_run_url === 'string'
    ? /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/check-runs\/(\d+)$/u.exec(job.check_run_url)
    : null;
  return Object.freeze({
    id: Number(job.id),
    name: job.name,
    conclusion: attemptConclusion(job.conclusion),
    check_run_id: checkRun ? Number(checkRun[1]) : null,
    steps: Object.freeze(steps),
  });
}

function attemptJobs(value: unknown, reader: ProviderReader): AttemptJob[] {
  const page = reader.object(value, 'required check attempt jobs');
  if (!Array.isArray(page.jobs) || !Number.isSafeInteger(page.total_count) || Number(page.total_count) < 1
    || Number(page.total_count) >= 100) {
    reader.fail('provider_data_incomplete', 'required check attempt jobs were not exhaustively observed');
  }
  const jobs = page.jobs.map(entry => attemptJob(entry, reader));
  if (jobs.length !== page.total_count) {
    reader.fail('provider_data_incomplete', 'required check attempt jobs were not exhaustively observed');
  }
  return jobs;
}

interface AnnotationEvidence {
  readonly excerpt: string | null;
  readonly tests: readonly string[];
}

/** A test reporter names the failed child in the annotation title or first message line. */
const TEST_IDENTIFIER = /(?:[^\s]+\.(?:test|spec)\.[cm]?[jt]sx?(?::\d+)?|\S+\s+>\s+\S+)/u;

function annotationEvidence(value: unknown, reader: ProviderReader): AnnotationEvidence {
  if (!Array.isArray(value)) return Object.freeze({ excerpt: null, tests: Object.freeze([]) });
  const messages: string[] = [];
  const tests: string[] = [];
  for (const entry of value) {
    const annotation = reader.object(entry, 'job annotation');
    if (typeof annotation.title === 'string') {
      const title = annotation.title.trim();
      if (title !== '' && TEST_IDENTIFIER.test(title)) tests.push(title);
    }
    if (typeof annotation.message !== 'string') continue;
    const message = annotation.message.trim();
    if (message === '') continue;
    messages.push(message);
    const firstLine = message.split(/\r?\n/u)[0]!.trim();
    if (TEST_IDENTIFIER.test(firstLine)) tests.push(firstLine);
  }
  const joined = messages.slice(0, 3).join('\n');
  return Object.freeze({
    excerpt: joined === '' ? null : joined.length > 4_000 ? `${joined.slice(0, 4_000)}…` : joined,
    tests: Object.freeze([...new Set(tests)]),
  });
}

const FAILED_ATTEMPT_CONCLUSIONS: ReadonlySet<AttemptConclusion> = new Set(['failure', 'timed_out', 'cancelled']);

function jobFailed(job: AttemptJob): boolean {
  return FAILED_ATTEMPT_CONCLUSIONS.has(job.conclusion) || job.steps.some(step => FAILED_ATTEMPT_CONCLUSIONS.has(step.conclusion));
}

const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u;

/** The workflow file content at the run revision; null when it is unavailable or unreadable. */
function workflowDefinitionText(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const file = value as Record<string, unknown>;
  if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') return null;
  try {
    const text = Buffer.from(file.content.replace(/\s/gu, ''), 'base64').toString('utf8');
    return text.trim() === '' ? null : text;
  } catch {
    return null;
  }
}

function attemptObservation(
  job: AttemptJob,
  attempt: number,
  runUrl: string,
  link: RequiredCheckLink,
  annotation: AnnotationEvidence | undefined,
): RequiredCheckAttemptObservationV1 {
  const skipped = job.steps.filter(step => step.conclusion === 'skipped').map(step => step.name);
  const executed = [job.name, ...job.steps.filter(step => step.conclusion !== 'skipped').map(step => step.name)];
  return Object.freeze({
    run_id: link.run_id,
    attempt,
    job_id: job.id,
    job_name: job.name,
    run_url: runUrl,
    job_url: job.id === link.job_id ? link.job_url : `${runUrl}/job/${job.id}`,
    conclusion: job.conclusion,
    steps: Object.freeze(job.steps.filter(step => FAILED_ATTEMPT_CONCLUSIONS.has(step.conclusion)).map(step => step.name)),
    failed_tests: annotation?.tests ?? Object.freeze([]),
    logs_available: false,
    failure_excerpt: annotation?.excerpt ?? null,
    platform_evidence: Object.freeze([]),
    scope: Object.freeze({ executed: Object.freeze(executed), skipped: Object.freeze(skipped) }),
    test_execution: null,
  });
}

/**
 * Reads the attempt history of one required check. A rerun keeps one run id
 * and increments the attempt; this collector follows that link. The linked job
 * is the check itself. When other jobs failed in the same attempt, the
 * collector reads the workflow revision's declared needs and preserves the
 * proven failed children. Without proof the association stays unknown and the
 * summary job keeps the reported failure point.
 */
function* checkEvidence(
  identity: ProviderIdentityData,
  check: ProviderCheck,
  run: RequiredCheckRunFacts,
  link: RequiredCheckLink,
  reader: ProviderReader,
): Generator<ProviderRequest, RequiredCheckFailureEvidenceV1 | null, unknown> {
  // A first-attempt green or pending check has no failure history to record.
  if (run.run_attempt === 1 && (check.bucket === 'pass' || check.bucket === 'pending')) return null;
  const pages: AttemptJob[][] = [];
  for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
    pages.push(attemptJobs(yield { args: ['api', `${link.run_api_path}/attempts/${attempt}/jobs?per_page=100`] }, reader));
  }
  const linked = pages.flat().find(job => job.id === link.job_id);
  if (!linked) reader.fail('provider_data_incomplete', 'required check job link does not resolve');
  const linkedJobs = pages.map((page, index) => page.find(job => job.name === linked.name)
    ?? (index + 1 === run.run_attempt ? linked : undefined));
  if (linkedJobs.some(job => job === undefined)) {
    reader.fail('provider_data_incomplete', 'required check rerun did not preserve the failed job');
  }
  const attemptsJobs = linkedJobs as AttemptJob[];
  const checkFailed = attemptsJobs.some(jobFailed);
  const succeededEveryAttempt = !checkFailed && attemptsJobs.every(job => job.conclusion === 'success');
  const otherFailed = pages.flatMap((page, index) =>
    page.filter(job => job.id !== attemptsJobs[index]!.id && FAILED_ATTEMPT_CONCLUSIONS.has(job.conclusion)));

  let association: 'direct' | 'declared_needs' | 'unknown' = 'direct';
  const childAssociations = new Map<string, 'declared_needs' | 'unknown'>();
  if (otherFailed.length > 0) {
    const contentsPath = WORKFLOW_PATH.test(run.path) ? run.path : null;
    const definitions: (string | null)[] = [];
    for (const ref of contentsPath === null ? [] : [run.head_sha, identity.base_sha]) {
      definitions.push(workflowDefinitionText(yield {
        args: ['api', `repos/${identity.repo_name_with_owner}/contents/${contentsPath}?ref=${ref}`],
        optional: true,
      }));
    }
    // A pull_request run takes its jobs from the merge commit; the head copy
    // is that graph only when the base copy is the same text.
    const [head, base] = definitions;
    const graph = head == null || head !== base ? null : parseWorkflowGraph(head);
    const placement = graph === null ? null
      : placeFailedJobs(graph, linked.name, otherFailed.map(job => job.name));
    // Old failures are not evidence for this check only when it succeeded in
    // every attempt and each failed job resolves outside its full needs graph.
    if (placement !== null && [...placement.failed.values()].every(where => where === 'outside')
      && succeededEveryAttempt) return null;
    const needed = otherFailed.filter(job => placement?.failed.get(job.name) === 'needed');
    if (needed.length > 0) {
      association = 'declared_needs';
      for (const job of needed) childAssociations.set(job.name, 'declared_needs');
    } else if (!(placement?.direct && checkFailed)) {
      // A check with no needs stays direct only when one of its own attempts failed.
      association = 'unknown';
      for (const job of otherFailed) childAssociations.set(job.name, 'unknown');
    }
  }

  // Annotations are read once per failed job identity, never invented.
  const annotationJobs = new Map<number, AttemptJob>();
  const noteAnnotations = (job: AttemptJob | undefined): void => {
    if (job === undefined || !FAILED_ATTEMPT_CONCLUSIONS.has(job.conclusion) || job.check_run_id === null) return;
    annotationJobs.set(job.id, job);
  };
  for (const job of attemptsJobs) noteAnnotations(job);
  for (const name of childAssociations.keys()) {
    for (const page of pages) noteAnnotations(page.find(job => job.name === name));
  }
  const annotations = new Map<number, AnnotationEvidence>();
  for (const job of annotationJobs.values()) {
    annotations.set(job.id, annotationEvidence(yield {
      args: ['api', `repos/${identity.repo_name_with_owner}/check-runs/${job.check_run_id}/annotations?per_page=100`],
      optional: true,
    }, reader));
  }

  const runUrl = `https://github.com/${identity.repo_name_with_owner}/actions/runs/${link.run_id}`;
  const attempts = attemptsJobs.map((job, index) => attemptObservation(
    job, index + 1, runUrl, link, annotations.get(job.id),
  ));
  const children: RequiredCheckChildObservationV1[] = [...childAssociations.entries()].map(([name, childAssociation]) => ({
    job_name: name,
    association: childAssociation,
    attempts: pages.flatMap((page, index) => {
      const job = page.find(entry => entry.name === name);
      return job === undefined ? [] : [attemptObservation(job, index + 1, runUrl, link, annotations.get(job.id))];
    }),
  }));
  // Without failure evidence of its own or of a declared need, a check that is
  // not green now stays blocked by its bucket; a green check with an attempt
  // that did not succeed reaches the fail-closed assessment.
  if (!checkFailed && association !== 'declared_needs'
    && (check.bucket !== 'pass' || (children.length === 0 && succeededEveryAttempt))) return null;
  if (attemptsJobs.length > 1 && attemptsJobs[attemptsJobs.length - 1]!.conclusion === 'success') {
    const latestTestExecution = (yield { test_execution: {
      repository: identity.repo_name_with_owner,
      run_id: link.run_id,
      attempt: run.run_attempt,
    } }) as RequiredCheckTestExecutionV1;
    const last = attempts[attempts.length - 1]!;
    attempts[attempts.length - 1] = Object.freeze({ ...last, test_execution: latestTestExecution });
  }
  return assessRequiredCheckFailure({
    check_name: check.name,
    head_sha: identity.head_sha,
    base_sha: identity.base_sha,
    merge_tree_sha: null,
    workflow: Object.freeze({ path: run.path, id: run.workflow_id, revision: run.head_sha }),
    attempts: Object.freeze(attempts),
    association,
    children: Object.freeze(children),
    declared_cause: null,
  });
}

/** Read protocol for required-check failures; `reader.driveRequests` answers its requests. */
function* requiredCheckFailures(
  identity: ProviderIdentityData,
  checks: readonly ProviderCheck[],
  reader: ProviderReader,
): Generator<ProviderRequest, RequiredCheckFailureEvidenceV1[], unknown> {
  const evidence: RequiredCheckFailureEvidenceV1[] = [];
  const runs = new Map<string, RequiredCheckRunFacts>();
  for (const check of checks) {
    if (check.workflow === '' && !/^https?:\/\/github\.com\/[^/]+\/[^/]+\/actions\//u.test(check.link)) continue;
    const link = checkLink(identity, check.link, reader);
    let run = runs.get(link.run_api_path);
    if (run === undefined) {
      run = requiredCheckRunFacts(identity, yield { args: ['api', link.run_api_path] }, 'required check run', reader);
      runs.set(link.run_api_path, run);
    }
    const failure = yield* checkEvidence(identity, check, run, link, reader);
    if (failure) evidence.push(failure);
  }
  return evidence;
}

export function collectRequiredCheckFailures(
  identity: ProviderIdentityData,
  checks: readonly ProviderCheck[],
  reader: ProviderReader,
): RequiredCheckFailureEvidenceV1[] {
  return reader.driveRequests(requiredCheckFailures(identity, checks, reader));
}
