# Local-First Global Memory Upgrade Design

## Status and decision

**Approved direction:** harden and measure the existing local Obsidian memory
system. Obsidian Markdown and Git remain the only writable canonical memory.
QMD remains a disposable, local retrieval accelerator. No external memory
provider receives vault content, conversation transcripts, tool traces, or
credentials.

This design covers the global memory integration under `wiki/` and the pinned
QMD CLI under `bun-global-tools/`. It explicitly excludes Factorio projects,
branches, notes, and implementation work.

The upgrade has five deliverables:

1. Upgrade the pinned QMD CLI from 2.5.3 to 2.8.3.
2. Resolve Obsidian supersession links relative to their source notes without
   weakening vault, recall-root, or scope boundaries.
3. Make automatic and explicit vault commits exact-file operations that cannot
   absorb unrelated staged or private content.
4. Add an executable, local recall evaluation for provider selection,
   degradation, result governance, and retrieval expectations.
5. Add a read-only governance audit that reports actionable memory defects
   without treating all legacy Markdown as malformed or rewriting the vault.

## Context and observed gaps

The current architecture is sound: a small L0 session capsule routes to bounded
L1 recall results, then an agent opens only relevant canonical L2 Markdown.
`auto` recall can use QMD and visibly fall back to the standard-library native
provider. The vault is approximately hundreds, not millions, of notes, so a
second writable service would add reconciliation and privacy costs before a
measured need.

A read-only audit on 2026-08-26 established the following baseline:

- The live QMD index covered 475 configured Markdown documents and reported
  current embeddings. Native, semantic, and hybrid recall paths all returned
  bounded results, and `auto` exposed provider degradation when it fell back.
- The focused session capsule was estimated at 293 tokens versus 1,523 for the
  comparable full context, an 80.8% reduction, under the existing budgets.
- QMD 2.5.3 was installed and pinned. QMD 2.8.3 contains relevant upstream
  protections for untrusted project-local configuration, external paths and
  model URIs, symlink/glob indexing escapes, and MCP HTTP host/origin checks,
  plus search and collection correctness fixes.
- Supersession works for vault-root-qualified links but fails for common
  Obsidian sibling links such as `[[0018-decision]]`. A real decision chain was
  filtered as stale without returning its accepted successor because the
  resolver interpreted every target from the vault root.
- Of ten meaningful non-empty `superseded_by` references sampled across the
  configured roots, three resolved from the vault root, six resolved only from
  their source-note directory, and one shorthand target remained unresolved.
  The unresolved shorthand must be reported, not guessed by prefix.
- A broad Markdown lint produced many apparent metadata, link, orphan, and
  empty-heading findings, but legacy pages, generated drawings, indexes, logs,
  and intentionally terse notes made many of them non-actionable. Global
  memory health therefore needs a governance-aware audit, not blanket edits.

The audit did not mutate the vault or its index.

## Requirements and invariants

- The system is fully local-first. Vault bodies, queries, tool traces, raw
  transcripts, credentials, and provider payloads are not sent to a hosted
  memory service.
- Obsidian Markdown plus Git is the sole writable canonical authority. QMD
  caches, models, embeddings, and benchmark output are derived and rebuildable.
- Retrieved text remains untrusted reference data. Ranking, similarity, or a
  provider assertion never grants instruction authority.
- Lifecycle hooks remain bounded. They do not load embedding or reranking
  models, refresh indexes, run evaluations, or scan the whole vault.
- Existing startup and recall token budgets, provider failover visibility, and
  safe recall roots remain compatible unless a test proves a deliberate
  change.
- Recall, redirect, evaluation, audit, and commit paths reject private or
  dot-prefixed segments, symlink escapes, non-Markdown targets, and paths
  outside their configured boundaries.
- Automatic Git commits include only exact eligible Markdown files under the
  configured commit paths. Unrelated working-tree and index state is preserved.
- Configuration and repository artifacts contain no machine-specific vault
  paths or secrets.
- Installation uses Bun for QMD. It does not use `npm install --global`.
- Existing accepted decision records are not rewritten. New design knowledge
  is additive and links to the evidence it refines.

## Considered approaches

### 1. Harden the local canonical system — selected

Keep the current Markdown/Git authority, upgrade the derived QMD dependency,
correct supersession semantics, harden exact commits, and add executable
quality and governance checks.

This addresses defects observed in the real system while keeping recovery as
simple as Git plus a rebuildable index. It preserves portability between Codex
and Claude Code and avoids a new service, account, synchronization protocol,
or deletion contract.

### 2. Shadow an external provider

