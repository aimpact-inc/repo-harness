// The architecture map flow wire contract (PRD G11, G22): flow definitions,
// flow step selectors, evidence, proof status, and selector/step helpers.
// The strict decoder and map projection stay in `architecture-map.ts`; this
// leaf never imports it.

/** The evidence of a flow step: archctx's selector key, an entrypoint symbol and a sink of one model node. */
export interface ArchitectureFlowSelectorV1 { readonly entrypoint: string; readonly source_symbol: string; readonly sink: string }
/** archctx's proof status for one selector that a flow step names, for example `proven` or `no-direct-call`. */
export interface ArchitectureFlowProofV1 extends ArchitectureFlowSelectorV1 {
  readonly status: string;
  readonly call_sites: readonly { readonly path: string; readonly line: number | null }[];
}
/** `archctx flows check --no-sync`: selector proof counts, each flow step selector's status, and the capabilities whose P2 flow proof archctx calls unprovable. */
export interface ArchitectureFlowProofsV1 {
  readonly selectors: number;
  readonly proven: number;
  readonly unproven: number;
  /** Unproven selectors that a required-flow step names. */
  readonly used_unproven: number;
  readonly unprovable: readonly { readonly id: string; readonly diagnostics: number }[];
  /** The selectors that the map's flow steps name, by archctx's selector key. */
  readonly evidence: readonly ArchitectureFlowProofV1[];
}

/** One message of a flow: participant ids, the model's label and the step's evidence selector. */
export interface ArchitectureMapFlowStepV1 {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly evidence: ArchitectureFlowSelectorV1;
}
export interface ArchitectureMapFlowOutcomeV1 {
  readonly id: string;
  readonly kind: 'success' | 'error';
  readonly label: string;
  readonly steps: readonly ArchitectureMapFlowStepV1[];
  readonly terminal: { readonly participant: string; readonly label: string };
}
/** One flow of the committed model (`archcontext.flow/v1`); free text is masked like model prose. */
export type ArchitectureMapFlowV1 = { readonly id: string; readonly capability: string; readonly name: string } & (
  | {
    readonly applicability: 'required';
    readonly participants: readonly { readonly id: string; readonly node: string }[];
    readonly steps: readonly ArchitectureMapFlowStepV1[];
    readonly outcomes: readonly ArchitectureMapFlowOutcomeV1[];
  }
  | { readonly applicability: 'not-applicable'; readonly rationale: string }
);
/**
 * The code that one model node declares for a flow step selector in its
 * `source.entrypoints`. A path is null when the public-path guard refuses it.
 */
export interface ArchitectureFlowEvidenceV1 extends ArchitectureFlowSelectorV1 {
  readonly node: string;
  readonly source_path: string | null;
  readonly sink_path: string | null;
  readonly sink_symbol: string;
}

/** archctx's selector key, as one string. */
export function flowSelectorKey(selector: ArchitectureFlowSelectorV1): string {
  return `${selector.entrypoint}\0${selector.source_symbol}\0${selector.sink}`;
}

/** Every step of a required flow, the outcome steps after the main steps; `outcome` is null for a main step. */
export function flowSteps(flow: ArchitectureMapFlowV1): { readonly outcome: string | null; readonly step: ArchitectureMapFlowStepV1 }[] {
  if (flow.applicability !== 'required') return [];
  return [...flow.steps.map(step => ({ outcome: null, step })), ...flow.outcomes.flatMap(outcome => outcome.steps.map(step => ({ outcome: outcome.id, step })))];
}
