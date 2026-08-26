# Factorio Chat Knowledge Sync Design

## Goal

Preserve the useful, approved conclusions from the 2026-08-26 ChatGPT
conversation and the current ARIA audit without turning an untrusted transcript
or speculative tool stack into durable authority.

## Authority model

- The rendered conversation is a source to distill, not an authority and not a
  raw vault artifact.
- Current repository files, exact Git identities, deterministic tests, and
  official Factorio documentation verify project facts.
- Tool comparisons and future adoption ideas remain `candidate` unless tested
  locally and explicitly accepted.
- The Factorio repository remains authoritative for changing product state;
  the vault stores a concise status, stable repository locator, decisions, and
  resume context.

## Durable artifacts

Create one source note at
`wiki/sources/2026-08-26-chatgpt-factorio-bot-distillation.md`. It records the
conversation URL, capture date, four rendered message IDs and SHA-256 digests,
redaction policy, compact synthesis, primary-source cross-checks, and
project-specific adjudication. It contains no raw transcript, unrelated source
panel entries, credentials, or machine-local path.

Create `projects/factorio-bot/journal/2026-08-26.md` as a verified episode. It
distinguishes main-branch facts from the separately owned Controller Authority
Slice 1A candidate, records offline verification only, and states that Factorio
was not launched.

Refresh the Factorio project README and TODO to the exact current state. Replace
the README's absolute repository path with the stable HTTPS repository URL and
exact commit identity. Accepted DDRs and historical journal episodes are not
rewritten merely to remove old path-shaped provenance.

Add the source note to `wiki/index.md`, prepend a concise operation entry to
`wiki/log.md`, and update `wiki/hot.md` so future sessions resume the active
Factorio work without replaying the conversation.

## Commit safety

Before mutation, require the vault worktree to be clean. Use the explicit
commit helper's repeatable `--path` arguments for only the exact changed files.
Never run the broad configured Stop commit for this batch. Review the exact
staged/committed path list and refresh QMD
incrementally with embeddings after the Markdown commit.

## Completion boundary

The sync is complete only when the new notes contain governed frontmatter,
repository-derived claims match the final reviewed branch state, the raw chat
is absent, the exact vault commit contains only intended files, QMD refresh
passes, and recall finds the new Factorio source/project notes.
