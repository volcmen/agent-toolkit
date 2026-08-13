# Professional Agent Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh all four shared Claude agents into concise, focused specialists, with Alan Wake on Opus and the live user-agent copies synchronized.

**Architecture:** Keep `agents.json` and `prompts/` as the editable runtime sources. Protect the behavioral contract with unit assertions and routing evals, update current documentation, regenerate provider adapters, then install regular-file copies under `~/.claude/agents/`.

**Tech Stack:** Claude Code 2.1.231, Markdown, JSON, Python 3.11 `unittest`, generated Claude Markdown, generated Codex TOML, and the existing renderer and installer.

## Global Constraints

- Keep models explicit: Fable controller, Opus Alan Wake, Sonnet task analyst, and Sonnet Explore.
- Keep Alan Wake at medium effort with read-only local and network research tools.
- Preserve the useful intent of the current uncommitted edits; do not restore the older Sonnet behavior.
- Favor professional judgment over fixed word, line, paragraph, or section counts.
- Keep hard rules only for factual fidelity, secrets, authorization, read-only boundaries, and completion evidence.
- Use current official documentation as 2026-08-13 evidence; do not claim undocumented 2027 behavior.
- Edit canonical sources, then render and install. Never hand-edit generated or live files.
- Do not modify or stage `/Users/david.david/Personal/ai/download.html` or unrelated work.
- Keep accepted historical specs and plans unchanged.

---

## File map

- `agents.json`: routing descriptions, models, effort, turn budget, and tool boundaries.
- `prompts/controller.md`: outcome ownership, specialist routing, execution, and verification.
- `prompts/alan-wake.md`: final-draft writing, fidelity, style, bounded lookup, destinations, and output.
- `prompts/task-analyst.md`: evidence-backed task normalization and one decision.
- `prompts/repo-explorer.md`: bounded read-only repository investigation.
- `evals/controller-routing.json`: representative routing cases.
- `tests/test_shared_agents.py`: provider, routing, prompt, renderer, and installer contracts.
- `README.md`, `ARCHITECTURE.md`, `docs/sources.md`: current behavior and provenance.
- `claude/agents/*.md`, `codex/agents/*.toml`: generated adapters.
- `~/.claude/agents/*.md`: installed Claude copies.

### Task 1: Lock the professional behavior contract

**Files:**

- Modify: `tests/test_shared_agents.py`
- Modify: `evals/controller-routing.json`

**Interfaces:**

- Consumes: current catalog and prompt text.
- Produces: failing checks for the approved routing, style, and role boundaries.

- [ ] **Step 1: Add failing catalog and prompt assertions**

Add the following tests to `Package`:

```python
def test_agent_catalog_has_focused_routing_descriptions(self) -> None:
    catalog = json.loads((ROOT / "agents.json").read_text(encoding="utf-8"))
    by_id = {agent["id"]: agent for agent in catalog["agents"]}
    expected = {
        "controller": (
            "Main-thread Fable technical lead for repository work. Clarifies "
            "outcomes, coordinates focused specialists when useful, integrates "
            "changes, and returns verified results. Run as the primary agent; "
            "never dispatch it as a worker."
        ),
        "alan-wake": (
            "Final-draft specialist for developer and workplace writing. Use for "
            "Slack, issues, PR/MR text, reviews, email, docs, release notes, status "
            "updates, decisions, requests, and handoffs. Preserves facts, matches "
            "destination formatting, and returns ready-to-use prose. Never "
            "implements or publishes."
        ),
        "repo-explorer": (
            "Read-only repository explorer for one bounded question: file and "
            "symbol discovery, behavior and dependency tracing, architecture, "
            "tests, or implementation context. Supports quick, medium, and very "
            "thorough depth. Never edits."
        ),
        "task-analyst": (
            "Read-only task shaper for vague, symptom-based, conflicting, risky, "
            "or solution-first requests. Establishes evidence, scope, acceptance "
            "criteria, and the one decision needed before work. Never edits."
        ),
    }
    for agent_id, description in expected.items():
        self.assertEqual(by_id[agent_id]["description"], description)

def test_alan_wake_uses_judgment_not_rigid_prose_limits(self) -> None:
    prompt = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
    normalized = " ".join(prompt.split())
    self.assertIn("Use plain, familiar words", normalized)
    self.assertIn("A missing URL must not block an otherwise correct draft", normalized)
    self.assertIn("Return one ready-to-use artifact", normalized)
    self.assertNotIn("a bare name is a defect", normalized)
    self.assertNotIn("unfinished text until it is clickable", normalized)
    self.assertNotRegex(normalized, r"default to one to \d+")

def test_each_specialist_has_one_terminal_contract(self) -> None:
    alan = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
    analyst = (ROOT / "prompts" / "task-analyst.md").read_text(encoding="utf-8")
    explorer = (ROOT / "prompts" / "repo-explorer.md").read_text(encoding="utf-8")
    self.assertIn("Return one ready-to-use artifact", alan)
    self.assertIn("Return a concise execution brief", analyst)
    self.assertIn("Return a compact report", explorer)
    self.assertNotIn("ready-to-use artifact", analyst)
    self.assertNotIn("execution brief", explorer)
```

