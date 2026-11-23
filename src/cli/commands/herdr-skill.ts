import { renderHerdrSkill } from "./herdr-skill-render.mjs";
import { sha256Prefixed } from "../../core/evidence/sha256";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { requireHome } from "../../effects/repo-harness-home";
import { join } from "node:path";
import { antigravitySkillRoot, hostSkillRoot, stagedSkillRoot, SKILL_HOSTS, type SkillHost } from "../../effects/host-skill-roots";
import { antigravitySkillsDirHostPath, checkAntigravityPath, openHostConfigGate } from "../../effects/host-config/gate";
import { hostPathReplacementRefused, withHostConfigTransaction } from "../installer/install-profile";
import type { InstallTargetSpec } from "./install";
import { hasRecordedAntigravityState } from "../installer/targets/antigravity";
import { HERDR_SKILL_MARKER as MARKER } from "../../effects/host-config/herdr-skill-marker";

const STEP = "configure required Herdr skill";
type Step = { step: string; status: "ok" | "failed"; detail: string };

/** Project the hc manual through the whole-path gate. */
export function configureRequiredHerdrSkill(
  target: InstallTargetSpec | "antigravity",
  env: NodeJS.ProcessEnv = process.env,
  transaction?: string,
  includePi = true,
): Step {
  let home: string;
  try { home = requireHome(env); }
  catch (error) { return { step: STEP, status: 'failed', detail: (error as Error).message }; }
  const result = spawnSync("hc", ["--skill"], { env, encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) {
    const why = result.error?.message ?? (result.stderr?.trim() || (result.signal ? 'signal ' + result.signal : 'exit ' + result.status));
    return { step: STEP, status: "failed", detail: 'hc --skill failed: ' + why };
  }
  try {
    const content = renderHerdrSkill(result.stdout);
    const hosts: readonly SkillHost[] = target === "both" ? SKILL_HOSTS.filter(host => includePi || host !== "pi")
      : target === "antigravity" ? [] : [target];
    const antigravity = target === "antigravity" || hasRecordedAntigravityState(env, false);
    withHostConfigTransaction(env, transaction, root => {
      if (antigravity) checkAntigravityPath(antigravitySkillsDirHostPath(env), "directory");
      const staged = mkdtempSync(join(root, 'herdr-'));
      try {
        writeFileSync(join(staged, 'SKILL.md'), content);
        writeFileSync(join(staged, MARKER), JSON.stringify({ owner: 'repo-harness', sha256: sha256Prefixed(content) }) + '\n');
        const roots = hosts.map(host => hostSkillRoot(home, host, env));
        if (antigravity) roots.push(antigravitySkillRoot(home));
        if (hosts.includes('codex') && lstatSync(join(stagedSkillRoot(home), 'herdr'), { throwIfNoEntry: false })) roots.push(stagedSkillRoot(home));
        openHostConfigGate({ env }).writePaths(roots.map(root => ({ path: join(root, 'herdr'), owner: root === hostSkillRoot(home, 'pi', env) ? 'pi' : 'core',
          entry: { type: 'directory', source: staged } })), { transaction: root });
      } finally { rmSync(staged, { recursive: true, force: true }); }
    });
    return { step: STEP, status: 'ok', detail: 'installed for ' + [...hosts, ...(antigravity ? ["antigravity"] : [])].join(', ') + '; ' + sha256Prefixed(content) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { step: STEP, status: 'failed', detail: hostPathReplacementRefused(error)
      ? `${detail}. To keep the skill, move it out of its skill directory. Then run \`rh update\` again.`
      : detail };
  }
}
