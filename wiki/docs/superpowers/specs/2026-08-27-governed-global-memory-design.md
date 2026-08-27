# Governed Global Memory Design

**Date:** 2026-08-27  
**Status:** Approved for implementation planning  
**Owner:** David David  
**Implementation owner:** `wiki/plugins/obsidian-memory` with workspace installer integration

## Purpose

Turn the existing shared-memory plugin into an explicit, governed global-memory
system for Codex and Claude Code without creating a second canonical store or
promoting project state into David's global profile.

The existing Obsidian Markdown vault and Git history remain the writable
authority. This design focuses on the portable plugin contract, deterministic
validation, privacy boundaries, cross-agent installation, and retrieval
semantics. Obsidian remains a storage and editing surface rather than the
architectural focus.

## Evidence and authority

The linked ChatGPT conversation was inspected completely through the rendered,
authenticated browser page. Its relevant message boundaries are:

- `b66c4b7a-5650-40ff-992a-8ea33a56f553`: assistant-recommended Workbench and
  tool architecture;
- `ba3e56c4-1b4d-49f9-8c29-b4af489bd6b4`: David's explicit request for a
  global-memory improvement prompt;
- `67d1ff8a-5d80-469d-943a-e0b4a17354a5`: assistant-authored Global Memory
  Curator prompt;
- `bbe36637-9215-4b46-8b41-14f53e519a13`: David's House of Leaves project
  prompt request;
- `e0ae76a5-fe37-435a-9705-f3fe5122bb1a`: assistant-authored project upgrade
  prompt.

David subsequently supplied the Global Memory Curator prompt as the governing
request, marked it `lgtm`, requested a fresh global implementation audit, and
selected this design's governed-layer option. That approves the curator's
global-memory principles for implementation. It does not turn every tool or
Workbench recommendation from `b66c4b7a-...` into an adopted architecture.

## Current-state findings

- `obsidian-memory@ai-workspace` is installed and enabled in both Codex and
  Claude Code, and its live bytes match the repository.
- Claude Code receives the shared policy through
  `~/.claude/rules/obsidian-vault.md`.
- Codex currently has neither `~/.codex/AGENTS.md` nor
  `~/.codex/AGENTS.override.md`; therefore it does not receive the equivalent
  managed global policy.
- `scripts/plugins.py status` verifies marketplace and plugin state but does not
  verify the product-specific global guidance.
- The existing governance audit is strong for generic `fact`, `decision`, and
  `heuristic` records, but it does not enforce a global record's ID, scope,
  category, evidence type, stability, sensitivity, or destination.
- Recall filters stale and temporally invalid notes but does not enforce
  sensitivity metadata.
- The vault currently has one explicit `global.*` record, the Agent Toolkit
  project-registry pointer.
- The repository's 156 wiki tests pass. The real vault audit has seven
  pre-existing governance errors unrelated to this proposed global namespace.

## Design principles

1. One canonical memory system: Markdown plus Git.
2. Global memory is the smallest durable cross-project layer, not a biography.
3. Project knowledge remains isolated under its owning project.
4. Retrieval relevance never grants authority.
5. Assistant recommendations and inference remain proposals until David
   confirms them or independent evidence supports the appropriate non-personal
   fact.
6. Sensitive memory is opt-in and narrowly scoped.
7. Global defaults can be overridden locally without mutating the global
   record.
8. Installation success means both agents receive the current plugin and the
   intended global policy.
9. All applied changes are reviewable and reversible.

## Logical layout

Add an isolated logical namespace inside the existing canonical vault:

```text
wiki/global/
├── README.md
└── records/
    ├── approval-policy/
    ├── communication/
    ├── identity/
    ├── operating-principle/
    ├── preference/
    ├── privacy/
    ├── project-registry/
    ├── recurring-goal/
    └── technical-environment/
```

This is not a new database or second memory product. Human-readable Markdown
and structured frontmatter remain one representation. Empty category
directories do not need to be created.

`wiki/global/README.md` explains the boundary and links active records. It must
not aggregate sensitive record bodies into a broad profile.

## Global record contract

Use flat frontmatter compatible with the existing inert parser:

```yaml
---
id: global.project_registry.agent_toolkit
type: entity
memory_class: fact
scope: global
owner: david
category: project_registry
statement: "Agent Toolkit is David's active cross-agent plugin workspace."
status: verified
evidence_type: environment_verified
source:
  - "repository README at an exact revision"
confidence: high
stability: review_periodically
sensitivity: internal
observed: 2026-08-27
valid_from: 2026-07-28
valid_until:
supersedes:
superseded_by:
retrieval_tags:
  - agent-toolkit
verified_by: "local repository and installed-state checks"
---
```