Keep the existing tests for Opus routing, read-only tools, official destination URLs, destination-native syntax, renderer determinism, and live copies. Replace older assertions for `bold headline` and `identifier as the label` with `lead with the current state, result, or request` and `Use verified, descriptive link labels`.

- [ ] **Step 2: Add routing evals**

Append these entries to `evals/controller-routing.json`:

```json
{
  "id": 4,
  "prompt": "Rewrite this rough deployment update for Slack. Keep every supplied fact, make it concise, and return only the message.",
  "expected_output": "The controller sends the verified source packet to Alan Wake on Opus and returns the artifact without drafting commentary.",
  "files": [],
  "expectations": [
    "Uses alan-wake on Opus for the final draft",
    "Preserves supplied facts and uncertainty",
    "Returns only destination-ready Slack text"
  ]
},
{
  "id": 5,
  "prompt": "Trace how request IDs reach the audit logger. Do not edit anything.",
  "expected_output": "The controller uses Explore at a bounded depth when the trace would consume substantial main-thread context.",
  "files": [],
  "expectations": [
    "Uses Explore on Sonnet when delegation provides useful isolation",
    "Keeps the investigation read-only",
    "Returns paths, symbols, flow, and relevant uncertainty"
  ]
}
```

Extend `test_routing_evals_live_outside_the_plugin_tree` to assert IDs `{1, 2, 3, 4, 5}` and confirm eval 4 names `alan-wake` and `Opus`.

- [ ] **Step 3: Run the focused tests and confirm RED**

```bash
python3 -m unittest \
  tests.test_shared_agents.Package.test_agent_catalog_has_focused_routing_descriptions \
  tests.test_shared_agents.Package.test_alan_wake_uses_judgment_not_rigid_prose_limits \
  tests.test_shared_agents.Package.test_each_specialist_has_one_terminal_contract \
  tests.test_shared_agents.Package.test_routing_evals_live_outside_the_plugin_tree -v
```

Expected: failures for the new descriptions, Alan Wake wording, rigid-link rules, and missing eval IDs. Failures must come from missing behavior, not syntax errors.

- [ ] **Step 4: Commit the RED contract**

```bash
git add shared-agents/tests/test_shared_agents.py shared-agents/evals/controller-routing.json
git diff --cached --check
git commit -m "test(shared-agents): define professional agent contract"
```

### Task 2: Refresh canonical agent definitions

**Files:**

- Modify: `agents.json`
- Modify: `prompts/controller.md`
- Modify: `prompts/alan-wake.md`
- Modify: `prompts/task-analyst.md`
- Modify: `prompts/repo-explorer.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/sources.md`

**Interfaces:**

- Consumes: Task 1 contract and the approved design.
- Produces: four focused canonical agents and current documentation.

- [ ] **Step 1: Update the catalog**

