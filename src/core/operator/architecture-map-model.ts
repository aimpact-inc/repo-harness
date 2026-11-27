// The base contract of the architecture map (PRD G11, G22): schema, route,
// shared section and refusal primitives, nodes, relations, sizes, dependencies,
// and layer order. Flows live in `architecture-map-flows.ts`, overlay layers in
// `architecture-map-layers.ts`, and the strict decoder and map projection in
// `architecture-map.ts`; this leaf never imports them.

export const OPERATOR_ARCHITECTURE_MAP_SCHEMA = 'repo-harness.architecture-map.v7' as const;
export const OPERATOR_ARCHITECTURE_MAP_ROUTE = /^\/api\/v1\/repositories\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/architecture\/map$/u;

/**
 * Why a repository's map cannot be served. Each maps to one HTTP status in the route.
 * `model_unavailable`: the committed model read failed with no archctx error code
 * (an archctx refusal is an `ArchitectureMapUnavailableV1` with archctx's codes);
 * `architecture_map_failed`: the map process read the model, then failed;
 * `architecture_map_timeout`: the map process passed its deadline;
 * `architecture_map_process_failed`: the map process did not start or gave no result.
 */
export const ARCHITECTURE_MAP_UNAVAILABLE_REASONS = [
  'architecture_map_pending',
  'registry_unavailable',
  'repository_not_found',
  'model_unavailable',
  'architecture_map_invalid',
  'architecture_map_failed',
  'architecture_map_timeout',
  'architecture_map_process_failed',
] as const;
export type ArchitectureMapUnavailableReason = typeof ARCHITECTURE_MAP_UNAVAILABLE_REASONS[number];
/** The reasons that the map process itself reports; the collector refuses any other. */
export const ARCHITECTURE_MAP_WORKER_REASONS = ['repository_not_found', 'model_unavailable', 'architecture_map_failed'] as const;
export type ArchitectureMapWorkerReason = typeof ARCHITECTURE_MAP_WORKER_REASONS[number];
/** A repository without a map: a named reason, or archctx's refusal of the committed model read. */
export type ArchitectureMapUnavailableV1 =
  | { readonly state: 'unavailable'; readonly reason: ArchitectureMapUnavailableReason }
  | ArchctxRefusalV1;

/** Why line counts are missing while the model itself is served. */
export const ARCHITECTURE_MAP_SIZE_REASONS = ['model_worktree_dirty', 'checkout_changed', 'ownership_unavailable', 'git_read_failed'] as const;
export type ArchitectureMapSizeReason = typeof ARCHITECTURE_MAP_SIZE_REASONS[number];

/**
 * Why import counts are missing. The collector never builds a CodeGraph index.
 * The index covers the working tree, so it describes the commit only while the
 * whole tree is clean: `code_facts_worktree_dirty` otherwise.
 */
export const ARCHITECTURE_MAP_DEPENDENCY_REASONS = ['model_worktree_dirty', 'checkout_changed', 'code_facts_worktree_dirty', 'code_facts_unavailable', 'code_facts_incomplete', 'code_facts_other_commit', 'dependencies_unavailable'] as const;
export type ArchitectureMapDependencyReason = typeof ARCHITECTURE_MAP_DEPENDENCY_REASONS[number];

/** Why the map has no layer order: the model declares no ordered `model.layers`. */
export const ARCHITECTURE_LAYER_ORDER_REASONS = ['model_layers_undeclared'] as const;
export type ArchitectureLayerOrderReason = typeof ARCHITECTURE_LAYER_ORDER_REASONS[number];

export interface ArchitectureMapNodeV1 {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly status: string;
  /** The model's layer name. With a layer order, the map places the node in that layer's band. */
  readonly layer: string | null;
  readonly parent: string | null;
  readonly summary: string;
  /** The capability profile's domain from the same export; non-null exactly for a capability. */
  readonly domain: string | null;
  /** The model's `namespace`; non-null exactly for a namespace node. */
  readonly namespace: { readonly type: ArchitectureNamespaceType } | null;
  /** The model's `mount`; non-null exactly for a mount node. A source or target that the prose guard would change is null. */
  readonly mount: { readonly source: string | null; readonly target: string | null; readonly mode: 'ro' | 'rw'; readonly order: number } | null;
}
/** The namespace types of `archcontext.node/v2`. */
export const ARCHITECTURE_NAMESPACE_TYPES = ['host', 'container', 'pod', 'kubernetes', 'pid', 'mount', 'net', 'user'] as const;
export type ArchitectureNamespaceType = typeof ARCHITECTURE_NAMESPACE_TYPES[number];

export interface ArchitectureMapRelationV1 {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly target: string;
  readonly intent: string;
  /** The model's free-text `protocol`, masked like model prose. */
  readonly protocol: string | null;
}

/** A node's tracked text files and their lines, its own and its descendants'. A node that owns no file is absent. */
export interface ArchitectureMapSizeV1 { readonly id: string; readonly files: number; readonly lines: number }
/** Imports from one capability into another, from `archctx deps`. */
export interface ArchitectureMapImportV1 { readonly source: string; readonly target: string; readonly imports: number }

export type ArchitectureMapSizesV1 =
  | { readonly state: 'ok'; readonly nodes: readonly ArchitectureMapSizeV1[] }
  | { readonly state: 'unavailable'; readonly reason: ArchitectureMapSizeReason };
export type ArchitectureMapDependenciesV1 =
  | { readonly state: 'ok'; readonly edges: readonly ArchitectureMapImportV1[] }
  | { readonly state: 'unavailable'; readonly reason: ArchitectureMapDependencyReason };

export type Gap<Reason extends string> = { readonly state: 'unavailable'; readonly reason: Reason };
export type Section<Fields, Reason extends string> = ({ readonly state: 'ok' } & Fields) | Gap<Reason>;

/** The model's `model.layers` from `archctx export native`, top layer first. archctx checks that it declares every node layer. */
export type ArchitectureLayerOrderV1 = Section<{ readonly layers: readonly string[] }, ArchitectureLayerOrderReason>;

/**
 * An archctx error envelope. archctx owns its error and reason codes; the map
 * carries them as opaque tokens and checks only their shape.
 */
export interface ArchctxRefusalV1 {
  readonly state: 'unavailable';
  readonly reason: 'archctx_error';
  /** The archctx error code, for example `AC_SCHEMA_INVALID`. */
  readonly code: string;
  /** The archctx reason code, a kebab-case token; null when archctx gives none. */
  readonly reason_code: string | null;
}
export const ARCHCTX_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u;
export const ARCHCTX_TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** The refusal of an archctx error envelope; null when its codes do not have the archctx shape. */
export function archctxRefusal(code: unknown, reasonCode: unknown): ArchctxRefusalV1 | null {
  if (typeof code !== 'string' || !ARCHCTX_CODE.test(code)) return null;
  if (reasonCode !== undefined && reasonCode !== null && (typeof reasonCode !== 'string' || !ARCHCTX_TOKEN.test(reasonCode))) return null;
  return { state: 'unavailable', reason: 'archctx_error', code, reason_code: reasonCode ?? null };
}

/** The map route's refusal body: the typed operator error, and archctx's codes when its code is `archctx_error`. */
export interface ArchitectureMapRefusalV1 {
  readonly error: { readonly code: string; readonly message: string; readonly next_action: string };
  readonly archctx?: { readonly code: string; readonly reason_code: string | null };
}