Mirror admitted memory into a provider only for comparison while leaving
Markdown canonical. This could measure graph, temporal, or personalization
quality, but it still duplicates private content, creates consistency and
deletion obligations, and requires a representative evaluation before its
results are meaningful.

This is deferred. Hindsight is the strongest future pilot candidate if local
evaluations demonstrate a persistent multi-hop or temporal recall failure that
frontmatter links and QMD cannot solve. Any pilot would use synthetic or
explicitly approved data, never the live vault by default.

### 3. Adopt an external provider as primary memory

Replace or subordinate Markdown with a cloud or self-hosted memory database.
This would offer richer extraction or graph behavior, but it breaks the simple
auditable authority model and adds migration, service availability, privacy,
reconciliation, and rollback costs without evidence that they improve the
current workload.

This is rejected for this upgrade.

## Architecture

```text
explicit durable write
        |
        v
Obsidian Markdown ---- exact-file Git commit
   canonical L2              |
        |                     v
        +---- explicit QMD refresh/embed
        |             local derived index
        |                     |
        +----- native --------+---- QMD
                    recall provider selection
                              |
                              v
                 governance + scope filtering
                              |
                              v
                   bounded untrusted L1 hits
```

`evaluate` exercises the provider-selection and governed-result boundary.
`audit` inspects canonical metadata and routing integrity. Neither writes the
vault, refreshes QMD, commits files, or runs from a lifecycle hook.

### QMD supply-chain and security upgrade

`bun-global-tools/manifest.json` will pin `@tobilu/qmd` to exactly `2.8.3`.
The workspace synchronizer remains the installation authority; no parallel npm
installation or project-local package declaration is added.

The upgrade must be tested against the existing wrapper commands and current
collection configuration before live activation. Required checks include QMD
version, status, doctor, lexical/semantic/hybrid wrapper recall, scoped recall,
and provider fallback. A real index refresh and embedding pass happen only as
an explicit post-install maintenance step, never in hooks or ordinary checks.

The integration continues to invoke the local QMD CLI. It does not enable the
QMD HTTP/MCP server as part of this work. Project-local QMD configuration,
external source paths, and custom model URIs are outside the managed design and
must not be silently trusted.

### Exact-file Git commit safety

The previous hardening work from commits `d8782b4` through `3c4bc2b` may be
integrated commit-by-commit or reproduced with equivalent reviewed changes.
The unrelated later Factorio documentation commit must not be included.

The commit implementation will:

- enumerate configured commit roots without following symlinks;
- select only eligible `.md` files, matched case-insensitively;
- reject dot-prefixed/private path segments after lexical and resolved-path
  checks;
- reject directories and deleted directory prefixes rather than broadening a
  pathspec;
- pass Git literal pathspecs and explicit exact file paths;
- create the commit with those exact paths so unrelated staged changes cannot
  enter it;
- preserve unrelated working-tree and index state on success and failure; and
- serialize commits with the existing lock and keep hook output valid and
  bounded.

A filename containing a literal carriage return may conservatively fail
closed; supporting such names is not required for this upgrade. Tests must
prove that the index and HEAD are preserved when validation rejects a target.

### Source-aware supersession resolution

The resolver will receive both the `superseded_by` reference and the canonical
path of the note containing it. It will parse standard Obsidian wikilinks,
including aliases and heading fragments, but will resolve only a Markdown file.

Candidate resolution order is deterministic:

1. If the target begins with an active configured root such as `wiki/` or
   `projects/`, treat it as explicitly vault-relative and resolve only that
   exact path from the vault root.
2. Otherwise, resolve the exact target relative to the source note's directory.
   This covers both a bare sibling link such as `[[0018-decision]]` and a
   source-relative nested path.
3. For a bare filename only, permit a unique filename match inside the active
   provider's allowed recall roots. Zero or multiple matches are unresolved.

An extensionless exact target may add `.md`; numeric prefixes and partial names
are never guessed. Every candidate is resolved and rechecked against the vault,
active provider roots, explicit recall scope, safe path segments, symlink
escape rules, and Markdown-only restriction. An explicit path is not allowed to
fall through to a differently located filename if it is missing.

The existing maximum of eight supersession hops remains. Cycle detection uses
canonical vault-relative paths. A stale successor continues through the chain;
the first non-hidden successor is emitted. Missing, ambiguous, cyclic,
out-of-scope, future, private, or unsafe routes do not leak a replacement and
are surfaced by the audit.

Tests cover sibling chains, vault-root paths, `.md` and extensionless targets,
aliases, heading fragments, ambiguity, missing shorthand, cycles, hop limits,
scope isolation, private paths, symlinks, and successor validity states.

