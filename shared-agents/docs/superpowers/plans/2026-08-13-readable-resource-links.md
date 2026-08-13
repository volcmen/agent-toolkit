# Readable Resource Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Alan Wake turn verified resource URLs into readable, clickable references using the target destination's native format.

**Architecture:** Keep the policy in the canonical Alan Wake prompt, record representative behavioral cases in a standalone eval fixture, and render provider adapters from that one source. The agent prefers destination-native references, then named links, and exposes raw URLs only when the destination or request requires them.

**Tech Stack:** Markdown agent prompts, JSON eval fixtures, Python 3.11 `unittest`, the existing renderer and installer, and the local Claude CLI for read-only prompt checks.

## Global Constraints

- Use only supplied or read-only verified URLs; never invent hosts, paths, IDs, or build numbers.
- Preserve exact identifiers and link the first useful mention without repeating noisy links.
- Prefer active tool schemas, then destination-native references, then named links.
- Keep Alan Wake on Claude Opus at medium effort and read-only tools.
- Do not publish or mutate external systems.
- Preserve the unrelated root-level `download.html` file.

## File map

- `shared-agents/evals/alan-wake-links.json`: behavioral cases for clickable resource references.
- `shared-agents/tests/test_shared_agents.py`: eval-schema and prompt-contract regression checks.
- `shared-agents/prompts/alan-wake.md`: canonical resource-link behavior.
- `shared-agents/docs/sources.md`: official source provenance.
- `shared-agents/claude/agents/alan-wake.md`: generated Claude adapter.
- `shared-agents/codex/agents/alan_wake.toml`: generated Codex adapter.
- `~/.claude/agents/alan-wake.md`: installed Claude copy updated by the existing installer.

---

### Task 1: Define the resource-link regression contract

**Files:**
- Create: `shared-agents/evals/alan-wake-links.json`
- Modify: `shared-agents/tests/test_shared_agents.py`

**Interfaces:**
- Consumes: the existing JSON eval convention in `evals/controller-routing.json`.
- Produces: seven named cases with `id`, `destination`, `prompt`, `expected_output`, and `expectations` fields.

- [ ] **Step 1: Add failing regression tests**

Add tests that load `evals/alan-wake-links.json`, require the exact case IDs
below, require the prompt to carry the destination-order and raw-URL rules, and
extend the official-source tuple with the Notion rich-text, Confluence link,
and Jenkins Remote Access API URLs:

```python
def test_alan_wake_link_evals_cover_resource_contract(self) -> None:
    payload = json.loads(
        (ROOT / "evals" / "alan-wake-links.json").read_text(encoding="utf-8")
    )
    self.assertEqual(payload["agent_name"], "alan-wake")
    by_id = {case["id"]: case for case in payload["evals"]}
    self.assertEqual(
        set(by_id),
        {
            "gitlab-native-mr",
            "slack-named-mr",
            "markdown-jenkins-build",
            "markdown-labeled-document",
            "deduplicate-resource-link",
            "missing-url",
            "plain-text-url",
        },
    )
    for case in by_id.values():
        self.assertTrue(case["destination"])
        self.assertTrue(case["prompt"])
        self.assertTrue(case["expected_output"])
        self.assertGreaterEqual(len(case["expectations"]), 2)

def test_alan_wake_formats_verified_resource_links(self) -> None:
    prompt = (ROOT / "prompts" / "alan-wake.md").read_text(encoding="utf-8")
    normalized = " ".join(prompt.split())
    self.assertIn("Active tool schema", normalized)
    self.assertIn("Destination-native reference", normalized)
    self.assertIn("Named link", normalized)
    self.assertIn("Do not write `label: URL`", normalized)
    self.assertIn("Jenkins", normalized)
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd shared-agents
python3.14 -m unittest \
  tests.test_shared_agents.Package.test_alan_wake_link_evals_cover_resource_contract \
  tests.test_shared_agents.Package.test_alan_wake_formats_verified_resource_links \
  tests.test_shared_agents.Package.test_alan_wake_consults_official_destination_references -v
```

Expected: FAIL because `alan-wake-links.json` and the new prompt contract do not
exist yet.

- [ ] **Step 3: Add the seven behavioral eval cases**

Create valid JSON with this top-level shape:

