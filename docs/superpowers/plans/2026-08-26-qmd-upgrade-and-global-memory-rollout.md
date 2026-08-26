# QMD Upgrade and Global Memory Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade QMD to 2.8.3, complete the nine-provider research record, activate the verified plugin safely, validate the real vault, and file the accepted global-memory decision.

**Architecture:** QMD remains a Bun-pinned derived accelerator behind the already verified Markdown/native layer. Repository and plugin gates complete before live force-installation; model/index work is an explicit post-install operation. A private retrieval fixture proves the real sibling supersession chain, then durable wiki records capture only the decision and evidence—not the transcript or tool traces.

**Tech Stack:** Bun global-tool manifest, QMD 2.8.3 CLI, Python plugin/check scripts, Git, Obsidian CLI transport.

**Spec:** [Local-First Global Memory Upgrade Design](../specs/2026-08-26-global-memory-upgrade-design.md)

**Depends on:** [Global Memory Core Hardening Plan](2026-08-26-global-memory-core-hardening.md) and [Global Memory Evaluation and Audit Plan](2026-08-26-global-memory-evaluation-and-audit.md)

## Global Constraints

- Obsidian Markdown plus Git remains the only writable canonical memory.
- Pin `@tobilu/qmd` exactly at `2.8.3`; install user JavaScript CLIs only through `bun-global-tools/sync.py`.
- Do not use `npm install --global`, enable QMD HTTP/MCP, trust project-local QMD configuration, or add external model/source paths.
- Do not run refresh, embedding, evaluation, or audit in SessionStart or Stop hooks.
- External memory providers remain research/evaluation references; no live vault content, queries, transcripts, tool traces, or credentials leave the machine.
- Source review is not described as live provider integration testing.
- Keep local plugin versions at `1.0.0`; edit `plugins.json` only if catalog metadata changes, and never hand-edit generated manifests.
- Use `python3 scripts/plugins.py install --force` only after the implementation is integrated into the branch selected for live use.
- Treat `wiki/scripts/update.py` as a mutating release operation and do not run it.
- Preserve existing vault history. Decision 0009 refines rather than rewrites decision 0008.
- Do not introduce Factorio code, documentation, branch integration, provider data, or project-note edits.

## File map

- Modify `bun-global-tools/manifest.json`: QMD exact version pin.
- Modify `wiki/docs/research/2026-08-01-agent-memory-systems.md`: source revision, nine-provider accounting, independent assessments, and validation limits.
- Modify `wiki/scripts/check.py`: research/documentation assertions.
- Modify `wiki/README.md`: QMD version, manual evaluate/audit/refresh sequence, and rollback.
- Modify `wiki/ARCHITECTURE.md`: local-only trust boundary and explicit maintenance flow.
- Modify `wiki/plugins/obsidian-memory/skills/obsidian-memory/references/qmd-retrieval.md`: QMD 2.8.3 and explicit maintenance.
- Modify `wiki/plugins/obsidian-memory/skills/obsidian-memory/references/recall-providers.md`: nine-provider decision and local-only policy.
- Local configuration only: create a private `evals/recall.json` beside the active obsidian-memory configuration; do not commit it or expose its absolute path.
- Local vault only: create decision `0009`; update that project's README, decision index, task list, journal, plus global log/hot cache. These paths are never copied into repository configuration.
- Preserve generated plugin and marketplace manifests at version `1.0.0`.

---

### Task 1: Upgrade the Bun-owned QMD CLI to 2.8.3

**Files:**

- Modify: `bun-global-tools/manifest.json:15-19`

**Interfaces:**

- Consumes: `bun-global-tools/sync.py apply|check --deep`.
- Produces: globally installed `qmd` 2.8.3 with the existing cache/index preserved as derived data.

- [ ] **Step 1: Capture the installed baseline without changing it**

Run:

```bash
qmd --version
python3 bun-global-tools/sync.py check --deep
bun pm ls --global | rg '@tobilu/qmd'
```