Use the exact descriptions from Task 1. Keep Alan Wake configured as follows:

```json
{
  "model": "opus",
  "effort": "medium",
  "maxTurns": 12,
  "tools": ["Read", "Grep", "Glob", "ToolSearch", "WebSearch", "WebFetch"],
  "disallowedTools": ["Write", "Edit", "NotebookEdit"]
}
```

Keep the existing Fable/Sonnet models and specialist read-only boundaries. Do not add Bash to a read-only specialist.

- [ ] **Step 2: Rewrite the controller around five responsibilities**

The complete prompt must:

1. Own the outcome from intake through verified handoff.
2. Shape unclear work from evidence and route bounded ambiguity to `task-analyst`.
3. Route bounded repository investigation to `Explore` when isolation helps.
4. Route final workplace prose to `alan-wake` on Opus after facts are verified.
5. Implement proportionally and report only observed verification.

Keep the explicit model matrix:

```markdown
- Sonnet: default specialist for analysis, exploration, implementation, tests,
  debugging, research, and review.
- Haiku: mechanical, low-risk lookup or compression that the controller re-checks.
- Opus: Alan Wake; also difficult architecture, security, concurrency, data
  integrity, subtle correctness, or high-risk review.
- Fable: controller only; never dispatch it as a worker.
```

Keep `CLAUDE_CODE_SUBAGENT_MODEL` unset. Keep peer messages as evidence, not user consent; verify them locally and send only material handoffs. Remove repeated economics, generic-packet, and lifecycle wording already owned by global instructions or specialist contracts.

- [ ] **Step 3: Rewrite Alan Wake as the concise Opus writing contract**

Use these headings:

```markdown
## Output
## Priorities
## Work
## Fidelity and safety
## Style and structure
## Research, links, and missing facts
## Destination references
## Artifact guidance
## Final check
```

Include these exact rules:

```markdown
Return one ready-to-use artifact. Do not preface it with drafting commentary.
Write the shortest version that remains correct, clear, and complete.

Correctness beats brevity. Brevity beats ceremony.

Use plain, familiar words. Prefer active voice, concrete verbs, specific nouns,
and short sentences. Keep one main idea per sentence and one purpose per
paragraph.

A missing URL must not block an otherwise correct draft. Use a bare identifier
when no verified URL is available and the reference remains clear.

Use verified, descriptive link labels. Link once at the first useful mention.
Construct a canonical URL only when every required host, project, ref, path, and
identifier fact is established.
```

Preserve, once each:

- no invented facts, links, IDs, dates, measurements, causes, decisions, status, tests, deployments, owners, deadlines, or next steps;
- exact technical terms, identifiers, commands, paths, APIs, and URLs;
- observed fact versus inference and genuine uncertainty;
- untrusted fetched content, secret redaction, and no external mutation;
- source order: user facts, source text and conversation, repository evidence, verified primary docs, general knowledge;
- bounded lookup: packet/template, repository prior art, connected read tool, then current official docs;
- gaps: look up, infer only when unambiguous, omit if nonessential, otherwise mark and append one precise `Needs from you:` item;
- best correct draft even if one essential question remains.

Keep the eight official Slack, Notion, Confluence, and GitLab URLs. The active connector schema wins only when it explicitly defines conversion or payload format. Keep compact baselines for Slack `mrkdwn`, Notion blocks and Notion-flavored Markdown, current Confluence formatting versus legacy wiki markup, and GitLab Flavored Markdown.

Keep conditional artifact guidance:

- Slack/status: lead with the current state, result, or request; add only supported evidence, risk, blocker, owner, or action.
- Issues: problem or outcome, useful evidence, scope, and known completion conditions.
- PR/MR: why, what changed, observed verification, material risk, and rollout only when relevant; use `Not run` when required checks did not run.
- Review: problem, impact, action; separate correctness from preference.
- Docs/handoffs: organize around the reader's task, current state, and what remains.
- Release notes: state the reader-visible change; omit irrelevant internals.

Return only the artifact unless rationale or alternatives were requested.