### Executable local recall evaluation

Add a manual command:

```bash
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  evaluate /path/to/recall-evals.json --json
```

The command is read-only and uses the normal recall orchestration rather than a
second search implementation. Its fixture schema is versioned and contains:

```json
{
  "schema_version": 1,
  "cases": [
    {
      "id": "current-decision-through-supersession",
      "query": "decision wording",
      "mode": "hybrid",
      "provider": "auto",
      "scope": "projects/example",
      "top": 3,
      "max_tokens": 900,
      "expected_paths": ["projects/example/decisions/current.md"],
      "any_of_paths": [],
      "forbidden_paths": ["projects/example/decisions/old.md"],
      "allow_degraded": false
    }
  ]
}
```

`expected_paths` requires every listed path; `any_of_paths` requires at least
one member when non-empty; `forbidden_paths` rejects any listed result.
Provider, mode, scope, result count, and token limits use the same validation as
`recall`. Unknown fields and malformed or unsafe paths fail fixture validation.
Queries and paths are never interpreted as commands.

Per-case output includes only the case ID, pass/fail reasons, requested and
effective provider/mode, degradation flag, elapsed milliseconds, result-token
estimate, stale-filter count, and returned vault-relative paths. It does not
print note bodies or snippets. Aggregate output includes pass counts and median
latency and token estimates. Exit status is 0 when all cases pass, 1 for a
valid suite with failed cases, and 2 for configuration or fixture errors.
Latency is measured but is not a hard pass criterion because local model warmup
and hardware vary.

Unit tests use synthetic temporary vaults and a mocked QMD process for
determinism. A private real-vault suite may live inside the vault under the
global wiki integration project; it contains only vault-relative paths and no
secrets. It is not committed to this repository. The existing framework-neutral
`memory-evals.json` continues to specify agent behavior; `evaluate` covers the
lower-level retrieval contract rather than pretending to grade model answers.

QMD's upstream `qmd bench` remains the preferred engine-level precision,
recall, MRR, and F1 tool. The wrapper evaluation measures local governance,
scope, provider failover, and token behavior that QMD alone cannot see.

### Governance-focused health audit

Add a manual read-only command:

```bash
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py audit --json
```

The audit scans only configured recall roots and honors the same safe traversal
rules as recall. Governance checks apply only when a note explicitly declares
an action-driving `memory_class`:

| Memory class | Required for a current note | Optional but validated when present |
| --- | --- | --- |
| `fact` | recognized current/candidate status and non-empty origin in `source`; current facts also require `verified_by` | confidence, observed, validity bounds, supersession |
| `decision` | recognized decision status; accepted/current decisions require `verified_by` or a non-empty source | confidence, validity bounds, supersession |
| `heuristic` | recognized status, evidence origin in `source`, and `verified_by` before a current/verified state | confidence, validity bounds, supersession |

Candidate facts and heuristics may be intentionally unverified. Validity bounds
are not mandatory for timeless claims, but any declared bound must be a valid
ISO date. The governance parser must recognize both scalar and YAML-list forms
for `source`, `supersedes`, and related inspected fields; a compliant list must
not be mistaken for an empty scalar. This remains a bounded metadata parser,
not execution of arbitrary YAML types. Within that policy, the audit reports:

- action-driving `fact`, `decision`, and `heuristic` notes that lack the
  class-specific status, origin/provenance, or verification fields in the
  table above;
- invalid status, confidence, `valid_from`, or `valid_until` values;
- `valid_until` earlier than `valid_from`;
- unresolved, ambiguous, cyclic, overlong, private, symlinked, or out-of-root
  supersession routes;
- stale notes whose declared successor cannot safely route to a current note;
- provider availability, selected-versus-effective policy, installed QMD
  version, and collection/root mismatches; and
- unsafe or missing configured commit roots without reading private content.

Required metadata is conditional on `memory_class`; ordinary indexes, logs,
daily notes, tasks, canvases, generated drawings, and legacy narrative pages
are not globally declared invalid. Missing optional legacy metadata is a
warning. Safety violations, malformed action-driving governance, and broken
declared supersession are errors. The report is bounded and deterministic,
contains vault-relative paths rather than note bodies, and returns nonzero only
when errors exist.

The command never auto-fixes frontmatter, renames notes, deletes history,
rewrites links, updates the QMD index, or commits changes. Remediation remains a
reviewed wiki edit.

### Documentation and durable knowledge

The implementation updates:

- `wiki/ARCHITECTURE.md`, the plugin README/skill references, configuration
  examples, and command documentation for the new boundaries;
