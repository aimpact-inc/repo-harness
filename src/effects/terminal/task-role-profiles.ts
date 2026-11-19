import { MODEL_FAMILY_LABELS } from '../../core/board/seats-settings';

// Moved from the existing installer: one owner for logical persona parsing,
// declared writability and the user's configured model/effort projections.
export const MANAGED_AGENTS = ['explorer', 'deep-reasoner', 'harness-evaluator'];
export const WRITABLE_AGENTS: ReadonlySet<string> = new Set(['harness-evaluator']);
export interface ParsedRole { name: string | undefined; description: string | undefined; model: string | undefined; effort: string | undefined; body: string }
export type RoleValidation = {ok: true; sourceDescription: string} | {ok: false; kind?: string; reason: string};
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

export function parseRoleNameScalar(rawValue: unknown): string | undefined {
  if (typeof rawValue !== "string") return undefined;
  const match = rawValue.trim().match(/^(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))(?:\s+#.*)?$/);
  return match?.[1] || match?.[2] || match?.[3];
}

export function parseFrontmatter(raw: string): ParsedRole | null {
  const lines = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") return null;

  let closeIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      closeIndex = index;
      break;
    }
  }
  if (closeIndex === -1) return null;

  const frontmatterLines = lines.slice(1, closeIndex);
  const bodyLines = lines.slice(closeIndex + 1);
  while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();

  const fieldLines = frontmatterLines.filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  const firstField = fieldLines[0]?.match(/^( *)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
  if (!firstField) return null;
  const rootIndent = firstField[1]!.length;
  const fields: Record<string, string> = {};
  for (const line of fieldLines) {
    const match = line.match(/^( *)([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!match || match[1]!.length !== rootIndent) return null;
    if (Object.hasOwn(fields, match[2]!)) return null;
    fields[match[2]!] = match[3]!;
  }

  return {
    name: parseRoleNameScalar(fields.name),
    description: fields.description,
    model: fields.model,
    effort: fields.effort,
    body: bodyLines.join("\n"),
  };
}

export function validateFrontmatter(parsed: ParsedRole | null, expectedAgent: string): RoleValidation {
  if (!parsed) {
    return { ok: false, kind: "identity-invalid", reason: "missing or malformed frontmatter delimiters" };
  }
  if (parsed.name && parsed.name !== expectedAgent) {
    return {
      ok: false,
      kind: "identity-mismatch",
      reason: `frontmatter name does not match source role: ${parsed.name}/${expectedAgent}`,
    };
  }
  if (!parsed.name) {
    return { ok: false, kind: "identity-invalid", reason: "missing or malformed frontmatter name" };
  }
  if (!parsed.description || !parsed.model || !parsed.effort) {
    return { ok: false, reason: "missing required frontmatter field (name/description/model/effort)" };
  }
  const familyLabel = Object.hasOwn(MODEL_FAMILY_LABELS, parsed.model) ? MODEL_FAMILY_LABELS[parsed.model] : undefined;
  if (!familyLabel || !EFFORT_LEVELS.includes(parsed.effort)) {
    return { ok: false, reason: `unmapped model/effort combination: ${parsed.model}/${parsed.effort}` };
  }
  const sourceDescription = `${familyLabel} at ${parsed.effort} effort`;
  if (!parsed.description.includes(sourceDescription)) {
    return { ok: false, reason: `description missing expected model label: ${sourceDescription}` };
  }
  return { ok: true, sourceDescription };
}