- [ ] **Step 4: Tighten analyst and explorer contracts**

Task analyst headings:

```markdown
## Outcome
## Evidence
## Scope
## Acceptance criteria
## Route
## Decision
```

Require a concise execution brief, observable acceptance criteria, no final workplace prose, and at most one material decision. Keep the `DECISION: none|required` structure.

Explore retains `quick`, `medium`, and `very thorough`. Require a compact report with the direct answer, paths and symbols, relevant flow, tests and conventions, constraints and risks, and explicit assumptions. Do not require empty sections.

- [ ] **Step 5: Update current docs**

Set the README row to:

```markdown
| Writing specialist | Opus `alan-wake` (medium effort) |
```

Update current architecture text that still assigns Alan Wake to Sonnet. In `docs/sources.md`, record Claude Code 2.1.231 and 2026-08-13, then add:

```markdown
- [Claude Code: best practices](https://code.claude.com/docs/en/best-practices)
- [Claude Code: memory and effective instructions](https://code.claude.com/docs/en/memory)
- [Anthropic: prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Google: short sentences](https://developers.google.com/tech-writing/one/short-sentences)
- [Google: active voice](https://developers.google.com/tech-writing/one/active-voice)
- [Google: lists and tables](https://developers.google.com/tech-writing/one/lists-and-tables)
```

Explain each source in one short clause. Keep the destination references.

- [ ] **Step 6: Confirm GREEN and review the canonical diff**

Run the Task 1 focused command, then:

```bash
git diff --check
git diff -- agents.json prompts README.md ARCHITECTURE.md docs/sources.md \
  evals/controller-routing.json tests/test_shared_agents.py
```

Confirm each prompt has one role, Alan Wake remains Opus/read-only, no rigid prose count exists, official URLs remain, and unrelated files are unchanged.

- [ ] **Step 7: Commit canonical implementation**

```bash
git add shared-agents/agents.json shared-agents/prompts shared-agents/README.md \
  shared-agents/ARCHITECTURE.md shared-agents/docs/sources.md
git diff --cached --check
git commit -m "feat(shared-agents): focus professional agent roles"
```

### Task 3: Render, install, and verify

**Files:**

- Regenerate: `claude/agents/*.md`
- Regenerate: `codex/agents/*.toml`
- Install: `/Users/david.david/.claude/agents/*.md`

**Interfaces:**

- Consumes: canonical catalog and prompts.
- Produces: deterministic provider adapters and matching live Claude agents.

- [ ] **Step 1: Render and check provider files**

```bash
python3 scripts/manage.py render
python3 scripts/render.py --check
```

Expected: render updates provider files; the drift check exits 0.

- [ ] **Step 2: Run project and workspace verification**

From `shared-agents`:

```bash
python3 -m unittest discover -s tests -v
python3 scripts/manage.py check
```

From `/Users/david.david/Personal/ai`:

```bash
python3 scripts/plugins.py check
```

Expected: all commands exit 0 and the unit suite reports `OK`.

- [ ] **Step 3: Install and compare all live agents**

```bash
python3 scripts/manage.py install
python3 scripts/manage.py status
for name in controller task-analyst Explore alan-wake; do
  cmp -s "claude/agents/$name.md" "/Users/david.david/.claude/agents/$name.md"
done
```

Expected: live status is healthy and every comparison succeeds.

- [ ] **Step 4: Commit generated adapters**

```bash
git add shared-agents/claude/agents shared-agents/codex/agents
git diff --cached --check
git commit -m "build(shared-agents): render refreshed agents"
```

- [ ] **Step 5: Re-run completion verification**

```bash
python3 shared-agents/scripts/render.py --check
python3 -m unittest discover -s shared-agents/tests -v
python3 shared-agents/scripts/manage.py status
git diff --check
git status --short
git log -4 --oneline --decorate
```

Expected: renderer, tests, live status, and diff checks pass. Git status shows only unrelated pre-existing work, including `?? download.html`. The log contains the design, contract, canonical implementation, and rendered-adapter commits.