- `wiki/docs/research/2026-08-01-agent-memory-systems.md` with the current
  nine-provider accounting, source revision, independent assessments, and the
  limit that cloud/self-hosted provider integrations were source-reviewed but
  not live end-to-end tested;
- the existing behavioral evaluation reference without claiming unexecuted
  model results; and
- the private vault's global wiki-integration project with an additive accepted
  decision record after verification, plus focused README/TODO/index/log/cache
  updates only where they remain truthful.

The accepted provider-backed recall decision remains historical evidence. The
new decision refines it instead of rewriting it. No raw chat transcript,
provider credential, machine-specific vault path, or unrelated project content
is persisted.

## Independent Hermes provider assessment

The Hermes feature page currently says eight providers but enumerates nine.
At inspected Hermes source revision
`b2bd1ac63ff137a6287ce989d65dccee6b9155e2`, eight implementations were bundled:
ByteRover, Hindsight, Holographic, Honcho, Mem0, OpenViking, RetainDB, and
Supermemory. Memori was supplied as the external `hermes-memori` package, making
nine available choices.

Each was checked independently against its primary documentation and, where
available, implementation. Hermes provider modules compiled locally. This was
a source- and contract-level validation, not a claim of live end-to-end success:
cloud credentials and separate databases/services were deliberately not
provisioned.

| Provider | Independently observed strength | Decision for this vault |
| --- | --- | --- |
| Honcho | Message/event storage, peer representations, session context, hybrid search, and dialectic user modeling | Do not adopt; useful social-modeling pattern, but not a canonical global wiki and requires service/storage/LLM infrastructure. |
| OpenViking | Hierarchical L0/L1/L2 context, filesystem-like organization, vector indexing, and session extraction | Do not adopt; progressive disclosure is already applied locally, while a second hierarchy would split authority. |
| Mem0 | LLM extraction and deduplication over history plus vector/entity storage; hosted graph capability | Do not adopt; automated extraction and a second truth store conflict with explicit admission and Markdown authority. |
| Hindsight | Retain/recall/reflect, semantic/BM25/graph/temporal retrieval, reranking, and source-backed observations | Defer as the best synthetic-data pilot only if measured graph or temporal failures remain after this upgrade. |
| Holographic | Hermes-local SQLite FTS5 memory with trust scoring and optional holographic representations | Do not adopt; it duplicates native/QMD and its trust score is not a substitute for provenance. |
| RetainDB | Hosted company, user, session, and agent memory with citations and API/MCP access | Do not adopt; it duplicates the current system and introduces content egress. |
| ByteRover | Local Markdown context tree, curation workflow, daemon, semantic Git, and human review | Do not adopt; it is closest in philosophy but creates a second context tree and ownership boundary. |
| Supermemory | Graph-oriented cloud/self-hosted memory with local embeddings support and LLM-assisted processing | Do not adopt; no measured gap justifies another database/service or extraction pipeline. |
| Memori | Turn and tool-execution capture with entity/project attribution through a hosted Hermes adapter | Do not adopt; automatic tool-trace capture has the largest privacy and governance mismatch. Attribution is useful only as an episode metadata pattern. |

Hermes' provider lifecycle remains a useful orchestration reference: keep a
dependable built-in layer, allow at most one optional provider, isolate failure,
scope by profile, and expose health separately from setup. The local equivalent
is canonical Markdown plus one selected recall provider, with no automatic turn
mirroring.

## Failure behavior

- An unavailable or failed QMD under `auto` yields a visible native fallback.
  An explicit `qmd` request remains strict and fails clearly.
- An unsafe or ambiguous supersession target is not followed. Recall omits the
  route, while `audit` identifies the source note and reason without exposing
  target content.
- A malformed evaluation suite performs no cases and exits 2. A valid failed
  case exits 1 without changing the vault or index.
- Audit findings never trigger automatic repair. Audit failure does not alter
  lifecycle hook output.
- Commit validation fails before creating a commit when any selected target is
  unsafe. Existing HEAD, unrelated index entries, and unselected files remain
  unchanged.
- QMD upgrade incompatibility blocks live activation. The prior pin and derived
  index are recoverable without changing canonical Markdown.

## Testing and delivery

Implementation follows test-driven development. Every behavior change begins
with a failing focused test and ends with the smallest passing implementation.

Required repository gates before live activation:

```bash
python3 wiki/scripts/check.py
python3 scripts/plugins.py check
git diff --check
```

The QMD pin is activated and checked through the workspace-owned Bun workflow:

```bash
python3 bun-global-tools/sync.py apply
python3 bun-global-tools/sync.py check --deep
```

