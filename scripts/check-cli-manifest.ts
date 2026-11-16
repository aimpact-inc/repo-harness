#!/usr/bin/env bun
/**
 * Gate: every inline-code `rh ...` span in the tracked skills and root
 * documents names a command and options that the commander tree registers.
 * The tree comes from buildProgram(), so no second command list exists.
 */
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { Command } from "commander";
import { allowsUnknownOptions } from "../src/cli/commands/commands";
import { buildProgram } from "../src/cli/index";

const SCANNED = [
  /^assets\/skills\/.+\.md$/,
  /^assets\/skill-commands\/.+\.md$/,
  /^assets\/reference-configs\/.+\.md$/,
  /^references\/.+\.md$/,
  /^README[^/]*\.md$/,
  /^SKILL\.md$/,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
];
const PATH_END = /[<[|$…]/;

function findChild(command: Command, name: string): Command | undefined {
  return command.commands.find(child => child.name() === name || child.aliases().includes(name));
}

function declaresOption(chain: readonly Command[], name: string): boolean {
  if (name === "help" || name === "version") return true;
  return chain.some(command => command.options.some(option => option.long === `--${name}`));
}

/** Findings for one span (the text after the opening backtick), without file position. */
export function checkSpan(root: Command, span: string): string[] {
  const tokens = span.trim().split(/\s+/).slice(1);
  const chain: Command[] = [root];
  const pathTokens: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("-") || PATH_END.test(token)) break;
    const current = chain[chain.length - 1];
    const child = findChild(current, token);
    if (child) {
      chain.push(child);
      pathTokens.push(token);
      continue;
    }
    const hasSubcommands = current.commands.length > 0;
    if (hasSubcommands && current.registeredArguments.length === 0) {
      return [`unknown command "rh ${[...pathTokens, token].join(" ")}"`];
    }
    break;
  }
  if (chain.some(allowsUnknownOptions)) return [];
  const path = chain.slice(1).map(command => command.name()).join(" ");
  const findings: string[] = [];
  const seen = new Set<string>();
  for (const match of span.matchAll(/(?<![\w-])--([A-Za-z][\w-]*)/g)) {
    const name = match[1];
    if (seen.has(name) || declaresOption(chain, name)) continue;
    seen.add(name);
    findings.push(`unknown option "--${name}" for "rh${path === "" ? "" : ` ${path}`}"`);
  }
  return findings;
}

/** `file:line: finding` lines for one document. */
export function checkDocument(root: Command, file: string, text: string): string[] {
  const findings: string[] = [];
  let fenced = false;
  text.split("\n").forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      if (!/^rh\s/.test(match[1])) continue;
      for (const finding of checkSpan(root, match[1])) findings.push(`${file}:${index + 1}: ${finding}`);
    }
  });
  return findings;
}

function main(): void {
  const repoIndex = process.argv.indexOf("--repo");
  const repo = resolve(repoIndex === -1 ? "." : process.argv[repoIndex + 1] ?? ".");
  const tracked = execFileSync("git", ["-C", repo, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const root = buildProgram();
  const findings = tracked
    .filter(file => SCANNED.some(pattern => pattern.test(file)))
    .flatMap(file => checkDocument(root, file, readFileSync(resolve(repo, file), "utf8")));
  for (const finding of findings) console.log(finding);
  process.exit(findings.length > 0 ? 1 : 0);
}

if (import.meta.main) main();
