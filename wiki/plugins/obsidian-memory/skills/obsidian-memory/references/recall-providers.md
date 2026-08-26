# Recall providers

Obsidian Markdown is the always-on memory provider and source of truth. Recall
providers only discover notes; they do not own, rewrite, verify, or upgrade the
authority of memory. This distinction keeps Git-auditable Markdown portable
across Codex and Claude Code while allowing retrieval to improve independently.
QMD 2.8.3 is the Bun-owned local derived accelerator when QMD is selected;
its caches and embeddings are disposable. No vault content is mirrored to
Hermes or another external memory provider.

## Provider model

| Provider | Role | Modes | Dependencies |
|---|---|---|---|
| `native` | Bounded lexical scan over configured Markdown roots | `fast` | Python standard library only |
| `qmd` | Optional indexed recall accelerator | `fast`, `semantic`, `hybrid` | Local `qmd` CLI and configured collections |
| `auto` | Select QMD when enabled and available; otherwise use native | Best available | None beyond the selected provider |

Configure the selection and privacy boundary locally:

```json
{
  "recall_provider": "auto",
  "recall_roots": ["wiki", "projects", "daily"],
  "native_max_files": 2000,
  "native_max_file_chars": 80000
}
```

The native limits bound work per query. QMD has its own explicitly configured
collection list. Neither provider may search `.raw/`, `.obsidian/`, or `inbox/`.
QMD HTTP/MCP, project-local configuration, external source paths, and custom
model URIs are not enabled.

## Selection and failure policy

- `auto` is resilient: QMD is preferred only when locally enabled and its
  executable exists. If a QMD query then fails, that failure is isolated and
  the same query runs through native recall. The JSON response names the actual
  provider, degradation, and warning. For `fast` queries, weak partial QMD
  matches are removed; if no sufficiently complete lexical hit remains, native
  recall gets the same query. If semantic or hybrid QMD recall yields no
  governed in-scope result, `auto` also tries native and reports an effective
  `fast` mode only when that fallback finds evidence.
- `native` is deterministic and dependency-free. A requested `semantic` or
  `hybrid` query degrades visibly to `fast`; it never pretends lexical matches
  are embeddings.
- `qmd` is strict. An unavailable or failed QMD invocation returns an error
  rather than silently changing the operator's explicit choice.
- A provider score is a relevance hint only. Governance filtering,
  supersession routing, validity checks, token budgets, and source-note review
  are provider-independent.
- Fast lexical results must cover a majority of the query terms across their
  path, title, and snippet. This precision gate is not applied to semantic or
  hybrid modes, where different wording is the point.

Inspect selection and health before debugging recall:

```bash
python3 "<plugin-root>/scripts/obsidian_memory.py" providers --json
python3 "<plugin-root>/scripts/obsidian_memory.py" doctor --json
```

For a controlled local upgrade, validate the repository first, apply the
Bun-owned QMD pin, then force-install changed plugin content only after
integration. Collect `providers --json`, `doctor --json`, `audit --json`, and
a private `evaluate ... --json` suite before explicit maintenance; after
`refresh-index --embed`, repeat those proofs. Lifecycle hooks never run QMD
model/index work, evaluator, or audit. To roll back, re-pin QMD 2.5.3, restore
and force-install the prior plugin commit, and rebuild derived data without
rewriting Markdown. See [the workspace rollout sequence](../../../../../README.md#controlled-local-qmd-operations)
for portable commands.

## Evaluation evidence

The retrieval-contract evaluator records the requested and effective provider
and mode for every case, plus the degradation flag, elapsed milliseconds,
result-token estimate, stale-filter count, fixed failure reasons, and returned
vault-relative paths. It never reports fixture queries, note bodies, snippets,
provider tracebacks, or absolute paths. This makes an `auto` fallback to native
visible without exposing the recalled content.

Run the manual evaluator through the portable skill command described in the
[evaluation reference](evaluation.md). A degraded case fails unless its fixture
sets `allow_degraded` to true. Use `qmd bench` separately for the raw QMD engine
precision, recall, MRR, and F1 metrics; it cannot prove wrapper governance,
scope, fallback, or token-budget behavior.

## Scoped recall

Use `--scope` when the project or knowledge area is known:

```bash
python3 "<plugin-root>/scripts/obsidian_memory.py" recall \
  "current deployment decision" --scope projects/acme --mode fast
```

Scopes are safe vault-relative path prefixes. The native provider narrows its
scan before reading files. QMD selects only collections whose configured roots
intersect the scope and uses a bounded deeper candidate pool before every
provider enforces the exact path prefix again while building L1 results. Scope
is an isolation and selectivity control, not an authority signal.

A scope binds supersession routing too: when a stale hit points to a successor
outside the scope, the successor is withheld rather than leaked, and the hit
stays counted in `filtered_stale`. Widen or drop `--scope` to follow it.

Recall only ever resolves `.md` files, and every dot-prefixed path segment is
refused — `.raw/`, `.obsidian/`, and machine state such as `.git/config`, which
can hold credentials. Matching is case-insensitive and re-applied after symlink
resolution, so neither `.Raw/secret.md` on a case-insensitive filesystem nor a
symlink into `.raw/` can enter recall output.

Governance filtering hides three states by default: `stale` (superseded,
deprecated, rejected), `expired` (`valid_until` in the past), and `future`
(`valid_from` not yet reached). Supersession routing follows the chain up to
eight hops and is cycle-checked, so a successor that is itself stale never
re-enters results. An unparsable `valid_from`/`valid_until` does not hide the
note — it surfaces as `memory.validity_warning` so a typo stays visible. The
`filtered_stale` count reports every governance-hidden hit across all three
states, not only superseded ones.

When a single hit cannot fit `max_tokens`, recall returns its path with
`"truncated": true` instead of an empty result set. Raise `--max-tokens` to see
the snippet and governance metadata.

## Why providers are additive

The design adapts the strongest part of Hermes Agent's provider model: the
built-in memory remains active, one configured accelerator supplies optional
recall capabilities, status is inspectable, and provider failure does not
disable canonical memory. It deliberately does not mirror whole conversations
or auto-extract facts because this vault requires explicit admission,
provenance, and evaluation before durable promotion.
