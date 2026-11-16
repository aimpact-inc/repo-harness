import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Prefixed } from "../../core/evidence/sha256";

/** The owner marker that the Herdr skill step writes beside SKILL.md. */
export const HERDR_SKILL_MARKER = ".repo-harness-owner.json";

/** True when the marker names repo-harness, its hash matches SKILL.md, and the directory holds only those two files. */
export function ownedSkillIsIntact(directory: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(directory, HERDR_SKILL_MARKER), "utf8"));
    return marker.owner === "repo-harness"
      && marker.sha256 === sha256Prefixed(readFileSync(join(directory, "SKILL.md"), "utf8"))
      && readdirSync(directory).sort().join(",") === `${HERDR_SKILL_MARKER},SKILL.md`;
  } catch {
    return false;
  }
}
