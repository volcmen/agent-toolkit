#!/usr/bin/env bun
/**
 * Validation suite: manifests agree, the skill still states its load-bearing
 * policies, docs exist for every module, and the CLI's advertised commands are
 * actually implemented. Code correctness is covered by `bun test` + `tsc`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// One marketplace for the whole workspace lives one level up; this project owns
// only its plugin directory.
const WORKSPACE = join(ROOT, "..");
const PLUGIN = join(ROOT, "plugins", "agent-board");
const SKILL = join(PLUGIN, "skills", "agent-board");

const failures: string[] = [];

function require_(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function readJson(relative: string, base = ROOT): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(base, relative), "utf8")) as Record<string, unknown>;
  } catch (error) {
    failures.push(`${relative}: unreadable JSON: ${(error as Error).message}`);
    return {};
  }
}

function checkManifests(): void {
  const claude = readJson("plugins/agent-board/.claude-plugin/plugin.json");
  const codex = readJson("plugins/agent-board/.codex-plugin/plugin.json");
  require_(claude.name === "agent-board", "Claude plugin name must be agent-board");
  require_(codex.name === "agent-board", "Codex plugin name must be agent-board");
  require_(claude.version === codex.version, "plugin versions must match across agents");
  require_(codex.skills === "./skills/", "Codex manifest must point at ./skills/");

  const pkg = readJson("package.json");
  require_(pkg.version === claude.version, "package.json version must match the plugin manifests");
  const bins = pkg.bin as Record<string, unknown> | undefined;
  require_(
    bins?.ab === "./bin/ab.ts" && bins?.["agent-board"] === "./bin/ab.ts",
    "package.json must expose both the short ab alias and unambiguous agent-board binary",
  );
  require_(
    typeof pkg.packageManager === "string" && (pkg.packageManager as string).startsWith("bun@"),
    "packageManager must pin bun",
  );
  const deps = pkg.dependencies as Record<string, string> | undefined;
  require_(deps === undefined || Object.keys(deps).length === 0, "runtime dependencies must stay empty (DDR-0005)");

  for (const [label, relative] of [
    ["Claude", ".claude-plugin/marketplace.json"],
    ["Codex", ".agents/plugins/marketplace.json"],
  ] as const) {
    const marketplace = readJson(relative, WORKSPACE);
    const plugins = marketplace.plugins as { name?: string; source?: string; version?: string }[] | undefined;
    require_(Array.isArray(plugins) && (plugins?.length ?? 0) > 0, `${label} marketplace lists no plugins`);
    const entry = plugins?.find((candidate) => candidate.name === "agent-board");
    require_(entry !== undefined, `${label} marketplace omits agent-board`);
    require_(
      entry?.source === "./agent-board/plugins/agent-board",
      `${label} marketplace points agent-board at ${entry?.source}`,
    );
    require_(entry?.version === claude.version, `${label} marketplace version drift`);
    require_(
      existsSync(join(WORKSPACE, String(entry?.source ?? "").replace(/^\.\//, ""))),
      `${label} marketplace source missing: ${entry?.source}`,
    );
  }
}

function checkSkill(): void {
  const path = join(SKILL, "SKILL.md");
  if (!existsSync(path)) {
    failures.push("SKILL.md missing");
    return;
  }
  const text = readFileSync(path, "utf8");
  require_(text.startsWith("---\n"), "SKILL.md must open with frontmatter");
  const front = text.slice(4, text.indexOf("\n---\n", 4));
  const body = text.slice(text.indexOf("\n---\n", 4) + 5);
  require_(front.includes("name: agent-board"), "SKILL.md name must be agent-board");
  const description = front.split("\n").find((line) => line.startsWith("description:")) ?? "";
  require_(description.length > 150, "SKILL.md description too thin to trigger reliably");
  require_(description.length < 1200, "SKILL.md description over the practical budget");

  // Policies that must survive future edits.
  for (const control of [
    "ab doctor",
    "ab triage",
    "ab dispatch",
    "ab attach",
    "ab plan",
    "ab serve",
    "maxTurns",
    "read-only",
    "BLOCKED",
    "reviewer",
  ]) {
    require_(body.includes(control), `SKILL.md no longer mentions: ${control}`);
  }
  for (const reference of ["references/cli.md", "references/routing.md"]) {
    require_(existsSync(join(SKILL, reference)), `missing ${reference}`);
    require_(body.includes(reference), `SKILL.md never points at ${reference}`);
  }
}

function checkRoutingCoverage(): void {
  const routing = readFileSync(join(SKILL, "references", "routing.md"), "utf8");
  const seeded = readFileSync(join(ROOT, "src", "roles.ts"), "utf8");
  const names = [...seeded.matchAll(/^\s{4}name: "([a-z]+)",$/gm)].map((match) => match[1] as string);
  require_(names.length >= 10, `expected the full seeded roster, found ${names.length}`);
  for (const name of names) {
    require_(routing.includes(`\`${name}\``), `routing reference omits role: ${name}`);
  }
}

function checkCliSurface(): void {
  const cli = readFileSync(join(ROOT, "bin", "ab.ts"), "utf8");
  const implemented = new Set([...cli.matchAll(/case "([a-z-]+)":/g)].map((match) => match[1] as string));
  const documented = new Set(
    [...readFileSync(join(SKILL, "references", "cli.md"), "utf8").matchAll(/^ab ([a-z-]+)/gm)].map(
      (match) => match[1] as string,
    ),
  );
  for (const command of documented) {
    require_(implemented.has(command), `cli.md documents \`ab ${command}\` which is not implemented`);
  }
  for (const command of ["init", "add", "ls", "show", "triage", "dispatch", "daemon", "attach", "plan", "serve", "stats", "doctor"]) {
    require_(implemented.has(command), `CLI is missing the ${command} command`);
  }
}

function checkDocs(): void {
  const architecture = join(ROOT, "docs", "ARCHITECTURE.md");
  require_(existsSync(architecture), "docs/ARCHITECTURE.md missing");
  const text = existsSync(architecture) ? readFileSync(architecture, "utf8") : "";
  for (const name of readdirSync(join(ROOT, "src"))) {
    if (!name.endsWith(".ts")) continue;
    require_(text.includes(`src/${name}`), `ARCHITECTURE.md does not describe src/${name}`);
  }
  const decisions = readdirSync(join(ROOT, "docs", "decisions")).filter((n) => n.endsWith(".md"));
  require_(decisions.length >= 5, "expected at least 5 decision records");
  for (const decision of decisions) {
    const body = readFileSync(join(ROOT, "docs", "decisions", decision), "utf8");
    require_(body.includes("## Decision"), `${decision} has no Decision section`);
    require_(body.includes("## Consequences"), `${decision} has no Consequences section`);
  }
}

const CHECKS: [string, () => void][] = [
  ["manifests", checkManifests],
  ["skill", checkSkill],
  ["routing coverage", checkRoutingCoverage],
  ["cli surface", checkCliSurface],
  ["docs", checkDocs],
];

for (const [label, check] of CHECKS) {
  const before = failures.length;
  check();
  console.log(failures.length === before ? `ok   ${label}` : `FAIL ${label}`);
}
for (const failure of failures) console.log(`  - ${failure}`);
if (failures.length) console.log(`\n${failures.length} problem(s)`);
process.exit(failures.length ? 1 : 0);
