import { lstatSync, realpathSync, mkdirSync, existsSync, readFileSync, openSync, closeSync, constants, fstatSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, sep, join, dirname, basename } from 'node:path';
import { piAgentDir } from '../pi-agent-dir';
import type { PiModelIdentity } from '../pi-host-probe';
import { shellQuote } from '../../core/shell-quote';
import type { ReviewIsolationAdmission, ReviewIsolationPaths } from '../../core/review/runner-port';


/**
 * The local magpie endpoint (#2764). The review sandbox holds no real credential: each sandboxed
 * model call goes to magpie on loopback with this placeholder key, and magpie holds the real one.
 */
export const MAGPIE_BASE_URL = 'http://127.0.0.1:3425/v1';
export const MAGPIE_PLACEHOLDER_KEY = 'magpie';
/** The model ports that a codex or pi review sandbox opens: magpie alone. */
export const MAGPIE_LOOPBACK_PORTS: readonly number[] = [Number(new URL(MAGPIE_BASE_URL).port)];
const MAGPIE_ROUTE = `route the review through magpie (${MAGPIE_BASE_URL}, apiKey ${JSON.stringify(MAGPIE_PLACEHOLDER_KEY)})`;

/** `model` is the canonical `provider/model` from pi's resolver; the review passes it to pi as `--model`. */
export interface PiAgentDirectory { readonly directory: string; readonly model: string }

const PLAIN_RECORD = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const POSITIVE_NUMBER = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const NAME = (value: unknown) => typeof value === 'string' && value !== '';
const PRIMITIVE_RECORD = (value: unknown) => PLAIN_RECORD(value) && Object.values(value).every(item => ['boolean', 'number', 'string'].includes(typeof item));
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PI_COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
/** The provider fields that pi needs for the magpie provider; baseUrl, apiKey and models have their own checks. */
const PI_PROVIDER_FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = { name: NAME, api: NAME, compat: PRIMITIVE_RECORD };
/** The model fields that pi needs for a magpie model; baseUrl has its own check. Each other field (headers, authHeader, ...) can carry a credential or a second route. */
const PI_MODEL_FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = {
  id: NAME,
  name: NAME,
  api: NAME,
  reasoning: value => typeof value === 'boolean',
  input: value => Array.isArray(value) && value.every(item => item === 'text' || item === 'image'),
  contextWindow: POSITIVE_NUMBER,
  maxTokens: POSITIVE_NUMBER,
  cost: value => PLAIN_RECORD(value) && Object.entries(value).every(([key, item]) => PI_COST_FIELDS.includes(key) && typeof item === 'number' && Number.isFinite(item) && item >= 0),
  compat: PRIMITIVE_RECORD,
  promptCache: PRIMITIVE_RECORD,
  thinkingLevelMap: value => PLAIN_RECORD(value) && Object.entries(value).every(([key, item]) => PI_THINKING_LEVELS.includes(key) && (typeof item === 'string' || item === null)),
};

/** Copies the allow-listed fields of `entry` that pass their check; `fixed` fields carry their own check. Any other field refuses by name. */
function allowListed(entry: Record<string, unknown>, fields: Readonly<Record<string, (value: unknown) => boolean>>, fixed: readonly string[],
  refuse: (reason: string) => Error, subject: string): Record<string, unknown> {
  const outside = Object.keys(entry).filter(key => !Object.hasOwn(fields, key) && !fixed.includes(key));
  if (outside.length > 0) throw refuse(`has the ${subject} fields ${outside.join(', ')} outside the allow-list`);
  const invalid = Object.keys(fields).filter(key => Object.hasOwn(entry, key) && !fields[key]!(entry[key]));
  if (invalid.length > 0) throw refuse(`has invalid ${subject} fields ${invalid.join(', ')}`);
  return Object.fromEntries(Object.keys(fields).filter(key => Object.hasOwn(entry, key)).map(key => [key, entry[key]]));
}