After the changed local plugin is intentionally installed, the live-copy gate
must pass:

```bash
python3 scripts/plugins.py install --force
python3 scripts/plugins.py status
```

Required focused evidence includes:

- existing session-start, provider, recall, scope, validity, and fallback tests;
- new source-aware supersession and audit cases;
- exact-file commit safety tests, including unrelated staged changes and
  rejected targets;
- evaluator schema, pass/fail, degradation, token-budget, and no-body-output
  tests;
- QMD 2.8.3 `--version`, `status`, and `doctor` checks;
- fast, semantic, and hybrid wrapper recall against safe test collections; and
- a manual private-vault suite proving the previously broken sibling
  supersession chain returns the accepted successor.

`python3 wiki/scripts/update.py` is not a validation command and is not used.
After branch integration, live plugin activation uses
`python3 scripts/plugins.py install --force` because local plugin versions stay
pinned at 1.0.0. An explicit QMD refresh/embed follows only after the new live
binary and collection configuration pass health checks.

## Rollout and rollback

Rollout is staged:

1. Implement and verify all behavior with temporary vaults and mocked QMD.
2. Install QMD 2.8.3 through the Bun manifest and validate the existing local
   collections without changing canonical notes.
3. Run the private evaluation and audit read-only; review findings rather than
   bulk-fixing them.
4. Integrate and force-refresh the live plugin only after repository gates and
   review pass.
5. Explicitly refresh and embed the derived QMD index, rerun health checks and
   the private recall suite, then write the additive vault decision record.

Rollback re-pins QMD 2.5.3 through the Bun manifest, restores the previous
plugin commit, and rebuilds the disposable QMD index. Canonical Markdown and
its Git history remain intact; no provider migration or data export is needed.

## Acceptance criteria

- `@tobilu/qmd` is pinned and installed at 2.8.3 through Bun, and the existing
  wrapper and collection configuration pass health and recall checks.
- A stale note with a normal sibling `superseded_by` chain resolves to the
  current safe successor; explicit paths still work; shorthand, ambiguous,
  cyclic, private, symlinked, out-of-root, and out-of-scope routes fail closed.
- Automatic and explicit commits include exactly the eligible configured
  Markdown files and cannot absorb unrelated staged or private content.
- `evaluate` deterministically validates retrieval expectations, reports
  effective provider/degradation/token evidence without note bodies, and
  changes no files or indexes.
- `audit` reports actionable governance and supersession defects over safe
  roots without blanket legacy false positives, automatic fixes, or note-body
  output.
- L0 and L1 outputs remain bounded and untrusted; model/index work remains out
  of hooks; `auto` fallback remains visible.
- Repository wiki, plugin catalog, live-copy status, Bun, and diff gates pass.
- A reviewed private-vault run demonstrates current-decision recall for the
  previously broken real sibling chain.
- Documentation accounts for all nine currently available Hermes provider
  choices and clearly distinguishes source review from live integration tests.
- No external provider, second writable memory database, raw transcript
  mirror, secret, machine-specific vault path, or Factorio change is introduced.

## Non-goals

- Hosted memory-provider adoption or live-vault mirroring.
- A graph database, agent-personality model, or automatic LLM extraction on
  each turn.
- Raw transcript or tool-trace retention as normal durable memory.
- Automatic embedding, benchmarking, or governance scans in lifecycle hooks.
- Bulk frontmatter normalization, automatic link repair, renaming, deletion,
  or orphan cleanup across the vault.
- Treating retrieval benchmarks as proof that a model follows memory safely.
- Any Factorio analysis, implementation, documentation, branch integration, or
  vault update.

## Primary references

- [Hermes Agent memory providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)
- [Hermes Agent repository](https://github.com/NousResearch/hermes-agent)
- [Honcho repository](https://github.com/plastic-labs/honcho)
- [OpenViking architecture](https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/01-architecture.md)
- [Mem0 memory pipeline](https://github.com/mem0ai/mem0/blob/main/docs/core-concepts/how-it-works.mdx)
- [Hindsight repository](https://github.com/vectorize-io/hindsight)
- [RetainDB introduction](https://www.retaindb.com/docs/intro)
- [ByteRover CLI reference](https://docs.byterover.dev/reference/cli-reference)
- [Supermemory self-hosting quickstart](https://github.com/supermemoryai/supermemory/blob/main/apps/docs/self-hosting/quickstart.mdx)
- [Memori Hermes quickstart](https://github.com/MemoriLabs/Memori/blob/main/docs/memori-cloud/hermes/quickstart.mdx)
- [QMD repository and changelog](https://github.com/tobi/qmd)
