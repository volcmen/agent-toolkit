# Factorio Chat Knowledge Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distill the verified conversation and ARIA audit into governed,
current, selectively retrievable Obsidian memory.

**Architecture:** Keep the transcript outside the vault; create one candidate
source summary and one verified project episode, then refresh project routing
notes and indexes. Commit through exact `--path` arguments and refresh the
derived QMD index only after canonical Markdown is committed.

**Tech Stack:** Obsidian Markdown, Git, the obsidian-memory Python helper, and
QMD incremental indexing.

**Spec:** `wiki/docs/superpowers/specs/2026-08-26-factorio-chat-knowledge-sync-design.md`

## Global Constraints

- Do not store the raw conversation, secrets, unrelated source-panel entries, or machine-local paths.
- Conversation-derived tool claims remain candidate; only repository/test/official-source facts may be verified.
- Use `https://github.com/volcmen/factorio-ai` as the stable repository locator.
- Preserve accepted DDRs and historical journal episodes.
- Distinguish local `main` from unmerged feature branches and do not claim integration that did not occur.
- Commit exactly the intended Markdown paths and no unrelated dirty vault file.
- Do not launch Factorio, push a repository, install plugins, or run a mutating wiki release/update operation.

---

### Task 1: Write and verify the governed Factorio knowledge batch

**Files:**

- Create: `wiki/sources/2026-08-26-chatgpt-factorio-bot-distillation.md`
- Create: `projects/factorio-bot/journal/2026-08-26.md`
- Modify: `projects/factorio-bot/README.md`
- Modify: `projects/factorio-bot/tasks/TODO.md`
- Modify: `wiki/index.md`
- Modify: `wiki/log.md`
- Modify: `wiki/hot.md`

**Interfaces:**

- Consumes: final verified ARIA branch/main identities, browser capture IDs and
  digests, official source URLs, and current vault routing conventions.
- Produces: governed Markdown discoverable through project links and QMD recall.

- [ ] **Step 1: Reconfirm clean vault and final project evidence**

Run `git status --short` in the vault and stop on any unrelated dirty path.
Record current ARIA main and feature-branch heads, the exact final offline test
results, and whether either branch was integrated. Do not infer status from the
conversation or old vault note.

- [ ] **Step 2: Create the candidate source distillation**

Use frontmatter `type: source`, `status: candidate`,
`source_type: user-provided-conversation-distillation`, `confidence: medium`,
`created`, `updated`, `observed`, `url`, and source/Factorio/knowledge tags.
Include:

- four rendered messages and their IDs/digests as capture-integrity metadata;
- a statement that hidden model state was unavailable and the raw transcript
  was deliberately not retained;
- the useful layered-knowledge and deterministic-controller conclusions;
- the project adjudication: adopt the principles, defer the broad Workbench,
  do not add OpenWiki to ARIA now, keep QMD as the existing optional index, and
  treat Vouch/OpenViking only as future pilots;
- links to current official Factorio API, OpenWiki, Vouch, and QMD sources; and
- a clear separation of verified facts from candidate recommendations.

- [ ] **Step 3: Create the verified project episode**

Use project journal frontmatter with `memory_class: episode`, `status:
verified`, `confidence: high`, stable Git/source locators, `observed`, and an
exact `verified_by`. Summarize audit outcome, implementation/review state,
tests, no-launch boundary, and a concrete Resume section. Link the source note
and existing accepted DDRs; do not create or revise a decision record.

- [ ] **Step 4: Refresh project routing notes**

Update the project README date, stable repository URL, exact main versus branch
status, active P0--P7/inert-P8 boundary, research bridge blocker, and immediate
review/integration step. Add one current Controller Authority Slice 1A task at
the top of TODO with `Next:` and `(updated 2026-08-26)`. Preserve older active,
backlog, historical, and done entries.

- [ ] **Step 5: Refresh indexes and hot cache**

Add one source link under `wiki/index.md` Sources. Prepend one concise
2026-08-26 entry to `wiki/log.md`. Replace the hot cache's latest item with the
current Factorio resume state and retain the prior Dev Cockpit item as the
first `Prior` bullet without copying its full task body.

- [ ] **Step 6: Validate content and exact mutation scope**

Check every new/changed note for YAML delimiters, required fields, selective
wikilinks, absence of absolute `/Users/` paths in the new source/journal and
updated README/TODO entries, and absence of raw transcript passages. Run `git
diff --check` and inspect `git diff --` for exactly the seven paths.

- [ ] **Step 7: Commit through exact validated path arguments**

Run from the Personal AI repository after the hardening plan is complete:

```sh
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py commit \
  --path wiki/sources/2026-08-26-chatgpt-factorio-bot-distillation.md \
  --path projects/factorio-bot/journal/2026-08-26.md \
  --path projects/factorio-bot/README.md \
  --path projects/factorio-bot/tasks/TODO.md \
  --path wiki/index.md \
  --path wiki/log.md \
  --path wiki/hot.md
```

Verify the resulting commit contains exactly the seven intended paths and the
vault is clean. Do not use the broad default Stop commit.

- [ ] **Step 8: Refresh and verify QMD recall**

Run:

```sh
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py refresh-index --embed
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py recall \
  "Factorio Bot ARIA controller authority" --scope projects --mode hybrid
```

Expected: refresh exits zero and governed recall returns the current Factorio
project/journal without exposing private or unrelated paths.