```json
{
  "agent_name": "alan-wake",
  "evals": [
    {
      "id": "gitlab-native-mr",
      "destination": "GitLab merge request comment",
      "prompt": "Rewrite for a GitLab MR comment: Review MR !123 at the supplied URL https://gitlab.example.com/group/project/-/merge_requests/123. Return only the comment.",
      "expected_output": "Review !123.",
      "expectations": [
        "Uses the native clickable !123 reference",
        "Does not append or expose the raw URL"
      ]
    }
  ]
}
```

Add the remaining six cases named in Step 1. Use literal expected outputs for
Slack `<url|label>`, Markdown `[label](url)`, one first-mention-only duplicate,
a bare identifier with no URL, and a plain-text `label: URL` exception.

- [ ] **Step 4: Run only the eval-fixture test**

Run:

```bash
cd shared-agents
python3.14 -m unittest \
  tests.test_shared_agents.Package.test_alan_wake_link_evals_cover_resource_contract -v
```

Expected: PASS. The prompt-contract test must remain failing until Task 2.

- [ ] **Step 5: Commit the regression contract**

```bash
git add shared-agents/evals/alan-wake-links.json \
  shared-agents/tests/test_shared_agents.py
git commit -m "test(shared-agents): define readable link contract"
```

### Task 2: Implement the canonical link behavior

**Files:**
- Modify: `shared-agents/prompts/alan-wake.md`
- Modify: `shared-agents/docs/sources.md`

**Interfaces:**
- Consumes: the seven behavioral cases from Task 1 and official destination documentation.
- Produces: one concise resource-link decision order used by every rendered adapter.

- [ ] **Step 1: Add the compact resource-link contract**

Replace the current general link paragraphs with a small ordered section that
states:

```markdown
For every verified resource reference, choose the first supported form:

1. **Active tool schema.** Use its native link or rich-text field.
2. **Destination-native reference.** Use a proven clickable reference such as
   GitLab `!123`, `#456`, or `group/project!123`.
3. **Named link.** Put the URL behind the shortest useful resource label.
4. **Raw URL.** Use it only for plain text, an explicit request for the exact
   address, or prose where the address itself is the subject.

Do not write `label: URL` when the destination supports a named or native link.
```

Keep the no-invention and first-use-only rules. Add short label examples for an
issue, MR/PR, Jenkins job/build, commit, file/line, runbook, dashboard, and
document. Keep examples destination-correct: Slack `<url|label>`, Markdown
`[label](url)`, and GitLab `!123` only when GitLab can resolve its scope.

- [ ] **Step 2: Tighten destination guidance**

Add these facts without duplicating the universal rule:

- GitLab native references are clickable and are preferred when scope is
  unambiguous; use an explicit Markdown link for external resources.
- Notion rich-text `text.link.url` and Confluence inline/Smart Links preserve a
  readable label.
- Jenkins job and build URLs are never reconstructed from partial data; a
  supplied build URL uses a label such as `payments-deploy #482`.

- [ ] **Step 3: Update source provenance**

Add concise entries for:

```markdown
- [Notion: rich text](https://developers.notion.com/reference/rich-text)
- [Confluence: insert links and anchors](https://support.atlassian.com/confluence-cloud/docs/insert-links-and-anchors/)
- [Jenkins: Remote Access API](https://www.jenkins.io/doc/book/using/remote-access-api/)
```

- [ ] **Step 4: Run the focused prompt-contract tests and verify GREEN**

Run:

```bash
cd shared-agents
python3.14 -m unittest \
  tests.test_shared_agents.Package.test_alan_wake_link_evals_cover_resource_contract \
  tests.test_shared_agents.Package.test_alan_wake_formats_verified_resource_links \
  tests.test_shared_agents.Package.test_alan_wake_consults_official_destination_references \
  tests.test_shared_agents.Package.test_alan_wake_writes_destination_native_slack_mrkdwn -v
```

Expected: PASS.

- [ ] **Step 5: Run the complete Alan Wake contract group**

Run:

```bash
cd shared-agents
python3.14 -m unittest \
  tests.test_shared_agents.Package.test_alan_wake_uses_judgment_not_rigid_prose_limits \
  tests.test_shared_agents.Package.test_alan_wake_link_evals_cover_resource_contract \
  tests.test_shared_agents.Package.test_alan_wake_formats_verified_resource_links \
  tests.test_shared_agents.Package.test_alan_wake_consults_official_destination_references \
  tests.test_shared_agents.Package.test_alan_wake_uses_destination_native_format_contracts \
  tests.test_shared_agents.Package.test_alan_wake_writes_destination_native_slack_mrkdwn \
  tests.test_shared_agents.Package.test_alan_wake_is_a_terminal_writer -v
```

