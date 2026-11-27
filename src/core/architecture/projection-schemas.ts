import {
  jsonSchemaResolver,
  nativeContextSchemaResolver,
  validateJsonSchema,
  type Json,
} from 'archctx-contracts';
import projectionResultSchema from 'archctx-contracts/schemas/runtime/projection-result.schema.json';
import docsAnchorsSchema from 'archctx-contracts/schemas/runtime/docs-anchors.schema.json';
import architectureDebtSchema from 'archctx-contracts/schemas/runtime/architecture-debt.schema.json';
import architectureDebtDeltaSchema from 'archctx-contracts/schemas/runtime/architecture-debt-delta.schema.json';
import flowSelectorCheckSchema from 'archctx-contracts/schemas/runtime/flow-selector-check.schema.json';
import dependencyConstraintEvaluationSchema from 'archctx-contracts/schemas/runtime/dependency-constraint-evaluation.schema.json';
import refImpactSchema from 'archctx-contracts/schemas/runtime/ref-impact.schema.json';
import refImpactBatchSchema from 'archctx-contracts/schemas/runtime/ref-impact-batch.schema.json';
import runtimeVerifySchema from 'archctx-contracts/schemas/runtime/runtime-verify.schema.json';
import projectionSliceSchema from 'archctx-contracts/schemas/runtime/projection-slice.schema.json';
import stateMachineCheckSchema from 'archctx-contracts/schemas/runtime/state-machine-check.schema.json';
import projectionPrVerificationSchema from 'archctx-contracts/schemas/runtime/projection-pr-verification.schema.json';
import nativeContextExportSchema from 'archctx-contracts/schemas/runtime/native-context-export.schema.json';
import indexSeedSchema from 'archctx-contracts/schemas/runtime/index-seed.schema.json';
import nodeSchema from 'archctx-contracts/schemas/repo/architecture-node.schema.json';
import relationSchema from 'archctx-contracts/schemas/repo/architecture-relation.schema.json';
import flowSchema from 'archctx-contracts/schemas/repo/architecture-flow.schema.json';

export type JsonRecord = Record<string, unknown>;
type JsonSchema = Parameters<typeof validateJsonSchema>[0];

// Resolve published references offline, including in the bundled CLI.
const resolveSchema = jsonSchemaResolver([
  architectureDebtSchema, dependencyConstraintEvaluationSchema, docsAnchorsSchema,
  flowSelectorCheckSchema, projectionPrVerificationSchema, refImpactSchema, stateMachineCheckSchema,
] as Parameters<typeof jsonSchemaResolver>[0]);

const resolveNativeContextSchema = nativeContextSchemaResolver({
  node: nodeSchema as JsonSchema,
  relation: relationSchema as JsonSchema,
  flow: flowSchema as JsonSchema,
});

export const ARCHCTX_SCHEMAS = {
  projectionResult: projectionResultSchema,
  docsAnchors: docsAnchorsSchema,
  architectureDebt: architectureDebtSchema,
  architectureDebtDelta: architectureDebtDeltaSchema,
  flowSelectorCheck: flowSelectorCheckSchema,
  dependencyConstraintEvaluation: dependencyConstraintEvaluationSchema,
  refImpact: refImpactSchema,
  refImpactBatch: refImpactBatchSchema,
  runtimeVerify: runtimeVerifySchema,
  projectionSlice: projectionSliceSchema,
  indexSeed: indexSeedSchema,
} as const;

export function decodeArchctxSchema<T = JsonRecord>(schema: unknown, value: unknown, label: string): T {
  const validation = validateJsonSchema(schema as JsonSchema, value as Json, { resolveSchema });
  if (!validation.valid) {
    throw new Error(`${label} invalid: ${validation.issues.slice(0, 5).map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
  }
  // SAFETY: The published schema above validates the report type selected by the caller.
  return value as T;
}

export function validateNativeContextPayload(value: unknown): void {
  // SAFETY: Published archctx-contracts JSON Schema matches validateJsonSchema's schema shape at runtime.
  const validation = validateJsonSchema(nativeContextExportSchema as unknown as JsonSchema, value as Json, {
    resolveSchema: resolveNativeContextSchema,
  });
  if (!validation.valid) {
    throw new Error(validation.issues.slice(0, 5).map((issue) => `${issue.path} ${issue.message}`).join('; '));
  }
}

export function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}