Expected before the change: QMD 2.5.3, four declared Bun tools, healthy derived index, and no undeclared npm-global replacement.

- [ ] **Step 2: Change only the exact manifest pin**

Apply:

```diff
     {
       "name": "@tobilu/qmd",
-      "version": "2.5.3",
+      "version": "2.8.3",
       "binaries": ["qmd"]
     },
```

- [ ] **Step 3: Verify the manifest detects installed drift**

Run:

```bash
python3 bun-global-tools/sync.py check --deep
```

Expected: nonzero because the manifest requires 2.8.3 while the installed binary remains 2.5.3. No package is changed by this check.

- [ ] **Step 4: Apply the Bun manifest and validate the binary**

Run:

```bash
python3 bun-global-tools/sync.py apply
qmd --version
qmd status
qmd doctor
python3 bun-global-tools/sync.py check --deep
bun pm ls --global | rg '@tobilu/qmd@2\\.8\\.3'
```

Expected: `qmd --version` reports 2.8.3, status opens the existing database, doctor completes its index/model checks, the deep workspace check passes, and Bun owns the declared binary. A transient Metal compilation message is acceptable only if QMD's vector sample and overall doctor result pass; otherwise stop before committing.

- [ ] **Step 5: Probe the unchanged wrapper contract against QMD 2.8.3**

Run:

```bash
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py providers --json
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py doctor --json
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  recall "provider backed recall" --mode fast --provider auto --top 3
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  recall "semantically governed persistent context" --mode semantic --provider auto --top 3
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  recall "local canonical memory retrieval" --mode hybrid --provider auto --top 3
```

Expected: canonical provider remains `obsidian-markdown`; each recall returns bounded JSON, reports actual provider/mode and any degradation, and exposes no private roots.

- [ ] **Step 6: Commit the exact pin**

```bash
git add bun-global-tools/manifest.json
git commit -m "build(memory): upgrade QMD to 2.8.3"
```

### Task 2: Correct and complete the nine-provider research record

**Files:**

- Modify: `wiki/scripts/check.py:182-241`
- Modify: `wiki/docs/research/2026-08-01-agent-memory-systems.md:1-220`

**Interfaces:**

- Consumes: inspected Hermes source revision `b2bd1ac63ff137a6287ce989d65dccee6b9155e2` and the primary references in the approved design.
- Produces: an auditable nine-provider comparison that distinguishes source validation from live end-to-end testing.

- [ ] **Step 1: Add a failing research-completeness check**

In `validate_memory_policy`, add:

```python
research = (ROOT / "docs" / "research" / "2026-08-01-agent-memory-systems.md").read_text(
    encoding="utf-8"
)
for term in (
    "b2bd1ac63ff137a6287ce989d65dccee6b9155e2",
    "nine available",
    "Memori",
    "source- and contract-level",
    "not a claim of live end-to-end success",
):
    require(term in research, f"memory-provider research omits: {term}")
```

- [ ] **Step 2: Verify the stale eight-provider record fails**

```bash
python3 wiki/scripts/check.py --skip-tests
```

Expected: FAIL on the missing current Hermes revision.

- [ ] **Step 3: Update scope, method, and provider accounting**

Replace the old Hermes revision/method paragraph with:

```markdown
The Hermes Agent repository was shallow-cloned and inspected at revision
`b2bd1ac63ff137a6287ce989d65dccee6b9155e2`. Its provider contract, manager,
developer guide, failure containment, and every available provider were checked
independently. The feature page currently says eight providers while enumerating
nine. Eight providers are bundled in that revision—ByteRover,
Hindsight, Holographic, Honcho, Mem0, OpenViking, RetainDB, and Supermemory.
Memori is delivered separately as `hermes-memori`, making nine available
choices. The provider modules compiled locally. This was source- and
contract-level validation, not a claim of live end-to-end success: hosted
credentials and separate databases/services were deliberately not provisioned.
```