The body may explain the record and provide locators, but the `statement`
field is the one atomic durable proposition.

### Required fields

- `id`: unique and shaped as `global.<category>.<stable-name>`;
- `scope`: exactly `global`;
- `owner`: exactly `david` for this installation;
- `category`: one recognized global category;
- `statement`: one bounded, non-empty scalar proposition;
- `status`: an existing governed status;
- `evidence_type`: one recognized evidence class;
- `source`: at least one non-empty source reference;
- `confidence`;
- `stability`;
- `sensitivity`;
- `observed`.

Current records continue to require existing `verified_by` rules. Optional
validity and supersession fields retain their current semantics.

### Categories

Recognized categories are:

- `identity`
- `communication`
- `operating_principle`
- `approval_policy`
- `technical_environment`
- `recurring_goal`
- `project_registry`
- `privacy`
- `preference`
- `constraint`

Directory names may use hyphens for readability; frontmatter categories use
underscores.

### Evidence types

Recognized evidence types are:

- `user_stated`
- `user_confirmed`
- `repeated_user_pattern`
- `environment_verified`
- `assistant_recommended`
- `inferred`

`assistant_recommended` and `inferred` records may only be `candidate` or
`proposed`. They cannot be current (`verified`, `accepted`, or `active`). A
retrieved page or generated summary cannot verify itself.

### Stability and sensitivity

Stability is one of `durable`, `review_periodically`, or `time_sensitive`.
Time-sensitive records require a validity bound or an explicit review date
supported by the final implementation's schema.

Sensitivity is one of `public`, `internal`, `private`, or `restricted`.

## Scope and contamination rules

- Files below the configured global root must declare `scope: global` and a
  valid `global.*` ID.
- A `global.*` ID outside the global root is a misplaced record and fails the
  global audit. The one existing Agent Toolkit record will be migrated.
- Project implementation state, current tasks, branches, bugs, tests, media
  variants, conversations, and local authority hierarchies remain under
  `projects/<project>/` or session-local storage.
- A global project-registry record stores a compact pointer, not duplicated
  project architecture or status history.
- A project override affects only that project. It never rewrites the global
  default automatically.
- No project run may promote a candidate globally merely because its project
  files repeat or recommend it.

## Resolution order

Agents use this precedence:

```text
system and safety policy
  > latest explicit user instruction
  > explicit project-local authority and policy
  > approved global defaults
  > project-derived context
  > agent inference
```

The plugin documents this order. It does not attempt to override host-system
policy mechanically.

## Curator workflow

Add a dedicated `global-memory` skill to the existing plugin. It triggers for
global-memory creation, audit, promotion, correction, and cleanup.

The skill must:

1. inspect the existing system before editing;
2. classify evidence as user-stated, user-confirmed, assistant-recommended,
   project-specific, temporary, inferred, sensitive, or stale/conflicted;
3. generate explicit operations such as `ADD`, `UPDATE`, `SUPERSEDE`,
   `MOVE_TO_PROJECT`, and `NEEDS_REVIEW`;
4. apply only safe, explicit, non-sensitive, non-conflicting global changes;
5. preserve uncertain or assistant-originated items as proposals;
6. make minimal reversible changes;
7. validate the result and report exact evidence.

The skill will contain the operational reasoning and reporting contract. The
Python implementation will validate deterministic invariants; it will not try
to infer whether prose is psychologically true or globally useful.

## Deterministic audit

Extend the existing read-only `audit` command with global governance checks
rather than creating a second audit engine. The JSON report remains bounded and
does not expose frontmatter values or note bodies.

New findings include, at minimum:

- duplicate global ID;
- malformed global ID;
- missing or invalid global scope;
- misplaced global record;
- missing or invalid category;
- missing or invalid evidence type;
- missing statement;
- missing or invalid stability;
- missing or invalid sensitivity;
- assistant/inferred record promoted to a current status;
- time-sensitive record without sufficient temporal qualification;
- global root missing or unsafe when configured.

The existing generic governance checks remain active. Global validation adds a
specialized layer; it does not replace the fact/decision/heuristic matrix.

## Retrieval and privacy

- `public` and `internal` records may participate in ordinary governed recall.
- `private` and `restricted` records are excluded by default.
- Access to sensitive records requires an explicit CLI flag and an explicit
  safe scope rooted at or below the requested sensitive domain.
