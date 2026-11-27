import type { ExecutableInstallation } from '@botiverse/oar/browser';
import type { antigravityRuntime } from '@botiverse/oar/runtimes/antigravity';
import { homedir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { catalogProbeModelIds, emptySeatPoolProbe, type SeatPoolProbe } from '../../core/board/seat-pool';
import { seatModelShapeValid, type AgyCatalogModel } from '../../core/board/seats-settings';
import { isRecord } from '../../core/evidence/is-record';

export const SEAT_POOL_MEMBER_MS = 15_000;
// Codex installation can run both a readiness and a version check. Leave time for OAR to close its processes.
export const SEAT_POOL_CHILD_MS = 120_000;
export const AGY_CATALOG_CHILD_MS = 60_000;
export const AGY_CATALOG_CHILD_ARG = '--agy-catalog';
export const CATALOG_RUNTIMES = ['claude', 'codex'] as const;

export type AgyProbe =
  | { readonly kind: 'available'; readonly installation: ExecutableInstallation; readonly models: readonly AgyCatalogModel[] }
  | { readonly kind: 'not_installed' | 'unsupported' | 'signed_out' | 'catalog_unknown' | 'unknown' };

export function agyProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { HOME: env.HOME ?? homedir(), USERPROFILE: env.USERPROFILE, LOCALAPPDATA: env.LOCALAPPDATA, PATH: env.PATH ?? '',
    TMPDIR: env.TMPDIR, OAR_ANTIGRAVITY_BIN: env.OAR_ANTIGRAVITY_BIN, OAR_CHILD_STDERR: 'ignore', NO_COLOR: '1', TERM: 'dumb' };
}

export function agyEnvironment(env: NodeJS.ProcessEnv): Record<string, string | null> {
  return { ...Object.fromEntries(Object.keys(process.env).map(key => [key, null])),
    ...Object.fromEntries(Object.entries(agyProbeEnv(env)).map(([key, value]) => [key, value ?? null])) };
}

export function isAgyCatalogModel(row: unknown): row is AgyCatalogModel {
  return isRecord(row) && seatModelShapeValid('agy', row.id)
    && (row.efforts === null || (Array.isArray(row.efforts) && row.efforts.every(effort => seatModelShapeValid('agy', effort))));
}

/** The launch probe in a worker thread, so a slow catalog does not stop the operator's other routes. */
export function readAgyCatalogOffThread(env: NodeJS.ProcessEnv): Promise<AgyProbe> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./agy-catalog-thread.ts', import.meta.url), { workerData: { env: { ...env } } });
    worker.once('message', resolve);
    worker.once('error', () => resolve({ kind: 'unknown' }));
    worker.once('exit', () => resolve({ kind: 'unknown' }));
  });
}

export function projectAgyCatalog(catalog: Extract<Awaited<ReturnType<typeof antigravityRuntime.listModels>>, { readonly kind: 'ok' }>): Map<string, AgyCatalogModel> {
  const models = new Map<string, AgyCatalogModel>();
  for (const { id, disabled, effortLevels = [], effortUnavailableReason } of catalog.models) {
    if (disabled === undefined && seatModelShapeValid('agy', id)) {
      // A null menu: agy lists the model but could not report its efforts.
      models.set(id, { id, efforts: effortUnavailableReason === undefined ? effortLevels.filter(effort => seatModelShapeValid('agy', effort)) : null });
    }
  }
  // OAR's ACP catalog exposes base IDs plus effort menus. The interactive CLI also takes suffixed IDs.
  const nativeIds = new Set(catalog.models.map(model => model.id));
  for (const { id, efforts } of [...models.values()]) {
    for (const effort of efforts ?? []) {
      const variant = `${id}-${effort}`;
      if (!nativeIds.has(variant) && seatModelShapeValid('agy', variant)) models.set(variant, { id: variant, efforts: [effort] });
    }
  }
  return models;
}

export async function probeSeatCatalog(id: typeof CATALOG_RUNTIMES[number], command: string): Promise<SeatPoolProbe> {
  if (command === '') return emptySeatPoolProbe(id, 'not_installed');
  let probe = emptySeatPoolProbe(id, 'unknown');
  try {
    const runtime = id === 'claude' ? (await import('@botiverse/oar/runtimes/claude')).claudeRuntime
      : (await import('@botiverse/oar/runtimes/codex')).codexRuntime;
    const { installation, authStatus, listModels } = runtime;
    if (installation === undefined || authStatus === undefined || listModels === undefined) return probe;
    const env = { [id === 'claude' ? 'OAR_CLAUDE_BIN' : 'OAR_CODEX_BIN']: command };
    const installed = await installation({ env });
    if (installed.kind === 'not_found') return emptySeatPoolProbe(id, 'not_installed');
    if (installed.kind !== 'available') return probe;
    probe = { ...probe, installation: 'available', sign_in: 'unknown' };
    const { kind: signIn } = await authStatus(installed, { timeoutMs: SEAT_POOL_MEMBER_MS });
    if (signIn !== 'logged_in') return { ...probe, sign_in: signIn };
    probe = { ...probe, sign_in: 'logged_in', models: 'unknown' };
    const catalog = await listModels(installed, { cwd: process.cwd(), timeoutMs: SEAT_POOL_MEMBER_MS });
    if (catalog.kind === 'unauthenticated') return { ...probe, models: 'unauthenticated' };
    if (catalog.kind !== 'ok') return probe;
    const wanted = catalogProbeModelIds(id);
    return { ...probe, models: 'ok', listed: catalog.models.filter(model => wanted.has(model.id))
      .map(model => ({ id: model.id, disabled: model.disabled !== undefined })) };
  } catch {
    return probe;
  }
}