Replace the eight-provider paragraph with this decision table:

```markdown
| Provider | Verified design surface | Local decision |
| --- | --- | --- |
| Honcho | Events/messages, peer representations, session context, hybrid search, dialectic modeling | Do not adopt; social modeling does not replace a canonical wiki and requires added service/LLM infrastructure. |
| OpenViking | Hierarchical L0/L1/L2 context, filesystem-like organization, vector index, session extraction | Do not adopt; the useful progressive-disclosure pattern is already local and a second hierarchy would split authority. |
| Mem0 | LLM extraction/deduplication plus vector/entity storage; hosted graph capability | Do not adopt; automatic extraction and a second truth store conflict with explicit admission. |
| Hindsight | Retain/recall/reflect with semantic, BM25, graph, temporal retrieval and source-backed observations | Defer as the best synthetic-data pilot only after a measured graph/temporal failure. |
| Holographic | Hermes-local SQLite FTS5, trust scores, optional holographic representations | Do not adopt; duplicates native/QMD and trust scoring is not provenance. |
| RetainDB | Hosted company/user/session/agent memory with citations and API/MCP | Do not adopt; duplicates the local system and adds content egress. |
| ByteRover | Local Markdown context tree, curation, daemon, semantic Git, human review | Do not adopt; closest philosophy, but still a second context tree and owner. |
| Supermemory | Cloud/self-hosted graph memory, local embeddings support, LLM processing | Do not adopt; no measured gap justifies another database/service. |
| Memori | Completed-turn and tool-execution capture with entity/project attribution | Do not adopt; automatic tool-trace capture has the largest privacy/governance mismatch. |
```

Add these direct primary links:

```markdown
- https://github.com/NousResearch/hermes-agent
- https://github.com/plastic-labs/honcho
- https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/01-architecture.md
- https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/how-it-works.mdx
- https://github.com/vectorize-io/hindsight
- https://www.retaindb.com/docs/intro
- https://docs.byterover.dev/reference/cli-reference
- https://github.com/supermemoryai/supermemory/blob/main/apps/docs/self-hosting/quickstart.mdx
- https://github.com/MemoriLabs/Memori/blob/main/docs/memori-cloud/hermes/quickstart.mdx
- https://github.com/tobi/qmd
```

- [ ] **Step 4: Run the research gate and commit**

```bash
python3 wiki/scripts/check.py --skip-tests
git diff --check
git add wiki/scripts/check.py wiki/docs/research/2026-08-01-agent-memory-systems.md
git commit -m "docs(wiki): assess all nine Hermes memory providers"
```

Expected: static checks pass and the research explicitly rejects live-vault mirroring.

### Task 3: Document QMD 2.8.3 and controlled local operations

**Files:**

- Modify: `wiki/README.md:90-160`
- Modify: `wiki/ARCHITECTURE.md:20-90`
- Modify: `wiki/plugins/obsidian-memory/skills/obsidian-memory/references/qmd-retrieval.md:1-end`
- Modify: `wiki/plugins/obsidian-memory/skills/obsidian-memory/references/recall-providers.md:1-end`

**Interfaces:**

- Consumes: implemented `evaluate`, `audit`, `refresh-index`, provider fallback, and Bun pin.
- Produces: one documented install/health/evaluate/refresh/rollback sequence.

- [ ] **Step 1: Add failing version and local-only assertions**

Extend `validate_memory_policy`:

```python
combined = "\n".join(
    path.read_text(encoding="utf-8")
    for path in (
        ROOT / "README.md",
        ROOT / "ARCHITECTURE.md",
        providers,
        skill_root / "references" / "qmd-retrieval.md",
    )
)
for term in (
    "QMD 2.8.3",
    "local derived accelerator",
    "explicit maintenance",
    "no vault content is mirrored",
    "refresh-index --embed",
):
    require(term in combined, f"memory operations documentation omits: {term}")
```

- [ ] **Step 2: Verify documentation is incomplete**