Expected: all Alan Wake contract tests pass. The full suite follows rendering in
Task 3 because it intentionally fails on generated-file drift.

- [ ] **Step 6: Commit the canonical behavior**

```bash
git add shared-agents/prompts/alan-wake.md shared-agents/docs/sources.md
git commit -m "feat(shared-agents): format readable resource links"
```

### Task 3: Render and install the provider adapters

**Files:**
- Modify: `shared-agents/claude/agents/alan-wake.md`
- Modify: `shared-agents/codex/agents/alan_wake.toml`
- Modify outside Git: `~/.claude/agents/alan-wake.md`

**Interfaces:**
- Consumes: the canonical prompt from Task 2.
- Produces: matching generated Claude and Codex definitions plus the live Claude copy.

- [ ] **Step 1: Render generated files**

Run:

```bash
python3 shared-agents/scripts/render.py
```

Expected: only the Alan Wake Claude and Codex adapters update.

- [ ] **Step 2: Verify generated scope and model safety**

Run:

```bash
git status --short
git diff -- shared-agents/claude/agents/alan-wake.md \
  shared-agents/codex/agents/alan_wake.toml
rg -n '^model: opus$|^effort: medium$|^disallowedTools:' \
  shared-agents/claude/agents/alan-wake.md
```

Expected: the generated prompt changes only; Claude remains Opus, medium, and
read-only.

- [ ] **Step 3: Run the full shared-agents unit suite**

Run:

```bash
python3 -m unittest discover -s shared-agents/tests -v
```

Expected: all tests pass with no failures or errors.

- [ ] **Step 4: Commit generated adapters**

```bash
git add shared-agents/claude/agents/alan-wake.md \
  shared-agents/codex/agents/alan_wake.toml
git commit -m "build(shared-agents): render readable links"
```

- [ ] **Step 5: Install the live Claude agents**

Run:

```bash
python3 shared-agents/scripts/manage.py install
```

Expected: installation reports a new backup for replaced files, copies Alan
Wake, and finishes with `ok shared-agents live installation`.

### Task 4: Evaluate and verify the installed behavior

**Files:**
- Read: `shared-agents/evals/alan-wake-links.json`
- Read: `~/.claude/agents/alan-wake.md`

**Interfaces:**
- Consumes: installed Alan Wake and the seven eval cases.
- Produces: fresh evidence for correctness, drift, live installation, and workspace health.

- [ ] **Step 1: Run direct read-only prompt checks when available**

Confirm CLI support first:

```bash
claude --help
```

If headless `--agent` execution is available, run focused prompts for GitLab,
Slack, Jenkins Markdown, missing URL, and plain text. Use `--agent alan-wake`,
`--print`, and `--no-session-persistence`. Compare each result with its literal
`expected_output` and expectations in `alan-wake-links.json`. Do not publish or
invoke any write-capable tool. If the CLI or authentication is unavailable,
record the exact limitation and continue with deterministic verification.

- [ ] **Step 2: Verify renderer, unit suite, live copy, and whitespace**

Run:

```bash
python3 shared-agents/scripts/render.py --check
python3 -m unittest discover -s shared-agents/tests -v
python3 shared-agents/scripts/manage.py status
git diff --check
```

Expected: every command exits zero; all provider files match; all tests pass;
the live installation matches source; no whitespace errors exist.

- [ ] **Step 3: Run the full workspace gate**

Run:

```bash
python3 scripts/plugins.py check
```

Expected: exit zero for catalog, plugin, wiki, and project checks.

- [ ] **Step 4: Confirm unrelated files remain untouched**

Run:

```bash
git status --short --branch
git log -5 --oneline
```

Expected: only the pre-existing untracked `download.html` remains outside the
committed change set.

- [ ] **Step 5: Record the durable decision**

Using `obsidian-memory`, create the next shared-agents DDR as a refinement of
DDR-0007, update the project README, `wiki/hot.md`, and `wiki/log.md`, and verify
the vault commit. Record the official sources, the seven behavioral cases, the
test count, live-install result, workspace gate, and rollback commit.
