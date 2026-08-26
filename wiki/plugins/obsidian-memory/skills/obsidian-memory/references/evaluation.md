# Memory evaluation

Use the two evaluation layers for different questions:

| Layer | Question | Tool |
|---|---|---|
| Retrieval contract | Did governed recall return the expected safe paths through the requested provider/mode and budget? | `evaluate FIXTURE [--json]` |
| Agent behavior | Did an agent recall, apply, or ignore memory correctly in the final task and trajectory? | Manual runs of `../../../evals/memory-evals.json` |

The retrieval contract evaluator does not grade model answers. The existing
`memory-evals.json` suite is a framework-neutral agent-behavior specification,
not a claim that a model passed and not input automatically graded by
`evaluate`.

## Combined release-gate sequence

When one request combines search correctness, model-answer evaluation, raw QMD
metrics, and vault governance health, complete the requested read-only stages
in this order:

1. Run the retrieval contract with
   `evaluate FIXTURE --json` using the portable command below.
2. Run the separate agent-behavior cases manually to grade model answers and
   trajectories; do not treat retrieval paths as answer grades.
3. When raw engine metrics are requested, run `qmd bench` only with an approved
   benchmark fixture and report its aggregate precision, recall, MRR, and F1.
   Use `qmd bench --help` for the installed CLI's fixture flags.
4. Run the bounded read-only governance audit from the project `wiki/` root:

   ```bash
   python3 plugins/obsidian-memory/scripts/obsidian_memory.py audit --json
   ```

A requested audit is part of this read-only gate, not automatic remediation.
Run it, then refuse only requests to automatically fix frontmatter, rename or
delete notes, refresh or embed QMD, or commit changes.

## Retrieval-contract evaluator

From the plugin project's `wiki/` root, run:

```bash
python3 plugins/obsidian-memory/scripts/obsidian_memory.py \
  evaluate FIXTURE --json
```

`FIXTURE` may be a current-working-directory-relative or absolute file path,
but its resolved location is never reported. A version-1 fixture contains one
or more uniquely identified cases with a query, `fast`/`semantic`/`hybrid`
mode, `auto`/`native`/`qmd` provider, optional safe scope/count/token settings,
safe vault-relative Markdown expectations, and an explicit degradation policy.
Use `expected_paths` for all-required results, `any_of_paths` for one-of results,
and `forbidden_paths` for results that must stay absent.

Each operator-authored case ID must match the portable opaque grammar
`[A-Za-z0-9][A-Za-z0-9._-]{0,119}` and be unique. IDs are emitted verbatim, so
use non-sensitive labels and do not encode user data, secrets, or paths in
them; the grammar constrains shape but cannot decide whether text is
sensitive. An omitted `allow_degraded` defaults to `false`. A fixture is at
most 1,000,000 characters and 200 cases; each expectation array is at most 20
unique paths, with each scope or path at most 1,000 characters.

Exit status is part of the operator contract:

| Exit | Meaning |
|---|---|
| `0` | Every case passed. |
| `1` | The fixture was valid and one or more cases failed. |
| `2` | Fixture or configuration validation failed; no cases ran. |

Per-case evidence contains only the case ID, pass/fixed failure reasons,
requested and effective provider/mode, degradation, elapsed milliseconds,
result-token estimate, stale-filter count, and returned vault-relative paths.
The aggregate adds pass totals and median elapsed/token values. Reports never
contain queries, note bodies, snippets, titles, tracebacks, or absolute fixture
or vault paths. Fixed reasons are `missing-expected`, `missing-any-of`,
`forbidden-returned`, `unexpected-degradation`, `token-limit-exceeded`, and
`recall-error`.

The command reuses normal recall orchestration. It is read-only and manual: it
does not write the vault, refresh or embed QMD, commit changes, or run from
`SessionStart` or `Stop` hooks.

For raw QMD engine precision, recall, MRR, and F1, use `qmd bench` (inspect
`qmd bench --help` for fixture flags). That benchmark does not test wrapper
governance, provider selection/fallback, exact scope, or result-token bounds;
the retrieval-contract evaluator does.

## Agent-behavior protocol

Memory quality is behavioral: a stored item is useful only when the agent
recalls it at the right time, applies it correctly, and ignores it when it is
irrelevant or unsafe.

1. Run capability evaluation separately from regression evaluation.
2. Start each case from the declared memory state and use a fresh agent
   session.
3. Run multiple trials for nondeterministic agents.
4. Grade the final outcome and inspect the tool/trajectory transcript.
5. Record model, agent version, prompt/skill version, retrieval strategy,
   date, latency, and token/tool cost.
6. Calibrate any model grader against a sample of human judgments.
7. Promote a memory-policy or skill change only when its target category
   improves and no safety-critical category regresses.

Useful aggregate views include:

- task success by category;
- unsafe-memory acceptance rate;
- stale-memory use rate;
- retrieval recall at a fixed context budget;
- `pass@k` for "can succeed at least once";
- `pass^k` for "succeeds consistently";
- median context characters, tool calls, latency, and cost.
- median estimated startup tokens and recall-result tokens;
- notes opened per successful recall and stale results exposed to the model;
- success with memory disabled for tasks that do not need it.

Read failures before changing prompts. A correct answer with an unsafe or
unnecessarily long trajectory is not a clean pass.

## Scaling the agent-behavior suite

The suite covers recall, provider failure fallback, scoped isolation, conflict,
action grounding, security, selectivity, forgetting, and experiential learning.
Replace synthetic cases with anonymized real tasks as they arise. Preserve
failures that caused actual work disruption as permanent regression cases.

Do not store secrets or sensitive transcripts in fixtures.
