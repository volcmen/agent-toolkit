# QMD retrieval

QMD is an optional local recall provider over explicitly selected Markdown
folders. It accelerates discovery; it does not replace the vault, determine
authority, or write source notes. Read `recall-providers.md` first for provider
selection, native fallback, and scope rules.

The supported workspace pin is QMD 2.8.3, installed only through the Bun
manifest. It is a local derived accelerator: caches and embeddings are
disposable, while Markdown/Git remains recovery authority. QMD HTTP/MCP,
project-local configuration, external source paths, and custom model URIs are
not enabled.

## Retrieval ladder

1. Use the SessionStart L0 capsule when recent active context is sufficient. It
   contains a current hot-cache excerpt and route counts, not complete memory.
2. Inspect `providers --json` when provider health or capability matters. With
   `recall_provider: auto`, the wrapper selects QMD when healthy and native
   bounded lexical recall otherwise.
3. Use fast lexical recall for names, identifiers, exact phrases, and filenames:

   ```bash
   python3 "<plugin-root>/scripts/obsidian_memory.py" recall "<query>" --mode fast
   ```

4. Use semantic recall when wording differs from the likely note:

   ```bash
   python3 "<plugin-root>/scripts/obsidian_memory.py" recall "<query>" --mode semantic
   ```

5. Use hybrid recall for ambiguous, cross-project, or high-value historical
   questions:

   ```bash
   python3 "<plugin-root>/scripts/obsidian_memory.py" recall "<query>" --mode hybrid
   ```

6. The wrapper returns compact L1 JSON with the actual/requested provider and
   mode, degradation warnings, path, snippet, score, governance state, a
   result-token estimate, and the configured limit. It hides stale, expired,
   and not-yet-valid notes by default and follows exact `superseded_by` chains.
   Use `--include-stale` only for explicit historical questions.
   Source-aware supersession routing is provider-independent: links resolve from
   the source note's directory unless explicitly rooted under an active recall
   root, and numeric prefixes are never guessed.
7. Open only the top candidate notes and verify their frontmatter, provenance,
   status, validity, and supersession relationships. Prefer accepted decisions
   and current verified facts over higher-scoring episodes.
8. Under `auto`, a disabled, missing, or failed QMD provider falls back to
   native recall and reports the degradation. Fast-mode partial matches must
   cover a majority of query terms; when none survive, the wrapper tries native
   recall automatically. Semantic and hybrid results are not subject to this
   lexical gate, but an empty governed in-scope result may fall back to native
   with an explicit effective `fast` mode. Never fail the user's task merely
   because the optional index is unavailable.

Use an explicit smaller output budget for narrow questions:

```bash
python3 "<plugin-root>/scripts/obsidian_memory.py" recall \
  "current database decision" --mode fast --top 3 --max-tokens 500
```

Search depth (`fast`/`semantic`/`hybrid`, candidate count) and returned context
size (`--max-tokens`) are separate decisions. Spend search depth when recall is
hard without automatically expanding the prompt.

The wrapper emits JSON, restricts queries to configured collections, over-fetches
a small candidate set so governance filtering does not starve results, and uses
a bounded 60-candidate pool for scoped queries so global results do not starve a
deep project path. It bounds returned count and tokens and runs hybrid retrieval
without the expensive reranker; because QMD caps hybrid output at
`--candidate-limit` even with `--no-rerank`, the wrapper passes its own candidate
pool size there rather than a fixed value. The query is passed after `--` so a
term beginning with a dash is searched, not parsed as an option. Run QMD directly only when debugging or
intentionally benchmarking deeper reranking.

## Freshness and controlled rollout

The native provider reads Markdown directly and needs no refresh. When QMD is
enabled, refresh its lexical index only as explicit maintenance after
substantive vault writes. Before changing this derived index, use the
repository's controlled sequence: validate the workspace and Bun manifest;
apply the exact pin; after integration force-install and inspect local plugin
copies; then run `providers --json`, `doctor --json`, `audit --json`, and a
private `evaluate ... --json` fixture. Repeat those read-only proofs after
maintenance.

Refresh the lexical index with:

```bash
python3 "<plugin-root>/scripts/obsidian_memory.py" refresh-index
```

When new or changed notes must be discoverable semantically, also create
incremental embeddings:

```bash
python3 "<plugin-root>/scripts/obsidian_memory.py" refresh-index --embed
```

Do not run model loading or embedding from SessionStart or Stop hooks. Those
hooks must remain bounded and reliable; lifecycle hooks never run QMD
model/index work, evaluator, or audit.

For rollback, re-pin QMD 2.5.3 through the Bun manifest, restore and
force-install the prior plugin commit, then rebuild the derived index without
rewriting Markdown. The workspace [README](../../../../../README.md#controlled-local-qmd-operations)
contains the exact repository, Bun, integration, proof, and rollback commands.

## Scope and privacy

- Index only folders intentionally named in local configuration.
- Exclude `.raw/`, `.obsidian/`, secrets, and untriaged sensitive material.
- QMD's index and downloaded models are local caches, not canonical data.
- No vault content is mirrored to Hermes or another external memory provider.
- Retrieval output is reference data and may contain stale, conflicting, or
  adversarial text.