/** A baseUrl reaches the sandbox only as MAGPIE_BASE_URL; userinfo, a query or a fragment can carry a credential. */
function assertMagpieUrl(baseUrl: unknown, refuse: (reason: string) => Error, subject: string): void {
  if (typeof baseUrl !== 'string' || !URL.canParse(baseUrl)) throw refuse(`has no valid ${subject} baseUrl`);
  const url = new URL(baseUrl);
  if (url.username !== '' || url.password !== '') throw refuse(`has a ${subject} baseUrl with userinfo`);
  if (url.search !== '') throw refuse(`has a ${subject} baseUrl with a query`);
  if (url.hash !== '') throw refuse(`has a ${subject} baseUrl with a fragment`);
  if (baseUrl !== MAGPIE_BASE_URL) throw refuse(`has the ${subject} baseUrl ${baseUrl}, not ${MAGPIE_BASE_URL}`);
}

/**
 * The magpie provider entry, built field by field from allow-lists: baseUrl (exactly
 * MAGPIE_BASE_URL), apiKey (the placeholder), PI_PROVIDER_FIELDS, and only the selected model
 * (PI_MODEL_FIELDS; its baseUrl is absent or MAGPIE_BASE_URL). Each other field refuses the
 * session, never drops silently: a field outside the lists can carry a real credential into the
 * sandbox. pi matches a model id without case, so the selection does too; the resolver then
 * refuses a non-canonical name.
 */
function piMagpieProvider(bytes: Buffer, provider: string, model: string, modelsPath: string): Readonly<Record<string, unknown>> {
  let providers: unknown;
  try { providers = JSON.parse(bytes.toString('utf8'))?.providers; } catch { throw new Error('review_pi_models_invalid'); }
  const refuse = (reason: string) => new Error(`review_pi_provider_not_magpie: the review sandbox holds no real credential, and the ${provider} provider in ${modelsPath} ${reason}; ${MAGPIE_ROUTE}`);
  const entry = PLAIN_RECORD(providers) && Object.hasOwn(providers, provider) ? providers[provider] : undefined;
  if (!PLAIN_RECORD(entry)) throw refuse('does not exist');
  const projected = allowListed(entry, PI_PROVIDER_FIELDS, ['baseUrl', 'apiKey', 'models'], refuse, 'provider');
  if (entry.apiKey !== MAGPIE_PLACEHOLDER_KEY) throw refuse('has no placeholder apiKey');
  assertMagpieUrl(entry.baseUrl, refuse, 'provider');
  Object.assign(projected, { baseUrl: MAGPIE_BASE_URL, apiKey: MAGPIE_PLACEHOLDER_KEY });
  if (entry.models !== undefined) {
    if (!Array.isArray(entry.models)) throw refuse('has models that are not a list');
    const selected = entry.models.filter((item: unknown, index) => {
      if (!PLAIN_RECORD(item) || !NAME(item.id)) throw refuse(`has model ${index} without an id`);
      return (item.id as string).toLowerCase() === model.toLowerCase();
    }) as Record<string, unknown>[];
    projected.models = selected.map(item => {
      if (Object.hasOwn(item, 'baseUrl')) assertMagpieUrl(item.baseUrl, refuse, 'model');
      return { ...allowListed(item, PI_MODEL_FIELDS, ['baseUrl'], refuse, 'model'), ...(Object.hasOwn(item, 'baseUrl') ? { baseUrl: MAGPIE_BASE_URL } : {}) };
    });
  }
  return projected;
}

/**
 * Only the native model defaults are projected into private settings, and only the selected
 * provider's models.json entry is projected into a private models.json. Without an explicit model
 * pi falls through to the first provider with auth, so the native settings must name the provider
 * and model in the canonical form that pi's own resolver returns. The projected auth.json is an
 * empty map: the provider is the magpie provider with the placeholder key (piMagpieProvider).
 */