```bash
python3 wiki/scripts/check.py --skip-tests
```

Expected: FAIL naming `QMD 2.8.3`.

- [ ] **Step 3: Add the exact operations sequence**

Document:

```markdown
1. Validate repository behavior with `python3 wiki/scripts/check.py` and
   `python3 scripts/plugins.py check`.
2. Install the exact Bun-owned QMD 2.8.3 pin with
   `python3 bun-global-tools/sync.py apply`; verify with `qmd --version`,
   `qmd status`, `qmd doctor`, and the deep Bun check.
3. Install changed local plugin content with
   `python3 scripts/plugins.py install --force`; verify exact live copies with
   `python3 scripts/plugins.py status`.
4. Run `providers --json`, `doctor --json`, `audit --json`, and the private
   `evaluate ... --json` suite before changing the derived index.
5. Run `refresh-index --embed` only as explicit maintenance, then repeat health,
   audit, and evaluation checks.
```

Also state:

- QMD caches and embeddings are disposable; Markdown/Git is recovery authority.
- No vault content is mirrored to Hermes or another external memory provider.
- QMD HTTP/MCP, project-local configuration, external source paths, and custom model URIs are not enabled.
- Rollback re-pins 2.5.3 through the Bun manifest, restores the prior plugin commit, and rebuilds the derived index without rewriting Markdown.
- Lifecycle hooks never run QMD model/index work, evaluator, or audit.

- [ ] **Step 4: Run documentation and repository checks**

```bash
python3 wiki/scripts/check.py
python3 scripts/plugins.py check
git diff --check
```

Expected: all checks pass.

- [ ] **Step 5: Commit operations documentation**

```bash
git add wiki/README.md wiki/ARCHITECTURE.md wiki/scripts/check.py \
  wiki/plugins/obsidian-memory/skills/obsidian-memory/references/qmd-retrieval.md \
  wiki/plugins/obsidian-memory/skills/obsidian-memory/references/recall-providers.md
git commit -m "docs(wiki): define local memory upgrade operations"
```

### Task 4: Run independent repository review and integration checkpoint

**Files:**

- Verify only; do not edit generated manifests or the vault in this task.

**Interfaces:**

- Consumes: all implementation commits from the three plans.
- Produces: fresh verification evidence and a reviewed branch eligible for integration.

- [ ] **Step 1: Run every non-mutating repository gate**

```bash
python3 wiki/scripts/check.py
python3 scripts/plugins.py check
python3 bun-global-tools/sync.py check --deep
git diff --check
git status --short
```

Expected: all commands exit 0 and the feature worktree is clean.

- [ ] **Step 2: Confirm version/catalog invariants and exclusion boundaries**

```bash
rg -n '"version": "1\\.0\\.0"' plugins.json \
  wiki/plugins/obsidian-memory/.claude-plugin/plugin.json \
  wiki/plugins/obsidian-memory/.codex-plugin/plugin.json
git diff 8caa826..HEAD --name-only | rg -i 'factorio|download\\.html' && exit 1 || true
git log --oneline --decorate 8caa826..HEAD
```

Expected: all local plugin versions remain 1.0.0; no Factorio or pre-existing `download.html` path is changed; history contains the approved design and planned global-memory commits only.

- [ ] **Step 3: Use Superpowers verification and code-review skills**

Invoke `superpowers:verification-before-completion`, then `superpowers:requesting-code-review`. The review scope is:

```text
Review 8caa826..HEAD for the approved local-first global memory upgrade.
Check exact-file Git isolation, source-aware/ambiguous supersession behavior,
evaluate/audit read-only bounds and no-body output, QMD 2.8.3 compatibility,
nine-provider research accuracy, hook non-regression, and Factorio exclusion.
Report only Blocker, Important, and Minor findings with file/line evidence.
```

Expected: no unresolved Blocker or Important findings. Fix findings with test-first commits and rerun Step 1.

- [ ] **Step 4: Integrate before live plugin activation**

