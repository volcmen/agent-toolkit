import { describe, expect, test } from "bun:test";
import {
  parseDocument,
  parseFrontmatter,
  serializeDocument,
  serializeFrontmatter,
} from "../src/frontmatter.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardFilename, slugify } from "../src/ids.ts";
import { extractJson, parseCodexStream } from "../src/llm.ts";
import { render, variablesIn } from "../src/prompts.ts";
import { sanitizeEdges } from "../src/triage.ts";
import { loadRoles, roster, seedRoles } from "../src/roles.ts";
import { defaultConfig, mergeConfig } from "../src/config.ts";
import type { Role } from "../src/types.ts";

describe("frontmatter", () => {
  test("parses scalars, inline lists, block lists and maps", () => {
    const data = parseFrontmatter(
      [
        "id: c_abc",
        "title: Add a /health endpoint",
        "priority: 3",
        "goal: true",
        "model:",
        "parents: [c_1, c_2]",
        "skills:",
        "  - claude-code",
        "  - kanban",
        "meta:",
        "  owner: david",
      ].join("\n"),
    );
    expect(data.id).toBe("c_abc");
    expect(data.priority).toBe(3);
    expect(data.goal).toBe(true);
    expect(data.model).toBeNull();
    expect(data.parents).toEqual(["c_1", "c_2"]);
    expect(data.skills).toEqual(["claude-code", "kanban"]);
    expect(data.meta).toEqual({ owner: "david" });
  });

  test("a title containing a colon survives a round trip", () => {
    const original = { title: "fix: broken parser", status: "ready" };
    const parsed = parseFrontmatter(serializeFrontmatter(original));
    expect(parsed.title).toBe("fix: broken parser");
  });

  test("numeric-looking strings stay strings", () => {
    const parsed = parseFrontmatter(serializeFrontmatter({ id: "12345" }));
    expect(parsed.id).toBe("12345");
  });

  test("document round trip keeps the body verbatim", () => {
    const body = "**Goal** ship it\n\n- [ ] one\n- [ ] two";
    const document = serializeDocument({ id: "c_1", title: "t" }, body);
    const parsed = parseDocument(document);
    expect(parsed.data.id).toBe("c_1");
    expect(parsed.body.trim()).toBe(body);
  });

  test("a body with no frontmatter is returned untouched", () => {
    const parsed = parseDocument("just text\n");
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe("just text\n");
  });
});

describe("ids", () => {
  test("slugify strips punctuation and collapses dashes", () => {
    expect(slugify("Add a /health endpoint (fast!)")).toBe("add-a-health-endpoint-fast");
  });

  test("empty titles still produce a filename", () => {
    expect(slugify("///")).toBe("card");
  });

  test("card filenames carry date, slug and id tail", () => {
    const name = cardFilename("c_abcd1234", "Fix the parser", new Date("2026-07-27T10:00:00Z"));
    expect(name).toBe("2026-07-27-fix-the-parser-abcd1234.md");
  });
});