export function preparePiAgentDirectory(output: string, sourceHome: string,
  resolveModel: (agentDirectory: string, reference: string) => PiModelIdentity,
  env: Readonly<Record<string, string | undefined>> = process.env): PiAgentDirectory {
  const directory = join(ownedOutput(output), '.pi-agent');
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o777) !== 0o700) throw new Error('review_pi_agent_directory_unsafe');
  const source = piAgentDir(realpathSync(sourceHome), env);
  for (const path of [dirname(source), source]) {
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw new Error('review_pi_source_unsafe');
  }
  const settings = preparePiSettings(directory, source), settingsPath = join(source, 'settings.json');
  const provider = settings.defaultProvider, model = settings.defaultModel;
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    throw new Error(`review_pi_model_unnamed: set defaultProvider and defaultModel in ${settingsPath}`);
  }
  const models = join(source, 'models.json');
  if (!existsSync(models)) throw new Error(`review_pi_provider_not_magpie: ${models} does not exist; ${MAGPIE_ROUTE}`);
  const bytes = readNativeConfigBytes(models);
  let entry: ReturnType<typeof piMagpieProvider>;
  try { entry = piMagpieProvider(bytes, provider, model, models); } finally { bytes.fill(0); }
  writeOwnedProjection(join(directory, 'models.json'), JSON.stringify({ providers: { [provider]: entry } }) + '\n', 'review_pi_models_changed');
  // pi creates auth.json at its session start, and the profile denies each auth.json write, so the owner writes an empty map.
  writeOwnedProjection(join(directory, 'auth.json'), '{}\n', 'review_pi_auth_changed');
  let resolved: PiModelIdentity;
  try { resolved = resolveModel(directory, `${provider}/${model}`); } catch (error) {
    const message = (error as Error).message;
    if (!message.startsWith('review_pi_model_unresolved')) throw error;
    // The resolver child has no remote catalog: a model that only the remote catalog lists stays unresolved.
    throw new Error(`${message}; set defaultProvider and defaultModel in ${settingsPath} to a model that \`pi --list-models\` lists from models.json, then repeat the round`);
  }
  if (resolved.provider !== provider || resolved.model !== model) {
    throw new Error(`review_pi_model_not_canonical: pi resolves ${provider}/${model} to ${resolved.provider}/${resolved.model}; set defaultProvider and defaultModel in ${settingsPath} to that form`);
  }
  return { directory, model: `${provider}/${model}` };
}

/** Writes an owner projection once (0600, never through a link); a later round must find the same content. */
function writeOwnedProjection(destination: string, content: string, changed: string): void {
  if (!existsSync(destination)) writeFileSync(destination, content, { flag: 'wx', mode: 0o600 });
  const stat = lstatSync(destination);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
    || readFileSync(destination, 'utf8') !== content) throw new Error(changed);
}

function preparePiSettings(directory: string, source: string): Readonly<Record<string, unknown>> {
  const native = join(source, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(native)) {
    const bytes = readNativeConfigBytes(native);
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      settings = parsed as Record<string, unknown>;
    } catch { throw new Error('review_pi_settings_source_invalid'); }
    finally { bytes.fill(0); }
  }
  const projection = Object.fromEntries(['defaultProvider', 'defaultModel', 'defaultThinkingLevel']
    .filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]]));
  writeOwnedProjection(join(directory, 'settings.json'), JSON.stringify(projection) + '\n', 'review_pi_settings_changed');
  return projection;
}