- An unscoped `--include-sensitive` request fails closed.
- Lifecycle startup does not inject global record bodies. It emits only a small
  route indicating where approved global defaults can be recalled.
- Scope and sensitivity filtering occur after provider discovery and before any
  L1 content reaches the model. Both native and QMD paths share the same final
  enforcement.
- QMD remains local and derived; ranking does not alter sensitivity or
  authority.

## Configuration

Add portable local settings with safe defaults:

```json
{
  "global_memory_root": "wiki/global",
  "include_sensitive_by_default": false
}
```

`include_sensitive_by_default` is fixed to `false` by validation for this
release; it exists only if needed for explicitness. Prefer omitting a setting
that can never safely be true if the implementation can express the invariant
more simply.

The configured global root must be vault-relative, non-private, non-symlinked,
and contained by an active recall root.

## Cross-agent installation parity

The integration must satisfy both product contracts:

- Claude Code receives the shared policy through its dedicated global rules
  path.
- Codex receives the same bounded policy in the managed block of
  `~/.codex/AGENTS.md`, preserving unrelated user guidance.
- The workspace installation path must repair or clearly fail when a configured
  memory plugin is live but its global guidance is missing.
- Status must distinguish plugin installation from global-guidance health.
- Initial setup may still require an explicit vault path. Subsequent forced
  installs must be able to reuse the existing local configuration without
  recursively reinstalling products.
- Changes take effect in newly started Codex and Claude Code sessions.

Implementation should keep the wiki project responsible for its setup logic.
The workspace installer may invoke a narrow project-owned integration command
or consume a declarative integration entry; it should not duplicate the memory
installer's policy-writing code.

## Migration

The initial migration is intentionally small:

1. Create `wiki/global/README.md`.
2. Move the existing Agent Toolkit registry record to
   `wiki/global/records/project-registry/agent-toolkit.md`.
3. Update its inbound index links.
4. Preserve its stable ID, provenance, history, and project-local pointer.
5. Add fields required by the final global schema only when supported by the
   existing evidence.

Do not automatically create identity, preference, approval, health, finance,
dating, employment, or other personal records during the migration. Candidate
global principles from the linked assistant response remain unstored unless
David's explicit instructions independently support them.

The seven existing vault audit errors remain separate remediation items unless
the implementation mechanically touches the same records.

## Rejected scope

This implementation does not add or adopt:

- Restate or another workflow controller;
- OpenWiki as authority;
- Vouch as a new dependency;
- Basic Memory as a second canonical store;
- OpenViking or automatic agent evolution;
- a vector database beyond the existing disposable QMD index;
- automatic external actions or paid API use;
- automatic approval of durable knowledge;
- a broad personal biography.

These were recommendations or future candidates in the linked conversation,
not required dependencies for governed global memory.

## Validation and acceptance criteria

Implementation is complete only when all of the following hold:

1. Existing repository and plugin checks pass.
2. New unit tests cover every global schema boundary and privacy branch.
3. Duplicate IDs and global/project contamination fail deterministically.
4. Assistant-recommended or inferred current records fail the audit.
5. Private/restricted recall fails closed without both explicit permission and
   a narrow scope.
6. Native and QMD result compaction enforce the same sensitivity decision.
7. The migrated Agent Toolkit record passes the global audit and remains
   retrievable by its stable ID.
8. No new unverified personal fact is promoted.
9. `python3 wiki/scripts/check.py` passes.
10. `python3 scripts/plugins.py check` passes.
11. `python3 scripts/plugins.py install --force` refreshes both live copies and
    repairs the global policy integration.
12. `python3 scripts/plugins.py status` reports both plugin bytes and guidance
    parity.
13. A fresh Codex run reports the managed global policy and project override in
    the documented order.
14. A fresh Claude Code run can discover the same global-memory skill and
    policy.
15. Live provider, doctor, audit, and targeted retrieval checks report exact
    outcomes; pre-existing unrelated audit failures remain explicitly
    separated.
16. Repository and vault changes are committed separately and can be reverted
    independently.

## Rollback

- Revert the implementation commit to restore prior plugin behavior.
- Force-install the restored plugin bytes for both agents.
- Run the project-owned guidance installer to restore the previous managed
  policy block.
- Revert the separate vault migration commit to restore the prior record path
  and links.
- QMD remains derived; refresh it only as an explicit maintenance action after
  the canonical Markdown rollback.