Use `superpowers:finishing-a-development-branch` to integrate the reviewed branch into the branch chosen for live use. Do not run the force-install from a branch that will be discarded. Confirm the integrated checkout contains the reviewed HEAD and is clean.

### Task 5: Activate the plugin and validate the real local vault

**Files:**

- Local installed plugin copies only.
- Local derived QMD index only.
- Create beside the active local configuration: `evals/recall.json`.

**Interfaces:**

- Consumes: integrated repository implementation and QMD 2.8.3.
- Produces: matching live Codex/Claude plugin copies, a private uncommitted real-vault regression fixture, and refreshed derived embeddings.

- [ ] **Step 1: Force-install the unchanged-version local plugin**

From the integrated repository checkout:

```bash
python3 scripts/plugins.py install --force
python3 scripts/plugins.py status
```

Expected: installation succeeds for both agents and status reports no live-copy drift.

- [ ] **Step 2: Create the private real-vault fixture in local configuration**

Resolve the active configuration with `config_path()`, create its sibling
`evals/` directory if needed, and use `apply_patch` to create
`evals/recall.json`. Do not use shell redirection, put the file in the vault, or
commit its machine-specific absolute path. The file content is:

```json
{
  "schema_version": 1,
  "cases": [
    {
      "id": "dev-cockpit-current-sidebar-decision",
      "query": "consistent sidebar disclosure hierarchy",
      "mode": "hybrid",
      "provider": "auto",
      "scope": "projects/dev-cockpit",
      "top": 3,
      "max_tokens": 900,
      "expected_paths": [
        "projects/dev-cockpit/decisions/0020-keep-ziti-proxy-in-primary-workspace-navigation.md"
      ],
      "any_of_paths": [],
      "forbidden_paths": [
        "projects/dev-cockpit/decisions/0017-consistent-sidebar-disclosure-hierarchy.md",
        "projects/dev-cockpit/decisions/0018-unified-quiet-sidebar-disclosures.md",
        "projects/dev-cockpit/decisions/0019-task-oriented-sidebar-information-architecture.md"
      ],
      "allow_degraded": false
    }
  ]
}
```

This fixture stays in local configuration and is never copied into either Git
repository.

- [ ] **Step 3: Run pre-refresh health, audit, and evaluation**

```bash
MEMORY_CONFIG_FILE="${OBSIDIAN_MEMORY_CONFIG:-$HOME/.config/obsidian-memory/config.json}"
MEMORY_EVAL_FILE="$(dirname "$MEMORY_CONFIG_FILE")/evals/recall.json"
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py providers --json
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py doctor --json
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py audit --json
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  evaluate "$MEMORY_EVAL_FILE" --json
```

These task-specific variables resolve the default or configured local state
file and must not be written to repository or vault files.

Expected: providers/doctor identify Markdown as canonical and QMD 2.8.3 as healthy; evaluator passes and returns decision 0020 while excluding 0017-0019. Audit may report pre-existing governance warnings or the intentionally unresolved shorthand, but it must not crash, print bodies, traverse private paths, or report a new safety error caused by the upgrade.

- [ ] **Step 4: Refresh the derived index explicitly**

```bash
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py refresh-index --embed
qmd status
qmd doctor
```

Expected: update and incremental embedding complete; current documents use the current embedding fingerprint; QMD remains healthy.

- [ ] **Step 5: Repeat the private regression and hook-budget checks**

```bash
MEMORY_CONFIG_FILE="${OBSIDIAN_MEMORY_CONFIG:-$HOME/.config/obsidian-memory/config.json}"
MEMORY_EVAL_FILE="$(dirname "$MEMORY_CONFIG_FILE")/evals/recall.json"
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  evaluate "$MEMORY_EVAL_FILE" --json
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py doctor --json
python3 scripts/plugins.py status
```

Expected: evaluator still passes with no unexpected degradation; doctor reports focused context within 420 estimated tokens and recall limit 900; live plugin status remains exact.