/** Unlink only output-local configuration references. Never follow links. */
export function removePiCredentialReferences(output: string): { status: 'removed' | 'absent' | 'cleanup_pending' } {
  try {
    const directory = join(ownedOutput(output), '.pi-agent');
    let stat;
    try { stat = lstatSync(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) return { status: 'cleanup_pending' };
    let removed = false, pending = false;
    for (const name of ['models.json', 'settings.json', 'auth.json']) {
      try { unlinkSync(join(directory, name)); removed = true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') pending = true;
      }
    }
    return { status: pending ? 'cleanup_pending' : removed ? 'removed' : 'absent' };
  } catch { return { status: 'cleanup_pending' }; }
}

export function inside(path: string, directory: string): boolean {
  const rest = relative(directory, path);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
}

function ownedOutput(output: string): string {
  if (!isAbsolute(output) || lstatSync(output).isSymbolicLink() || !lstatSync(output).isDirectory()) throw new Error('review_output_unsafe');
  return realpathSync(output);
}
/** One bounded read of a native credential or configuration file (auth.json, models.json, settings.json); never follows a link. */
function readNativeConfigBytes(path: string): Buffer {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new Error('review_auth_source_unavailable'); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('review_auth_source_unsafe');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/**
 * The codex review home holds no auth.json (#2764): its config.toml sends each model call to
 * magpie with the placeholder key. `model` must be a magpie codex model (codex/*); a group/*
 * model can route to another model family.
 */
export function prepareCodexHome(output: string, model: string): { home: string } {
  if (!/^codex\/[A-Za-z0-9._-]+$/.test(model)) throw new Error(`review_codex_model_not_magpie: ${JSON.stringify(model)} is not a magpie codex/* model`);
  const home = join(ownedOutput(output), '.codex-home');
  try { mkdirSync(home, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('review_codex_home_create_failed'); }
  const dir = lstatSync(home);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o777) !== 0o700) throw new Error('review_codex_home_unsafe');
  if (existsSync(join(home, 'auth.json'))) throw new Error('review_codex_home_unsafe');
  // codex 0.169 accepts only the responses wire API for a custom provider.
  const config = `model = ${JSON.stringify(model)}\nmodel_provider = "magpie"\n\n[model_providers.magpie]\nname = "magpie"\nbase_url = ${JSON.stringify(MAGPIE_BASE_URL)}\nexperimental_bearer_token = ${JSON.stringify(MAGPIE_PLACEHOLDER_KEY)}\nwire_api = "responses"\n`;
  writeOwnedProjection(join(home, 'config.toml'), config, 'review_codex_config_changed');
  return { home };
}

/**
 * The native credential files and their locks, resolved as Seatbelt matches them: the pi auth.json
 * and models.json in both the default (~/.pi/agent) and the configured (PI_CODING_AGENT_DIR) agent
 * directory, and the codex auth.json. A native pi models.json can hold real keys of other providers.
 * Each original file and each original lock (`<file>.lock`) resolves on its own, because either can
 * be a link; the lock beside a linked file's target is also denied. The review profile denies each
 * path to every sandbox kind (#2764).
 */
export function nativeAuthFiles(sourceHome: string, env: Readonly<Record<string, string | undefined>> = process.env): readonly string[] {
  const home = realpathSync(sourceHome);
  const piDirectories = [join(home, '.pi', 'agent'), piAgentDir(home, env)];
  const files = [...piDirectories.flatMap(directory => ['auth.json', 'models.json'].map(name => join(directory, name))), join(home, '.codex', 'auth.json')];
  return [...new Set(files.flatMap(file => {
    const target = seatbeltPath(file);
    return [target, seatbeltPath(`${file}.lock`), seatbeltPath(`${target}.lock`)];
  }))];
}

/** The path that Seatbelt matches for `path`. A dangling link has no resolvable target, so it refuses. */
function seatbeltPath(path: string): string {
  let link = false;
  try { link = lstatSync(path).isSymbolicLink(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (link || existsSync(path)) {
    try { return realpathSync(path); } catch { throw new Error(`review_native_auth_unsafe: ${path} is a link without a target`); }
  }
  return existsSync(dirname(path)) ? join(realpathSync(dirname(path)), basename(path)) : path;
}

/**
 * The cleanup investigation (#1721) adds one rule to the review profile: the
 * agent cannot read the target worktrees and their Git directories, so it
 * judges only from the server manifest (M69). Other callers leave the field out.
 * The host derives the policy from these same paths, so the field travels in
 * the host spec.
 */
export type CleanupReviewIsolationPaths = ReviewIsolationPaths & { readonly cleanup?: { readonly readDenied: readonly string[] } };

/** Each native credential file and lock (nativeAuthFiles), denied to reads and writes. */
function nativeAuthPolicy(files: readonly string[]): string {
  // Seatbelt matches resolved paths, so each rule names a resolved path.
  if (files.some(path => !isAbsolute(path) || existsSync(path) && realpathSync(path) !== path)) throw new Error('review_native_auth_unsafe');
  return files.map(path => `(deny file-read* file-write* (literal ${JSON.stringify(path)}))\n`).join('');
}

/** Seatbelt owns enforcement. This emits OS policy, never vendor CLI arguments. */
export function reviewIsolationPolicy(paths: CleanupReviewIsolationPaths, platform = process.platform): string {
  if (!isAbsolute(paths.output) || lstatSync(paths.output).isSymbolicLink() || !lstatSync(paths.output).isDirectory()) {
    throw new Error('OAR_REVIEW_OUTPUT_UNSAFE');
  }
  const output = realpathSync(paths.output);
  let piPolicy = '';
  if (paths.piAgentDirectory !== undefined) {
    const directory = paths.piAgentDirectory;
    const stat = lstatSync(directory);
    if (directory !== join(output, '.pi-agent') || stat.isSymbolicLink() || !stat.isDirectory()
      || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('review_pi_agent_directory_unsafe');
    piPolicy = `(deny file-write* (literal ${JSON.stringify(join(directory, 'models.json'))}))\n`;
  }
  const readDenied = paths.cleanup?.readDenied ?? [];
  const protectedEntries = [paths.primary, paths.ownerRecord, paths.journal, paths.gitCommonDir, ...readDenied];
  for (const path of [paths.subject, ...protectedEntries]) {
    if (!isAbsolute(path)) throw new Error('OAR_REVIEW_PROTECTED_PATH_UNSAFE');
    const canonical = realpathSync(path);
    if (inside(canonical, output) || protectedEntries.includes(path) && inside(output, canonical)) {
      throw new Error('OAR_REVIEW_OUTPUT_OVERLAPS_AUTHORITY');
    }
  }
  // Seatbelt matches resolved paths, so a link would leave its target readable.
  if (readDenied.some(path => realpathSync(path) !== path)) throw new Error('OAR_REVIEW_PROTECTED_PATH_UNSAFE');
  // Every review agent is denied the operator console routes (#1770, M82).
  // Seatbelt "localhost" also matches this host's own addresses. A tcp "localhost"
  // rule lets ::ffff:127.0.0.1 through, so IPv6 TCP is denied whole; remote IPv4 stays open.
  const networkPolicy = '(deny network-outbound (remote tcp4 "localhost:*"))\n(deny network-outbound (remote tcp6 "*:*"))\n';
  // The last matching rule wins, so each allow follows the deny. A "localhost"
  // baseUrl can resolve to either family, so the allow names tcp, not tcp4.
  const modelPortPolicy = (paths.modelLoopbackPorts ?? []).map(port => `(allow network-outbound (remote tcp "localhost:${port}"))\n`).join('');
  const readPolicy = readDenied.map(path => `(deny file-read* (subpath ${JSON.stringify(path)}))\n`).join('');
  if (platform !== 'darwin') throw new Error('OAR_REVIEW_ISOLATION_UNSUPPORTED_PLATFORM');
  // Output alone is writable; every real CODEX_HOME state grant is retired.
  // Definitions, trust, settings/hooks and credentials stay denied even inside
  // an otherwise writable tree. Nothing in HOME or a native config root opens,
  // and each native credential file is also denied to reads (nativeAuthPolicy).
  const forbiddenFiles = '/(CLAUDE\\.md|AGENTS\\.md|settings[^/]*\\.json|\\.claude\\.json|config\\.toml|auth\\.json|\\.?credentials\\.json|secrets\\.json|token\\.json)$';
  const forbiddenDirectories = '/(\\.?hooks|\\.?agents|\\.?skills|\\.?rules|\\.?plugins)(/|$)';
  const exceptions = `(require-not (subpath ${JSON.stringify(output)}))`;
  // macOS resolves DNS through this system socket. Other local services remain denied.
  const unixSockets = '(require-all (remote unix-socket) (require-not (remote unix-socket (path-literal "/private/var/run/mDNSResponder"))))';
  return `(version 1)\n(allow default)\n(deny file-write* (require-all ${exceptions} (require-not (literal "/dev/null"))))\n(deny file-write* (regex #"${forbiddenFiles}"))\n(deny file-write* (regex #"${forbiddenDirectories}"))\n(deny signal)\n(deny network-outbound ${unixSockets})\n${piPolicy}${nativeAuthPolicy(paths.nativeAuth)}${networkPolicy}${modelPortPolicy}${readPolicy}`;

}

/** One private output-local TMPDIR; no HOME/config/credential redirection. */
export function reviewHostTemporaryDirectory(output: string): string {
  if (!isAbsolute(output) || lstatSync(output).isSymbolicLink() || !lstatSync(output).isDirectory()) throw new Error('OAR_REVIEW_OUTPUT_UNSAFE');
  const path = join(realpathSync(output), '.tmp');
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('OAR_REVIEW_TMPDIR_UNSAFE');
  return path;
}


/** The inherited variables that a review child keeps: process basics, locale and terminal. None carries a credential. */
const REVIEW_CHILD_VARIABLES = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ']);

/**
 * The review session env overlay for OAR (#2764): the sandbox overlay (CODEX_HOME or the pi agent
 * directory) plus a removal (null) of each other inherited variable. OAR builds the child env from
 * the host env and this overlay, so an ambient credential (OPENAI_API_KEY, GH_TOKEN, ...) never
 * reaches the sandboxed child. The host env itself does not change.
 */
export function reviewChildEnvironment(overlay: Readonly<Record<string, string | null>> = {},
  inherited: Readonly<Record<string, string | undefined>> = process.env): Readonly<Record<string, string | null>> {
  const removed = Object.keys(inherited).filter(key => !REVIEW_CHILD_VARIABLES.has(key) && !Object.hasOwn(overlay, key));
  return { ...Object.fromEntries(removed.map(key => [key, null])), ...overlay };
}

/** Require the owner-admitted profile and live inherited Seatbelt before SDK Session creation. */
export function assertReviewIsolation(admission: ReviewIsolationAdmission): void {
  const expected = reviewIsolationPolicy(admission.paths);
  const file = lstatSync(admission.policyFile);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || !(file.mode & 0o200)
    || readFileSync(admission.policyFile, 'utf8') !== expected) throw new Error('OAR_REVIEW_PROFILE_NOT_ADMITTED');
  // Open without truncation: never mutate the protected owner profile. Its
  // writable owner mode excludes a chmod-only false positive. Unconfined hosts
  // close this fd and fail before creating a Session.
  let fd: number;
  try { fd = openSync(admission.policyFile, constants.O_WRONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw new Error('OAR_REVIEW_PROFILE_DENIAL_UNPROVEN');
    const nested = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8', timeout: 5000 });
    if (nested.status !== 71 || !nested.stderr?.includes('sandbox_apply: Operation not permitted')) throw new Error('OAR_REVIEW_SEATBELT_UNPROVEN');
    return;
  }
  closeSync(fd);
  throw new Error('OAR_REVIEW_SEATBELT_REQUIRED');
}

/** Immutable executable seam: OAR owns every vendor argument and wire protocol. */
export function prepareReviewLauncher(directory: string, policyFile: string, executable: string): string {
  const policy = realpathSync(policyFile), vendor = realpathSync(executable), owner = realpathSync(directory);
  if (!isAbsolute(directory) || owner !== directory || !lstatSync(owner).isDirectory()
    || lstatSync(policyFile).isSymbolicLink() || !lstatSync(policy).isFile()
    || !lstatSync(vendor).isFile()) throw new Error('OAR_REVIEW_LAUNCHER_UNSAFE');
  const content = `#!/bin/sh\nexec /usr/bin/sandbox-exec -f ${shellQuote(policy)} ${shellQuote(vendor)} "$@"\n`;
  const launcher = join(owner, 'reviewer-launcher');
  if (!existsSync(launcher)) writeFileSync(launcher, content, { flag: 'wx', mode: 0o700 });
  const stat = lstatSync(launcher);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700
    || readFileSync(launcher, 'utf8') !== content) throw new Error('OAR_REVIEW_LAUNCHER_CHANGED');
  return launcher;
}

/** Trusted host alone writes control evidence; only OAR's child is sandboxed. */
export function reviewHostCommand(node: string, hostEntry: string, specFile: string): readonly string[] {
  for (const path of [node, hostEntry, specFile]) if (!isAbsolute(path)) throw new Error('OAR_REVIEW_HOST_PATH_UNSAFE');
  return [node, '--disable-sigusr1', hostEntry, specFile];
}
