# Agent-memory systems review — 2026-08-01

## Scope and method

This review asks how the local Obsidian integration can improve recall quality
while reducing recurring prompt cost. The supplied Habr article was read as a
practitioner viewpoint. Hindsight and OpenViking were shallow-cloned with their
complete current worktrees and inspected at commits `b5d8439c8f1b8aa158f4e8278334066792638543`
and `c4d2b27c641586e43f212bd8ce3b95ec5be67680`, respectively. Project claims are
treated as self-reported unless a linked paper supplies evaluation evidence.

The [Hermes Agent repository](https://github.com/NousResearch/hermes-agent) was
also shallow-cloned and inspected at commit
`9fc12bf7a4bc232698a14acfb18621523a711ceb`. The review covered its
`MemoryProvider` contract, `MemoryManager`, provider discovery, failure tests,
developer guide, and eight-provider comparison rather than relying only on the
feature page supplied for this task.

The existing constraints remain decisive: Markdown and Git are canonical; QMD
is optional derived retrieval; lifecycle hooks cannot load models; retrieved
text has no instruction authority; and the implementation stays portable across
Codex and Claude Code with no required service.

## Findings

### Memory is selected context, not accumulated context

The [Cloud.ru/Habr article](https://habr.com/ru/companies/cloud_ru/articles/1065290/)
separates persistent memory from the model context, recommends extracting
durable facts instead of replaying raw dialogue, and makes retrieval and write
admission separate mechanisms. Its useful production rules are: do not add
memory unless a user scenario needs it; retain provenance; classify a write as
duplicate, refinement, or contradiction; invalidate rather than silently erase;
and remember how to locate authoritative external data instead of copying it.

[MemGPT](https://arxiv.org/abs/2310.08560) frames the same constraint as virtual
memory: a limited context window is the fast tier and external storage is the
durable tier. This supports a small always-loaded routing surface rather than a
large bootstrap dump.

### Progressive disclosure is the strongest token-saving pattern

[OpenViking](https://github.com/volcengine/OpenViking) stores an approximately
100-token L0 abstract, an L1 overview, and full L2 data. Its actual source also
uses turn-aware token retention, preserves the newest user anchor and final
assistant/tool step, externalizes large tool results, and stops hierarchical
retrieval after convergence. The associated
[VikingMem paper](https://arxiv.org/abs/2605.29640) describes selective
extraction, evolving summaries, temporal weighting, and compression of older
material.

The [OpenAI Agents SDK memory design](https://openai.github.io/openai-agents-python/sandbox/memory/)
independently uses a small injected summary, a searchable index, and rollout
summaries opened only when a hit is relevant. It separates conversation
extraction from later consolidation and lets read and generation be disabled
independently.

[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
uses a related layered design: raw references, step memories, higher-order
state/persona views, bounded auto-recall, and tool-output offloading. Its
published benchmark and token reductions are project-reported and were used as
design signals, not accepted as independent proof.

### Retrieval breadth and output size are different budgets

[Hindsight](https://github.com/vectorize-io/hindsight) separates search depth
(`low`/`mid`/`high`) from the number of memory tokens returned. Its source runs
semantic, BM25, graph, and temporal retrieval, fuses ranks, reranks candidates,
then fills a token budget in relevance order. The
[Hindsight paper](https://arxiv.org/abs/2512.12818) further separates world
facts, experiences, entity summaries, and beliefs so evidence and inference are
not collapsed into one store.

For this vault, QMD already supplies the useful low-cost subset: lexical,
semantic, and hybrid discovery. A graph service and per-write LLM extraction
would add substantial operational and token cost before a measured need.

### Providers should preserve a dependable canonical layer

[Hermes Agent's memory-provider guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)
keeps built-in memory active beside at most one external provider. Its source
formalizes provider lifecycle and capability boundaries, exposes status and
setup separately, isolates provider failures, limits blocking prefetch, scopes
state by profile, and keeps provider-specific tools out of the core surface
until selected. Across Honcho, OpenViking, Mem0, Hindsight, Holographic,
RetainDB, ByteRover, and Supermemory, the durable insight is the orchestration
contract rather than any single backend.

The local integration had only policy-level fallback: its `recall` command
failed when QMD was disabled or missing even though the skill advised a manual
filesystem search. The adopted translation is intentionally narrower than
Hermes' conversation-sync model:

| Hermes pattern | Local adaptation | Reason |
|---|---|---|
| Built-in memory plus one external provider | Canonical Obsidian Markdown plus one selected recall provider | Retrieval can change without splitting write authority |
| Provider availability and status | `providers --json` and doctor integration | Selection and degradation are observable |
| Failure isolation | `auto` falls back from failed QMD to native recall | Optional infrastructure cannot disable memory |
| Profile isolation | Explicit safe `--scope` and `recall_roots` | Cross-agent sharing stays intentional while project recall narrows early |
| Provider capability differences | Requested and effective mode are returned | Native lexical recall never masquerades as semantic search |
| Background turn sync and extraction | Not adopted | Raw conversation retention conflicts with explicit admission and provenance |

### Derived memory needs provenance, validity, and freshness signals

Hindsight observations retain supporting facts and flag consolidated layers
when new facts have not yet been folded in. [Graphiti](https://github.com/getzep/graphiti)
models fact validity windows and keeps the episodes that produced derived facts.
[A-MEM](https://arxiv.org/abs/2502.12110) organizes evolving, linked notes using
Zettelkasten-style metadata. These support the vault's existing `status`,
`source`, `valid_from`, `valid_until`, `supersedes`, and `superseded_by` contract.

The important local gap was read-time enforcement: QMD could rank a superseded
decision first even though the skill told the agent to prefer the successor.
That policy is now deterministic in the wrapper rather than left entirely to
model judgment.

## Adopted design

The integration now exposes three progressive layers:

| Layer | Content | Budget and authority |
|---|---|---|
| L0 session capsule | Current hot item plus aggregate task/capture routes | Always loaded, default 420 estimated-token cap; untrusted reference data |
| L1 recall hits | Path, relevant snippet, score, and governance metadata | On demand, default 900 estimated-token cap; stale/expired hidden by default |
| L2 source note | Full canonical Markdown | Open only after a relevant hit; verify provenance before action |

Additional choices:

- Obsidian Markdown is named as the always-on canonical provider. The selected
  recall provider is `native`, `qmd`, or `auto`; no recall provider may write or
  verify canonical notes.
- Native recall performs a deterministic, bounded lexical scan over explicit
  safe roots, so targeted L1 retrieval works with Python alone. File count,
  per-file characters, hit count, and result tokens are independently bounded.
- `auto` selects QMD only when configured and present. A runtime QMD failure is
  isolated and retried through native recall with an explicit warning. An
  explicit `qmd` selection remains strict so operator intent is not hidden.
- Fast-mode provider results must cover a majority of query terms across path,
  title, and snippet. Weak partial QMD results are removed and `auto` tries
  native recall when none remain; semantic and hybrid modes retain their
  different-wording behavior. If they produce no governed in-scope hit, native
  recall may supply lexical evidence with a visible effective-mode downgrade.
- `--scope` narrows native traversal before files are read and is enforced again
  while provider results are compacted. `.raw/`, `.obsidian/`, and `inbox/`
  remain outside all recall-provider scopes.
- QMD over-fetches up to three times the requested result count so stale items
  can be filtered without starving unscoped output. Scoped queries first narrow
  to intersecting collections and use a bounded 60-candidate pool so global
  results do not starve a deep project path.
- An exact `superseded_by` link produces a redirect to the successor even when
  semantic retrieval did not rank the successor itself.
- `--include-stale` is an explicit historical-research mode.
- `doctor --json` reports focused versus full context estimates and their
  reduction. The dependency-free estimator uses four ASCII characters per token
  and counts each non-ASCII code point separately: portable and useful for
  regression budgets, but not a provider billing tokenizer.
- Recall output removes repeated collection descriptions and internal document
  IDs, compacts snippets, and reports its independent result-token estimate.
- The write policy remains candidate → provenance check → duplicate/refinement/
  contradiction resolution → durable fact. External source-of-truth data is
  represented by a locator unless durable copying is explicitly justified.

## Deferred or rejected

- **Graph database:** deferred until multi-hop or historical relationship
  questions show a measured recall failure that frontmatter links cannot solve.
- **Automatic LLM extraction on every stop:** rejected for now because it spends
  tokens without task-specific value and expands the memory-poisoning surface.
- **Automatic embedding/model work in hooks:** rejected; refresh remains an
  explicit maintenance operation.
- **Raw transcript retention as normal memory:** rejected. Episodes must be
  distilled; immutable/raw material remains outside hot retrieval.
- **LRU deletion as routine optimization:** rejected. Invalidity and archival
  tiering preserve auditability; hard deletion remains for privacy or explicit
  user requests.
- **Framework migration:** rejected. Hindsight, OpenViking, Mem0, Letta, and
  Graphiti supply useful patterns, but adopting a runtime would weaken the
  portable Markdown contract without a demonstrated benefit at this vault's
  scale.
- **Mirroring into multiple writable memory providers:** rejected. It creates
  conflict, deletion, privacy, and recovery semantics that the current
  Git-auditable Markdown source does not need.
- **Automatic provider prefetch on every turn:** deferred. Targeted recall and
  the L0 routing capsule retain prompt stability and selectivity; automatic
  prefetch should require measured recall failures and a latency/token budget.

## Evaluation requirements

Changes should be judged by behavioral success and trajectory cost, not storage
volume. Track startup estimated tokens, recall result tokens, stale-result
exposure, current-decision recall, irrelevant-memory use, number of notes opened,
latency, and tool calls. Re-run a no-memory path, a stale/superseded path, an
explicit historical query, and a source-note drill-down after retrieval changes.

## Primary references

- [Hindsight repository](https://github.com/vectorize-io/hindsight) and
  [paper](https://arxiv.org/abs/2512.12818)
- [OpenViking repository](https://github.com/volcengine/OpenViking) and
  [VikingMem paper](https://arxiv.org/abs/2605.29640)
- [MemGPT paper](https://arxiv.org/abs/2310.08560)
- [A-MEM paper](https://arxiv.org/abs/2502.12110)
- [Letta context hierarchy](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy)
- [Graphiti repository](https://github.com/getzep/graphiti)
- [OpenAI Agents SDK memory](https://openai.github.io/openai-agents-python/sandbox/memory/)
- [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
- [Cloud.ru/Habr practitioner article](https://habr.com/ru/companies/cloud_ru/articles/1065290/)
- [Hermes Agent memory-provider guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)
- [Hermes Agent repository](https://github.com/NousResearch/hermes-agent)