### Task 6: File the accepted global-memory decision and completion evidence

**Files:**

- Create in vault: `projects/claude-obsidian-setup/decisions/0009-local-first-memory-hardening-and-evaluation.md`
- Create in vault: `projects/claude-obsidian-setup/journal/2026-08-26.md`
- Modify in vault: `projects/claude-obsidian-setup/decisions/_index.md`
- Modify in vault: `projects/claude-obsidian-setup/README.md`
- Modify in vault: `projects/claude-obsidian-setup/tasks/TODO.md`
- Modify in vault: `wiki/log.md`
- Modify in vault: `wiki/hot.md`
- Commit in vault: only these seven Markdown files

**Interfaces:**

- Consumes: fresh evidence from Task 5.
- Produces: accepted immutable DDR 0009, a truthful project/log record, and exact-file Git history.

- [ ] **Step 1: Create DDR 0009 through the Obsidian skills**

Read and use `obsidian-memory:obsidian-memory`, `claude-obsidian:wiki-cli`, and `claude-obsidian:obsidian-markdown`. Create:

```markdown
---
type: decision
id: 0009
title: "Harden local-first memory and make retrieval measurable"
status: accepted
date: 2026-08-26
deciders:
  - david.david
project: claude-obsidian-setup
supersedes: ""
superseded_by: ""
memory_class: decision
confidence: high
valid_from: 2026-08-26
updated: 2026-08-26
source:
  - repository design docs/superpowers/specs/2026-08-26-global-memory-upgrade-design.md
  - https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers
  - https://github.com/tobi/qmd
verified_by: "repository gates, live QMD health, private retrieval evaluation, and read-only vault audit"
tags:
  - decision
  - ddr
  - obsidian-memory
  - retrieval
  - evaluation
---

# 0009 — Harden local-first memory and make retrieval measurable

> Design Decision Record. Immutable once `accepted`.

## Status

Accepted.

## Context

The provider-backed design was working, but normal sibling `superseded_by`
links were interpreted from the vault root, automatic commits needed exact-file
isolation, QMD 2.5.3 predated relevant path/trust fixes, and retrieval quality
had no executable local regression contract.

All nine currently available Hermes provider choices were independently checked
at source/contract level. None justified giving a second database or hosted
service write authority over this vault.

## Decision

- Keep Obsidian Markdown plus Git as the sole writable canonical memory.
- Keep QMD 2.8.3 as a local, disposable recall accelerator.
- Resolve supersession from the source note, fail closed on ambiguous or unsafe
  routes, and never guess partial identifiers.
- Commit only exact eligible Markdown files and preserve unrelated index state.
- Use the read-only `evaluate` command for retrieval expectations and `audit`
  for governance, routing, and provider health.
- Keep evaluation, audit, refresh, embedding, and model work out of lifecycle
  hooks.
- Do not mirror vault content, transcripts, or tool traces to external memory
  providers.

## Evidence

- Repository wiki, workspace plugin, Bun, diff, and live-copy gates passed.
- QMD 2.8.3 status and doctor checks passed against the local derived index.
- The private regression followed sibling decisions 0017 → 0018 → 0019 → 0020,
  returned accepted decision 0020, and excluded the three superseded notes.
- The audit completed read-only with bounded path/code output and no note bodies.
- Focused startup and recall remained within their configured token budgets.

## Consequences

Memory remains portable, inspectable, and recoverable from Markdown/Git while
retrieval and governance regressions become executable. Rich graph or temporal
providers remain deferred until a measured local failure justifies a
synthetic-data pilot.

Related: [[0008-provider-backed-recall]],
[[0007-progressive-memory-disclosure]],
[[0005-obsidian-canonical-qmd-retrieval]].
```

Do not mark 0008 superseded; 0009 refines it.

- [ ] **Step 2: Update project navigation and stale task state**

Apply these exact content changes through Obsidian transport:

- prepend the README key-decision list with `[[decisions/0009-local-first-memory-hardening-and-evaluation|0009 — Harden local-first memory and make retrieval measurable]]`;
- append decision-index row `| [[0009-local-first-memory-hardening-and-evaluation|0009]] | Harden local-first memory and make retrieval measurable | accepted | 2026-08-26 |`;
- remove the backlog line that says to consider a Stop-hook commit lock;
- add under Done: `- [x] Harden Stop-hook commits with a lock, exact Markdown paths, literal pathspecs, and unrelated-index preservation (2026-08-26)`;
- set the project README, decision index, and task frontmatter `updated` value to `2026-08-26`.

- [ ] **Step 3: Create the journal and global log entry**

Create `journal/2026-08-26.md`:

```markdown
---
type: journal
project: claude-obsidian-setup
date: 2026-08-26
status: complete
tags:
  - journal
  - obsidian-memory
---

# 2026-08-26 — Local-first global memory upgrade

- Kept Markdown/Git canonical and upgraded the local QMD accelerator to 2.8.3.
- Corrected source-relative supersession and exact-file commit isolation.
- Added read-only retrieval evaluation and governance/routing audit commands.
- Independently checked all nine Hermes provider choices; none was adopted.
- Verified the real 0017 → 0020 sibling chain, provider health, token budgets,
  repository gates, and exact live plugin copies.

Decision: [[../decisions/0009-local-first-memory-hardening-and-evaluation]].
```

Prepend to `wiki/log.md`:

```markdown
## 2026-08-26 — build: harden and measure local-first global memory

- Kept Obsidian Markdown + Git canonical; upgraded the derived QMD accelerator
  to 2.8.3 without adding a hosted provider or second writable database.
- Added exact-file commit isolation, source-aware supersession, executable local
  recall evaluation, and bounded read-only governance/routing audit.
- Independently checked all nine Hermes provider choices and recorded the
  source-level validation boundary.
- Verified the real sibling supersession regression, repository/plugin/Bun
  gates, token budgets, QMD health, and exact installed copies.
- Decision: [[projects/claude-obsidian-setup/decisions/0009-local-first-memory-hardening-and-evaluation]].
```

Update `wiki/hot.md` so the latest paragraph summarizes DDR 0009 and the passing real-vault regression. Preserve the existing latest paragraph verbatim as the first item under `Prior:`; do not edit any linked project note or alter that paragraph's factual text.

- [ ] **Step 4: Validate links and commit only exact vault files**

Run the plugin's explicit commit command with one repeatable `--path` for each of:

```text
projects/claude-obsidian-setup/decisions/0009-local-first-memory-hardening-and-evaluation.md
projects/claude-obsidian-setup/decisions/_index.md
projects/claude-obsidian-setup/README.md
projects/claude-obsidian-setup/tasks/TODO.md
projects/claude-obsidian-setup/journal/2026-08-26.md
wiki/log.md
wiki/hot.md
```

Before committing, use Obsidian search/backlink checks to confirm DDR 0009 links resolve and no unrelated vault file is staged. Expected after commit: these exact seven Markdown files are in the new vault commit; unrelated working-tree/index state is unchanged. The local JSON evaluation fixture remains outside the vault and uncommitted.

- [ ] **Step 5: Run final live evidence checks**

```bash
MEMORY_CONFIG_FILE="${OBSIDIAN_MEMORY_CONFIG:-$HOME/.config/obsidian-memory/config.json}"
MEMORY_EVAL_FILE="$(dirname "$MEMORY_CONFIG_FILE")/evals/recall.json"
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  evaluate "$MEMORY_EVAL_FILE" --json
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py doctor --json
python3 scripts/plugins.py status
python3 bun-global-tools/sync.py check --deep
```

Expected: evaluator passes, doctor reports healthy bounded local memory, installed plugin copies match, and Bun/QMD deep checks pass. Use `superpowers:verification-before-completion` before making the completion claim.