describe("extractJson", () => {
  test("reads a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  test("strips code fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test("ignores prose around the object", () => {
    expect(extractJson('Sure! {"a":1} hope that helps')).toEqual({ a: 1 });
  });

  test("handles nested braces and braces inside strings", () => {
    const parsed = extractJson('{"body":"use {{var}} here","nested":{"k":[1,2]}}');
    expect(parsed).toEqual({ body: "use {{var}} here", nested: { k: [1, 2] } });
  });

  test("returns null for arrays and garbage", () => {
    expect(extractJson("[1,2]")).toBeNull();
    expect(extractJson("no json at all")).toBeNull();
    expect(extractJson("")).toBeNull();
  });
});

describe("parseCodexStream", () => {
  const stream = [
    '{"type":"thread.started","thread_id":"019fa467-cd8c-7920-991a-34b799bea175"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"ok\\":true}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":13,"reasoning_output_tokens":7}}',
  ].join("\n");

  test("takes the agent message, thread id and token total", () => {
    const parsed = parseCodexStream(stream);
    expect(parsed.text).toBe('{"ok":true}');
    expect(parsed.sessionId).toBe("019fa467-cd8c-7920-991a-34b799bea175");
    expect(parsed.tokens).toBe(120);
    expect(parsed.usd).toBe(0);
  });

  test("ignores non-agent items", () => {
    expect(parseCodexStream(stream).text).not.toContain("thinking");
  });

  test("still understands the legacy msg envelope", () => {
    const legacy = [
      '{"msg":{"type":"agent_message","message":"hello","session_id":"abc"}}',
      "not json at all",
    ].join("\n");
    const parsed = parseCodexStream(legacy);
    expect(parsed.text).toBe("hello");
    expect(parsed.sessionId).toBe("abc");
  });

  test("empty stream yields empty text", () => {
    expect(parseCodexStream("").text).toBe("");
  });
});

describe("prompts", () => {
  test("finds placeholders once each", () => {
    expect(variablesIn("fix {{symptom}} then {{symptom}} and {{verify}}")).toEqual([
      "symptom",
      "verify",
    ]);
  });

  test("render fills values and reports what is missing", () => {
    const result = render("do {{a}} with {{b}}", { a: "x" });
    expect(result.text).toBe("do x with {{b}}");
    expect(result.missing).toEqual(["b"]);
  });
});

describe("triage edges", () => {
  test("drops self-references", () => {
    const cards = [{ title: "a", body: "", role: "backend", parents: [0] }];
    expect(sanitizeEdges(cards)[0]?.parents).toEqual([]);
  });

  test("breaks a cycle by dropping the edge that closes it", () => {
    const cards = [
      { title: "a", body: "", role: "backend", parents: [1] },
      { title: "b", body: "", role: "docs", parents: [0] },
    ];
    const sanitized = sanitizeEdges(cards);
    expect(sanitized.map((card) => card.title)).toEqual(["b", "a"]);
    expect(sanitized[0]?.parents).toEqual([]);
    expect(sanitized[1]?.parents).toEqual([0]);
  });

  test("keeps a forward reference by reordering instead of deleting it", () => {
    // The model listed docs first; its dependency on the implementation below is
    // real. Dropping the edge would let docs run before the code exists.
    const cards = [
      { title: "document it", body: "", role: "docs", parents: [1] },
      { title: "build it", body: "", role: "backend", parents: [] },
    ];
    const sanitized = sanitizeEdges(cards);
    expect(sanitized.map((card) => card.title)).toEqual(["build it", "document it"]);
    expect(sanitized[0]?.parents).toEqual([]);
    expect(sanitized[1]?.parents).toEqual([0]);
  });

  test("preserves a diamond declared out of order", () => {
    const cards = [
      { title: "release", body: "", role: "docs", parents: [1, 2] },
      { title: "api", body: "", role: "backend", parents: [3] },
      { title: "ui", body: "", role: "frontend", parents: [3] },
      { title: "schema", body: "", role: "data", parents: [] },
    ];
    const sanitized = sanitizeEdges(cards);
    const rank = new Map(sanitized.map((card, index) => [card.title, index]));
    expect(rank.get("schema")).toBe(0);
    expect(rank.get("release")).toBe(3);
    for (const [child, parent] of [["api", "schema"], ["ui", "schema"], ["release", "api"], ["release", "ui"]] as const) {
      expect(sanitized[rank.get(child) as number]?.parents, `${child} → ${parent}`)
        .toContain(rank.get(parent) as number);
    }
  });

  test("every parent index still points backwards, which is what card creation needs", () => {
    const cards = [
      { title: "z", body: "", role: "docs", parents: [2] },
      { title: "y", body: "", role: "qa", parents: [2, 0] },
      { title: "x", body: "", role: "backend", parents: [] },
    ];
    for (const [index, card] of sanitizeEdges(cards).entries()) {
      for (const parent of card.parents) expect(parent).toBeLessThan(index);
    }
  });
});

describe("multi-line frontmatter values", () => {
  test("a handoff survives the round trip intact", () => {
    // Every worker is asked for a HANDOFF of up to 6 lines, and children read
    // only that block — so losing or literalising its newlines corrupts the one
    // piece of context the next card gets.
    const handoff = [
      "- Added `done <id>` using the existing storage path.",
      "- Completion persists and survives reload.",
      "- `bun test`: 1 pass, 0 fail.",
    ].join("\n");
    const document = serializeDocument({ id: "c_1", handoff }, "body text");
    const parsed = parseDocument(document);
    expect(parsed.data.handoff).toBe(handoff);
    expect(parsed.body.trim()).toBe("body text");
  });

  test("a newline is escaped rather than left to end the line", () => {
    // Regression: an unquoted value containing a newline used to be written raw,
    // which ended the frontmatter line and truncated everything after it.
    const document = serializeDocument({ note: "first\nsecond" }, "");
    const head = document.slice(4, document.indexOf("\n---", 4));
    expect(head.split("\n")).toHaveLength(1);
    expect(parseDocument(document).data.note).toBe("first\nsecond");
  });

  test("tabs, quotes, and backslashes come back unchanged", () => {
    for (const value of ['tab\there', 'say "hi"', "back\\slash", "colon: inside", "trailing \n"]) {
      const parsed = parseDocument(serializeDocument({ value }, "b")).data.value;
      expect(parsed, JSON.stringify(value)).toBe(value);
    }
  });

  test("a single-line value still reads as plain YAML", () => {
    expect(serializeFrontmatter({ status: "ready" })).toBe("status: ready");
  });
});

describe("roster completeness", () => {
  function role(name: string, description: string): Role {
    return { name, description, soul: "", runtime: "codex", model: null, readOnly: false, skills: [], maxTurns: null, budgetUsd: null };
  }

  test("no role is ever dropped, however tight the budget", () => {
    // Regression: the old implementation stopped at the char budget, so longer
    // descriptions silently pushed `researcher` and `reviewer` off the end of the
    // alphabet. Triage then never saw them and every judgement card was remapped
    // to the fallback role — routing looked broken while the roles were fine.
    const roles = [
      role("backend", "x".repeat(400)),
      role("frontend", "y".repeat(400)),
      role("researcher", "z".repeat(400)),
      role("reviewer", "w".repeat(400)),
    ];
    const text = roster(roles, 200);
    for (const entry of roles) expect(text, entry.name).toContain(`- ${entry.name}:`);
    expect(text.split("\n")).toHaveLength(roles.length);
  });

  test("a tight budget clips descriptions rather than losing roles", () => {
    const roles = [role("a", "x".repeat(500)), role("b", "y".repeat(500))];
    const text = roster(roles, 160);
    expect(text).toContain("…");
    expect(text).toContain("- a:");
    expect(text).toContain("- b:");
  });

  test("the shipped roster fits without clipping", () => {
    const root = mkdtempSync(join(tmpdir(), "ab-roster-"));
    try {
      seedRoles(root);
      const roles = loadRoles(root);
      expect(roles).toHaveLength(11);
      const text = roster(roles);
      expect(text).not.toContain("…");
      for (const entry of roles) expect(text).toContain(entry.description);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("roster", () => {
  const roles: Role[] = [
    { name: "backend", description: "APIs and services", soul: "", runtime: "codex", model: null, readOnly: false, skills: [], maxTurns: null, budgetUsd: null },
    { name: "docs", description: "READMEs and runbooks", soul: "", runtime: "codex", model: null, readOnly: false, skills: [], maxTurns: null, budgetUsd: null },
  ];

  test("lists name and description", () => {
    expect(roster(roles)).toBe("- backend: APIs and services\n- docs: READMEs and runbooks");
  });

  test("spends the char budget on clipping, never on dropping a role", () => {
    // Was: `roster(roles, 30)` returned only the first role. Losing a role from
    // the prompt makes triage unable to pick it at all, which is far worse than
    // a shortened description.
    const tight = roster(roles, 30);
    expect(tight).toContain("- backend:");
    expect(tight).toContain("- docs:");
  });
});

describe("config", () => {
  test("merges one level of nesting instead of replacing it", () => {
    const merged = mergeConfig(defaultConfig("/tmp/x"), { budget: { perDayUsd: 3 }, maxRunning: 5 });
    expect(merged.budget.perDayUsd).toBe(3);
    expect(merged.budget.perCardUsd).toBe(defaultConfig("/tmp/x").budget.perCardUsd);
    expect(merged.maxRunning).toBe(5);
  });

  test("ignores non-objects", () => {
    expect(mergeConfig(defaultConfig("/tmp/x"), null).maxRunning).toBe(2);
  });

  test("the default triage chain starts free", () => {
    expect(defaultConfig("/tmp/x").triageChain[0]?.kind).toBe("local");
    expect(defaultConfig("/tmp/x").triageChain[0]?.maxUsd).toBe(0);
  });
});
