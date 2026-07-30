/**
 * Prompt library. Reusable prompt bodies live as markdown under
 * `board/prompts/<name>.md` with `{{variable}}` placeholders, so a card can be
 * created from a known-good prompt instead of retyping it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, serializeDocument } from "./frontmatter.ts";
import { PROMPTS_DIR } from "./config.ts";

export type Prompt = {
  name: string;
  description: string;
  role: string | null;
  body: string;
  variables: string[];
};

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function variablesIn(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((match) => match[1] as string))];
}

export function render(body: string, values: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      missing.push(name);
      return `{{${name}}}`;
    }
    return value;
  });
  return { text, missing: [...new Set(missing)] };
}

export function loadPrompts(root: string): Prompt[] {
  const dir = join(root, PROMPTS_DIR);
  if (!existsSync(dir)) return [];
  const prompts: Prompt[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const { data, body } = parseDocument(readFileSync(join(dir, file), "utf8"));
    prompts.push({
      name: typeof data.name === "string" ? data.name : file.replace(/\.md$/, ""),
      description: typeof data.description === "string" ? data.description : "",
      role: typeof data.role === "string" ? data.role : null,
      body: body.trim(),
      variables: variablesIn(body),
    });
  }
  return prompts.sort((a, b) => a.name.localeCompare(b.name));
}

export function findPrompt(root: string, name: string): Prompt | null {
  return loadPrompts(root).find((prompt) => prompt.name === name) ?? null;
}

const SEEDS: { name: string; description: string; role: string | null; body: string }[] = [
  {
    name: "bugfix",
    description: "Reproduce, fix, and prove a defect fix.",
    role: "backend",
    body: `**Goal** Fix: {{symptom}}

**Approach**
- Reproduce first: {{repro}}
- Find the root cause; do not patch the symptom.
- Fix the smallest surface, then re-run the reproduction.

**Acceptance criteria**
- [ ] A test that failed before the fix now passes (name it).
- [ ] {{verify_command}} exits 0, output quoted.
- [ ] No unrelated files touched.

**Out of scope** Refactoring adjacent code.`,
  },
  {
    name: "review",
    description: "Independent review of a diff/PR/MR against a snapshot.",
    role: "reviewer",
    body: `**Goal** Independent review verdict on {{target}}.

**Approach**
- Read the diff AND the surrounding code, not just the patch.
- Check: correctness, error paths, tests, security, regressions.
- One line per finding: location, problem, fix. Rank by severity.

**Acceptance criteria**
- [ ] Every finding cites file:line.
- [ ] Explicit verdict: approve / request changes, with the reason.
- [ ] No code written by you.

**Out of scope** Fixing what you find.`,
  },
  {
    name: "research",
    description: "Source-grounded comparison ending in a recommendation.",
    role: "researcher",
    body: `**Goal** Decide: {{question}}

**Approach**
- Prefer primary sources; date-stamp anything that can go stale.
- Compare at least {{min_options}} real options on the criteria that matter here.
- Say plainly what you could not verify.

**Acceptance criteria**
- [ ] Every claim carries a source URL.
- [ ] A single recommendation with the trade-off that decided it.
- [ ] Rejected options listed with the reason.

**Out of scope** Implementing the choice.`,
  },
  {
    name: "feature",
    description: "Implement a scoped feature with tests.",
    role: null,
    body: `**Goal** {{outcome}}

**Approach**
- Read the surrounding code and match its idiom.
- Implement the smallest version that satisfies the criteria below.
- Add or extend tests alongside the change.

**Acceptance criteria**
- [ ] {{verify_command}} passes, output quoted.
- [ ] Behaviour: {{behaviour}}
- [ ] No new dependency without saying why.

**Out of scope** {{out_of_scope}}`,
  },
];

export function seedPrompts(root: string, force = false): string[] {
  const dir = join(root, PROMPTS_DIR);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const seed of SEEDS) {
    const path = join(dir, `${seed.name}.md`);
    if (existsSync(path) && !force) continue;
    writeFileSync(
      path,
      serializeDocument(
        { name: seed.name, description: seed.description, role: seed.role },
        seed.body,
      ),
      "utf8",
    );
    written.push(seed.name);
  }
  return written;
}
