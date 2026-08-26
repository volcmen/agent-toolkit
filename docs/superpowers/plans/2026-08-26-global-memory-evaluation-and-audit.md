# Global Memory Evaluation and Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add executable local recall evaluation and a bounded, governance-aware, read-only vault audit.

**Architecture:** First extract the current recall orchestration into a payload-returning function while preserving the CLI contract. The evaluator calls that exact function and checks paths, provider degradation, and token evidence. The audit adds a bounded frontmatter reader and safe-root walker, then uses the core plan's detailed supersession traversal so health reports and recall enforce identical routing rules.

**Tech Stack:** Python 3 standard library, `dataclasses`, JSON, `unittest`, mocked QMD subprocesses, Obsidian Markdown.

**Spec:** [Local-First Global Memory Upgrade Design](../specs/2026-08-26-global-memory-upgrade-design.md)

**Depends on:** [Global Memory Core Hardening Plan](2026-08-26-global-memory-core-hardening.md)

## Global Constraints

- Obsidian Markdown plus Git remains the only writable canonical memory.
- `evaluate` and `audit` are manual, read-only commands; neither runs from lifecycle hooks.
- Both commands scan only configured safe roots, return bounded output, and never print note bodies or snippets.
- The evaluator reuses normal recall orchestration; the audit reuses normal reference and supersession resolution.
- Unknown fixture fields, unsafe paths, malformed types, and unsupported schema versions fail closed.
- Ordinary indexes, logs, daily notes, tasks, canvases, drawings, and legacy narrative pages are not globally invalidated.
- No new Python dependency, service, graph database, cloud provider, transcript capture, secret, machine-specific vault path, or Factorio change.
- Keep plugin versions at `1.0.0`; generated manifests remain generated.
- Do not use `wiki/scripts/update.py` for validation.

## File map

- Modify `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py`: reusable recall payload, fixture parsing, evaluator, rich bounded frontmatter parsing, safe audit traversal, governance findings, supersession/configuration findings, and CLI dispatch.
- Modify `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py`: deterministic evaluator and audit tests with temporary vaults and mocked providers.
- Create `wiki/plugins/obsidian-memory/evals/recall-evals.example.json`: non-private retrieval fixture demonstrating the checked schema.
- Modify `wiki/scripts/check.py`: statically validate the new example and documentation contract.
- Modify `wiki/README.md`: operator commands and exit statuses.
- Modify `wiki/ARCHITECTURE.md`: read-only evaluation/audit data flow and hook exclusion.
- Modify `wiki/plugins/obsidian-memory/skills/obsidian-memory/SKILL.md`: route manual evaluation and audit requests.
- Modify `wiki/plugins/obsidian-memory/skills/obsidian-memory/references/evaluation.md`: distinguish retrieval-contract evaluation from agent-behavior evaluation.
- Modify `wiki/plugins/obsidian-memory/skills/obsidian-memory/references/memory-governance.md`: exact action-driving audit matrix.
- Modify `wiki/plugins/obsidian-memory/skills/obsidian-memory/references/recall-providers.md`: provider/degradation evidence in evaluator output.

---

### Task 1: Extract reusable recall orchestration without changing CLI behavior

**Files:**

- Modify: `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py:1474-1646`
- Test: `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py:191-483,576-621`

**Interfaces:**

- Consumes: loaded configuration and the existing native/QMD candidates, governance compaction, fallback, and token functions.
- Produces: `recall_payload(config, query, mode, top, max_tokens=None, include_stale=False, *, provider=None, scope=None) -> dict[str, Any]`.
- Preserves: `recall(...) -> int`, its JSON keys, warnings, degradation behavior, and exit status 2 for an invalid query.

- [ ] **Step 1: Write a failing payload-versus-CLI contract test**

```python
def test_recall_payload_is_the_cli_contract_without_printing(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        vault = self.make_vault(root)
        note = vault / "projects" / "alpha" / "decision.md"
        note.write_text(
            "---\nstatus: accepted\nmemory_class: decision\n---\n"
            "# Canonical provider\nMarkdown remains canonical.\n",
            encoding="utf-8",
        )
        config_path = self.write_config(root, vault, recall_provider="native")
        with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
            config, _ = MODULE.load_config()
            payload = MODULE.recall_payload(
                config,
                "Markdown remains canonical",
                "fast",
                3,
                provider="native",
                scope="projects/alpha",
            )
        self.assertEqual(payload["provider"], "native")
        self.assertEqual(payload["requested_provider"], "native")
        self.assertEqual(payload["requested_mode"], "fast")
        self.assertEqual(payload["results"][0]["path"], "projects/alpha/decision.md")
        self.assertLessEqual(
            payload["results_estimated_tokens"],
            payload["result_token_limit"],
        )
```

- [ ] **Step 2: Run the focused test and verify the function is absent**

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_recall_payload_is_the_cli_contract_without_printing -v
```

Expected: FAIL with `AttributeError` for `recall_payload`.

- [ ] **Step 3: Extract the current orchestration**

Create this signature immediately before `recall`:

```python
def recall_payload(
    config: dict[str, Any],
    query: str,
    mode: str,
    top: int | None,
    max_tokens: int | None = None,
    include_stale: bool = False,
    *,
    provider: str | None = None,
    scope: str | None = None,
) -> dict[str, Any]:
```

Move the existing query normalization, scope validation, provider selection, QMD/native execution, fallback, governance compaction, warnings, diagnostics, and payload construction into this function. Apply these exact exception rules:

- empty or over-1,000-character normalized queries raise `ValueError`;
- invalid scopes and provider selection raise `ConfigurationError`;
- explicit QMD runtime/JSON failure raises `RecallProviderError`;
- `auto` retains its current visible native fallback;
- the returned dictionary has the same keys currently printed by `recall`;
- the function does not call `print` or `json_output`.

Replace the CLI wrapper with:

```python
def recall(
    query: str,
    mode: str,
    top: int | None,
    max_tokens: int | None = None,
    include_stale: bool = False,
    *,
    provider: str | None = None,
    scope: str | None = None,
) -> int:
    try:
        config, _ = load_config()
        payload = recall_payload(
            config,
            query,
            mode,
            top,
            max_tokens,
            include_stale,
            provider=provider,
            scope=scope,
        )
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except (ConfigurationError, RecallProviderError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    json_output(payload)
    return 0
```

- [ ] **Step 4: Run the focused test and all existing provider paths**

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_recall_payload_is_the_cli_contract_without_printing \
  ObsidianMemoryTests.test_native_provider_recalls_without_qmd_and_honors_scope \
  ObsidianMemoryTests.test_auto_provider_isolates_qmd_failure_and_falls_back \
  ObsidianMemoryTests.test_auto_fast_provider_falls_back_from_weak_qmd_matches \
  ObsidianMemoryTests.test_auto_semantic_empty_scope_falls_back_to_native_evidence \
  ObsidianMemoryTests.test_compact_recall_results_obey_the_independent_token_budget -v
```

Expected: all pass with unchanged provider, mode, degradation, and token fields.

- [ ] **Step 5: Commit the behavior-neutral extraction**

```bash
git add wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py
git commit -m "refactor(wiki): expose reusable recall payload"
```

### Task 2: Implement the versioned local recall evaluator

**Files:**

- Modify: `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py:56-61,1756-end`
- Test: `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py:end`
- Create: `wiki/plugins/obsidian-memory/evals/recall-evals.example.json`

**Interfaces:**

- Consumes: `recall_payload` from Task 1 and normal configuration.
- Produces: immutable `RecallEvalCase`.
- Produces: `load_recall_eval_suite(path: Path, config: dict[str, Any]) -> list[RecallEvalCase]`.
- Produces: `evaluate_recall_cases(config, cases, *, recall_runner=recall_payload) -> dict[str, Any]`.
- Produces: `evaluate_recall(path: Path, as_json: bool) -> int`.
- Produces: CLI `evaluate FIXTURE [--json]`.

- [ ] **Step 1: Write failing schema, result, and no-body-output tests**

```python
def test_recall_evaluator_checks_paths_degradation_and_hides_bodies(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        vault = self.make_vault(root)
        config_path = self.write_config(root, vault)
        fixture = root / "recall-evals.json"
        fixture.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "cases": [
                        {
                            "id": "current-decision",
                            "query": "secret query text",
                            "mode": "hybrid",
                            "provider": "auto",
                            "scope": "projects/alpha",
                            "top": 3,
                            "max_tokens": 900,
                            "expected_paths": ["projects/alpha/current.md"],
                            "any_of_paths": [],
                            "forbidden_paths": ["projects/alpha/old.md"],
                            "allow_degraded": False,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        payload = {
            "provider": "qmd",
            "requested_provider": "auto",
            "mode": "hybrid",
            "requested_mode": "hybrid",
            "degraded": False,
            "results": [
                {
                    "path": "projects/alpha/current.md",
                    "snippet": "DO NOT PRINT THIS NOTE BODY",
                }
            ],
            "results_estimated_tokens": 42,
            "result_token_limit": 900,
            "filtered_stale": 2,
        }
        with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
            config, _ = MODULE.load_config()
            cases = MODULE.load_recall_eval_suite(fixture, config)
            report = MODULE.evaluate_recall_cases(
                config,
                cases,
                recall_runner=mock.Mock(return_value=payload),
            )
        encoded = json.dumps(report)
        self.assertTrue(report["ok"])
        self.assertEqual(report["cases"][0]["paths"], ["projects/alpha/current.md"])
        self.assertNotIn("secret query text", encoded)
        self.assertNotIn("DO NOT PRINT THIS NOTE BODY", encoded)


def test_recall_eval_fixture_rejects_unknown_fields_and_unsafe_paths(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        vault = self.make_vault(root)
        config_path = self.write_config(root, vault)
        fixture = root / "invalid.json"
        fixture.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "cases": [
                        {
                            "id": "unsafe",
                            "query": "x",
                            "mode": "fast",
                            "provider": "native",
                            "expected_paths": [".raw/secret.md"],
                            "unexpected": True,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
            config, _ = MODULE.load_config()
            with self.assertRaises(MODULE.EvaluationError):
                MODULE.load_recall_eval_suite(fixture, config)
```

- [ ] **Step 2: Run the focused tests and verify evaluator APIs are absent**

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_recall_evaluator_checks_paths_degradation_and_hides_bodies \
  ObsidianMemoryTests.test_recall_eval_fixture_rejects_unknown_fields_and_unsafe_paths -v
```

Expected: FAIL because `load_recall_eval_suite` and `EvaluationError` do not exist.

- [ ] **Step 3: Add the typed case and exact fixture validation**

Add:

```python
class EvaluationError(RuntimeError):
    """Raised when a local recall-evaluation fixture is invalid."""


@dataclass(frozen=True)
class RecallEvalCase:
    id: str
    query: str
    mode: str
    provider: str
    scope: str | None
    top: int | None
    max_tokens: int | None
    expected_paths: tuple[str, ...]
    any_of_paths: tuple[str, ...]
    forbidden_paths: tuple[str, ...]
    allow_degraded: bool
```

`load_recall_eval_suite` must enforce:

- top-level keys exactly `schema_version` and `cases`;
- schema version exactly 1 and at least one case;
- unique non-empty IDs of at most 120 characters;
- allowed case keys exactly `id`, `query`, `mode`, `provider`, `scope`, `top`, `max_tokens`, `expected_paths`, `any_of_paths`, `forbidden_paths`, and `allow_degraded`;
- query normalization identical to recall and a maximum of 1,000 characters;
- modes `fast`, `semantic`, or `hybrid`; providers `auto`, `native`, or `qmd`;
- optional `top` from 1 through 20 and `max_tokens` from 64 through 4,000;
- Boolean `allow_degraded`, default false;
- path arrays containing unique safe vault-relative `.md` paths inside configured recall roots;
- normalized optional scope through `normalize_recall_scope`;
- every expected/any/forbidden path inside the declared scope when a scope exists.

Return `EvaluationError` naming the case ID and field without echoing the query or note content.

- [ ] **Step 4: Implement deterministic evaluation and bounded reporting**

`evaluate_recall_cases` must call `recall_runner` once per case and return:

```python
{
    "ok": True,
    "schema_version": 1,
    "summary": {
        "passed": 1,
        "failed": 0,
        "total": 1,
        "median_elapsed_ms": 0.0,
        "median_result_tokens": 42,
    },
    "cases": [
        {
            "id": "current-decision",
            "passed": True,
            "reasons": [],
            "provider": "qmd",
            "requested_provider": "auto",
            "mode": "hybrid",
            "requested_mode": "hybrid",
            "degraded": False,
            "elapsed_ms": 0.0,
            "result_tokens": 42,
            "filtered_stale": 2,
            "paths": ["projects/alpha/current.md"],
        }
    ],
}
```

Use `time.perf_counter` and `statistics.median`. A case fails when:

- an `expected_paths` member is missing;
- non-empty `any_of_paths` has no returned member;
- a `forbidden_paths` member is returned;
- `degraded` is true while `allow_degraded` is false;
- result tokens exceed the payload's `result_token_limit`; or
- recall raises a runtime/configuration exception.

Failure reasons use fixed codes such as `missing-expected`, `missing-any-of`, `forbidden-returned`, `unexpected-degradation`, `token-limit-exceeded`, and `recall-error`. Do not include queries, snippets, titles, note bodies, exception tracebacks, or absolute paths.

`evaluate_recall` loads configuration and the fixture, prints compact or indented JSON according to `--json`, and returns 0 for all pass, 1 for valid failed cases, and 2 for fixture/configuration errors.
An absolute fixture path is read exactly; a relative fixture path is resolved
from the current working directory. The resolved fixture path is never emitted
in the report.

- [ ] **Step 5: Wire the CLI and add a safe example**

Add:

```python
evaluate_parser = subparsers.add_parser(
    "evaluate",
    help="Run a read-only local recall-contract evaluation",
)
evaluate_parser.add_argument("fixture", type=Path)
evaluate_parser.add_argument("--json", action="store_true", dest="as_json")
```

Dispatch:

```python
if args.command == "evaluate":
    return evaluate_recall(args.fixture, args.as_json)
```

Create `evals/recall-evals.example.json`:

```json
{
  "schema_version": 1,
  "cases": [
    {
      "id": "scoped-current-decision",
      "query": "portable provider boundary",
      "mode": "fast",
      "provider": "native",
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

- [ ] **Step 6: Run evaluator tests and commit**

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_recall_evaluator_checks_paths_degradation_and_hides_bodies \
  ObsidianMemoryTests.test_recall_eval_fixture_rejects_unknown_fields_and_unsafe_paths -v
git add wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  wiki/plugins/obsidian-memory/evals/recall-evals.example.json
git commit -m "feat(wiki): add executable local recall evaluation"
```

Expected: both tests pass and the commit contains only evaluator code, tests, and the safe example.

### Task 3: Parse bounded scalar and list frontmatter

**Files:**

- Modify: `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py:760-779`
- Test: `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py:915-941`

**Interfaces:**

- Produces: `FrontmatterValue = str | list[str]`.
- Produces: `parse_frontmatter_document(path: Path, limit: int = 12_000) -> dict[str, FrontmatterValue]`.
- Preserves: `parse_frontmatter(path, limit=12_000) -> dict[str, str]` for recall callers.

- [ ] **Step 1: Write failing scalar/list parsing tests**

```python
def test_frontmatter_document_parses_bounded_scalar_and_list_values(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        note = Path(temp) / "note.md"
        note.write_text(
            "---\n"
            "memory_class: fact\n"
            "status: verified\n"
            "source:\n"
            "  - https://example.test/primary\n"
            "  - explicit user confirmation\n"
            "verified_by: deterministic test\n"
            "---\n"
            "BODY MUST NOT ENTER METADATA\n",
            encoding="utf-8",
        )
        metadata = MODULE.parse_frontmatter_document(note)
        self.assertEqual(metadata["memory_class"], "fact")
        self.assertEqual(
            metadata["source"],
            ["https://example.test/primary", "explicit user confirmation"],
        )
        self.assertEqual(metadata["verified_by"], "deterministic test")
        self.assertNotIn("BODY MUST NOT ENTER METADATA", repr(metadata))
```

- [ ] **Step 2: Run the test and verify the rich parser is absent**

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_frontmatter_document_parses_bounded_scalar_and_list_values -v
```

Expected: FAIL with `AttributeError` for `parse_frontmatter_document`.

- [ ] **Step 3: Implement the bounded parser**

The parser accepts only the first frontmatter block within the character limit:

- top-level `key: scalar`;
- top-level `key:` followed by indented `- value` items;
- single- or double-quoted scalar/list values with the matching outer quotes removed;
- comments, nested mappings, folded blocks, anchors, tags, and arbitrary YAML objects are ignored rather than executed.

Add:

```python
FrontmatterValue = str | list[str]


def parse_frontmatter(path: Path, limit: int = 12_000) -> dict[str, str]:
    document = parse_frontmatter_document(path, limit)
    return {
        key: value
        for key, value in document.items()
        if isinstance(value, str)
    }
```

This compatibility wrapper must preserve all current recall metadata behavior, including scalar `superseded_by`.

- [ ] **Step 4: Run parser, validity, and supersession tests**

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_frontmatter_document_parses_bounded_scalar_and_list_values \
  ObsidianMemoryTests.test_validity_window_hides_future_notes_and_flags_bad_dates \
  ObsidianMemoryTests.test_supersession_follows_source_relative_chain_to_current_decision -v
```

Expected: all pass.

- [ ] **Step 5: Commit bounded metadata parsing**

```bash
git add wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py
git commit -m "feat(wiki): parse governed frontmatter lists safely"
```

### Task 4: Add bounded governance audit core and CLI

**Files:**

- Modify: `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py:50-61,1703-end`
- Test: `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py:end`

**Interfaces:**

- Consumes: `parse_frontmatter_document`, configured recall roots, and safe path helpers.
- Produces: immutable `AuditFinding(severity, code, path, field, detail)`.
- Produces: `governance_findings(path, vault_relative, metadata) -> list[AuditFinding]`.
- Produces: `audit_vault(config) -> dict[str, Any]`.
- Produces: `audit(as_json: bool) -> int` and CLI `audit [--json]`.

- [ ] **Step 1: Write failing governance/selectivity tests**

```python
def test_audit_checks_action_memory_but_ignores_ordinary_legacy_notes(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        vault = self.make_vault(root)
        good = vault / "wiki" / "good-fact.md"
        good.write_text(
            "---\n"
            "memory_class: fact\n"
            "status: verified\n"
            "source:\n"
            "  - https://example.test/primary\n"
            "verified_by: deterministic test\n"
            "valid_from: 2026-08-01\n"
            "valid_until: 2026-08-31\n"
            "---\n# Good\n",
            encoding="utf-8",
        )
        bad = vault / "wiki" / "bad-decision.md"
        bad.write_text(
            "---\nmemory_class: decision\nstatus: accepted\n"
            "valid_from: 2026-09-02\nvalid_until: 2026-09-01\n---\n",
            encoding="utf-8",
        )
        (vault / "wiki" / "legacy.md").write_text("# Legacy narrative\n", encoding="utf-8")
        config_path = self.write_config(root, vault, recall_roots=["wiki"])
        with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
            config, _ = MODULE.load_config()
            report = MODULE.audit_vault(config)
        codes = {(item["path"], item["code"]) for item in report["findings"]}
        self.assertNotIn(("wiki/good-fact.md", "missing-source"), codes)
        self.assertIn(("wiki/bad-decision.md", "missing-verification"), codes)
        self.assertIn(("wiki/bad-decision.md", "invalid-validity-order"), codes)
        self.assertFalse(any(path == "wiki/legacy.md" for path, _code in codes))
```

- [ ] **Step 2: Run the focused test and verify audit is absent**

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_audit_checks_action_memory_but_ignores_ordinary_legacy_notes -v
```

Expected: FAIL with `AttributeError` for `audit_vault`.

- [ ] **Step 3: Implement finding types and action-driving rules**

Add `MAX_AUDIT_FINDINGS = 200` and:

```python
@dataclass(frozen=True)
class AuditFinding:
    severity: str
    code: str
    path: str
    field: str | None
    detail: str

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "severity": self.severity,
            "code": self.code,
            "path": self.path,
            "detail": self.detail,
        }
        if self.field:
            payload["field"] = self.field
        return payload
```

`governance_findings` enforces:

- recognized statuses are `candidate`, `proposed`, `verified`, `accepted`, `active`, `superseded`, `deprecated`, and `rejected`;
- `fact` requires status and non-empty scalar/list `source`; a current fact also requires `verified_by`;
- `decision` requires status; an accepted/current decision requires non-empty `source` or `verified_by`;
- `heuristic` requires status and source; a current heuristic also requires `verified_by`;
- candidate/proposed facts and heuristics may be unverified;
- optional confidence, when present, is `low`, `medium`, or `high`;
- optional `observed`, `valid_from`, and `valid_until` values are exact ISO dates, not accepted by truncating extra suffixes;
- `valid_until` earlier than `valid_from` is `invalid-validity-order`;
- `task` and `episode` receive no action-driving requirements;
- unknown non-empty `memory_class` is a warning;
- missing required fields and malformed values are errors.

Use fixed codes and details; never include a frontmatter value or body excerpt in a finding.

- [ ] **Step 4: Implement safe deterministic scanning and report bounds**

Walk each configured recall root in sorted order with `os.walk(..., followlinks=False)`. Reject or report root/file symlinks, skip dot-prefixed directories, read only case-insensitive `.md` files, deduplicate resolved paths, and stop appending findings after `MAX_AUDIT_FINDINGS`.

Return:

```python
{
    "ok": error_count == 0,
    "roots": sorted(config["recall_roots"]),
    "files_scanned": files_scanned,
    "truncated": findings_truncated,
    "counts": {"errors": error_count, "warnings": warning_count},
    "findings": [finding.as_dict() for finding in bounded_findings],
}
```

Add CLI parsing and dispatch:

```python
audit_parser = subparsers.add_parser(
    "audit",
    help="Run a bounded read-only governance and routing audit",
)
audit_parser.add_argument("--json", action="store_true", dest="as_json")
```

`audit` returns 0 when there are no errors, 1 when valid audit errors exist, and 2 for configuration failure. Human output is a bounded summary plus one line per finding; JSON output uses the report above.

- [ ] **Step 5: Run audit tests and commit**

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_audit_checks_action_memory_but_ignores_ordinary_legacy_notes \
  ObsidianMemoryTests.test_frontmatter_document_parses_bounded_scalar_and_list_values -v
git add wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py
git commit -m "feat(wiki): audit governed memory metadata"
```

Expected: both tests pass.

### Task 5: Extend audit to supersession, commit roots, and provider health

**Files:**

- Modify: `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py:667-757,audit section`
- Test: `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py:312-325,end`

**Interfaces:**

- Consumes: `follow_supersession_chain`, exact commit safety helpers, `recall_provider_status`, and `qmd_status`.
- Produces: route/configuration findings in the existing audit report.
- Extends: QMD provider status with installed version while preserving existing keys.

- [ ] **Step 1: Write failing route, symlink, and provider-version tests**

```python
def test_audit_reports_broken_supersession_and_never_follows_symlinks(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        vault = self.make_vault(root)
        decisions = vault / "projects" / "alpha" / "decisions"
        decisions.mkdir()
        old = decisions / "old.md"
        old.write_text(
            '---\nstatus: superseded\nsuperseded_by: "[[missing]]"\n---\n',
            encoding="utf-8",
        )
        outside = root / "outside.md"
        outside.write_text("PRIVATE SENTINEL", encoding="utf-8")
        (vault / "wiki" / "escaped.md").symlink_to(outside)
        config_path = self.write_config(root, vault)
        with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
            config, _ = MODULE.load_config()
            report = MODULE.audit_vault(config)
        codes = {(item["path"], item["code"]) for item in report["findings"]}
        self.assertIn(
            ("projects/alpha/decisions/old.md", "supersession-missing"),
            codes,
        )
        self.assertIn(("wiki/escaped.md", "symlink-file"), codes)
        self.assertNotIn("PRIVATE SENTINEL", json.dumps(report))


def test_qmd_status_reports_bounded_installed_version(self) -> None:
    config = {
        "qmd_enabled": True,
        "qmd_collections": ["obsidian-wiki"],
    }
    version = subprocess.CompletedProcess(
        ["qmd", "--version"], 0, stdout="qmd 2.8.3\n", stderr=""
    )
    status = subprocess.CompletedProcess(
        ["qmd", "status"], 0, stdout="healthy\n", stderr=""
    )
    with (
        mock.patch.object(MODULE.shutil, "which", return_value="/tmp/qmd"),
        mock.patch.object(MODULE.subprocess, "run", side_effect=[version, status]),
    ):
        report = MODULE.qmd_status(config)
    self.assertEqual(report["version"], "qmd 2.8.3")
    self.assertTrue(report["healthy"])
```

- [ ] **Step 2: Run the focused tests and verify missing findings/version**

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_audit_reports_broken_supersession_and_never_follows_symlinks \
  ObsidianMemoryTests.test_qmd_status_reports_bounded_installed_version -v
```

Expected: FAIL because the audit omits route/symlink findings and QMD status omits `version`.

- [ ] **Step 3: Add shared supersession findings**

For every safely scanned note with non-empty scalar `superseded_by`, call:

```python
result = follow_supersession_chain(
    config,
    source_path=path,
    source_relative=vault_relative,
    metadata=parse_frontmatter(path),
    allowed_roots=config["recall_roots"],
)
```

Map issues to fixed error codes:

- `missing` or `missing-reference` -> `supersession-missing`;
- `ambiguous` -> `supersession-ambiguous`;
- `cycle` -> `supersession-cycle`;
- `hop-limit` -> `supersession-hop-limit`;
- `unsafe` -> `supersession-unsafe`;
- `out-of-root` -> `supersession-out-of-root`;
- `non-markdown` -> `supersession-non-markdown`.

A source marked stale without a non-empty successor gets `stale-without-successor`. Do not audit query-dependent scope; scope isolation remains a recall/evaluator test.

- [ ] **Step 4: Add safe-root, commit-root, and provider findings**

Add these deterministic checks:

- missing recall root -> error `missing-recall-root`;
- recall-root symlink -> error `symlink-root`;
- encountered file symlink -> error `symlink-file` without reading its target;
- configured commit root with absolute/parent/private segments, vault escape, symlink, or non-directory/non-Markdown shape -> error using `commit-root-*` codes;
- QMD collection mapping outside configured recall roots -> error `qmd-root-outside-recall`;
- enabled QMD collection with missing/symlinked root -> error;
- unavailable or unhealthy configured QMD -> warning when `auto` can use native, error when configured provider is strict `qmd`.

Extend `qmd_status` to run `[executable, "--version"]` with a five-second timeout before the existing status probe. Store only `clipped_line(stdout or stderr, 120)` under `version`. Update existing subprocess mocks to return both calls.

Attach a bounded provider summary to the audit report containing canonical provider name, configured/active recall provider, QMD enabled/available/healthy/version, and configured collection names. Do not include absolute executable, cache, config, or vault paths.

- [ ] **Step 5: Run focused and complete tests, then commit**

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_audit_reports_broken_supersession_and_never_follows_symlinks \
  ObsidianMemoryTests.test_qmd_status_reports_bounded_installed_version \
  ObsidianMemoryTests.test_provider_status_keeps_markdown_canonical \
  ObsidianMemoryTests.test_supersession_follows_source_relative_chain_to_current_decision -v
python3 wiki/scripts/check.py
git add wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py
git commit -m "feat(wiki): audit memory routing and provider health"
```

Expected: focused tests and the complete wiki suite pass.

### Task 6: Check the schema and document the manual tools

**Files:**

- Modify: `wiki/scripts/check.py:182-241`
- Modify: `wiki/README.md:90-150`
- Modify: `wiki/ARCHITECTURE.md:20-75`
- Modify: `wiki/plugins/obsidian-memory/skills/obsidian-memory/SKILL.md:30-70`
- Modify: `wiki/plugins/obsidian-memory/skills/obsidian-memory/references/evaluation.md:1-end`
- Modify: `wiki/plugins/obsidian-memory/skills/obsidian-memory/references/memory-governance.md:20-125`
- Modify: `wiki/plugins/obsidian-memory/skills/obsidian-memory/references/recall-providers.md:45-115`

**Interfaces:**

- Consumes: executable evaluator/audit behavior from Tasks 1-5.
- Produces: repository-enforced schemas and operator guidance.

- [ ] **Step 1: Add failing static validation for the example and command documentation**

In `validate_memory_policy`, load `plugins/obsidian-memory/evals/recall-evals.example.json` and enforce schema version 1, unique case IDs, exact mode/provider enums, Boolean `allow_degraded`, and safe `.md` expectation paths. Also require these phrases from the references:

```python
required_documentation = {
    evaluation: ("evaluate", "retrieval contract", "does not grade model answers"),
    governance: ("audit", "action-driving", "never auto-fixes"),
    providers: ("effective provider", "degradation", "note bodies"),
}
for document, terms in required_documentation.items():
    text = document.read_text(encoding="utf-8")
    for term in terms:
        require(term in text, f"{document.name}: missing documented contract: {term}")
```

- [ ] **Step 2: Verify the documentation gate fails**

```bash
python3 wiki/scripts/check.py --skip-tests
```

Expected: FAIL on the first missing command contract.

- [ ] **Step 3: Document exact commands, exits, and boundaries**

Add:

```markdown
python3 plugins/obsidian-memory/scripts/obsidian_memory.py \
  evaluate /path/to/recall-evals.json --json
python3 plugins/obsidian-memory/scripts/obsidian_memory.py audit --json
```

Document:

- evaluator exit 0 all pass, 1 valid failed cases, 2 invalid fixture/configuration;
- audit exit 0 no errors, 1 findings containing errors, 2 configuration failure;
- evaluator output has case IDs, provider/mode, degradation, timing, token count, stale count, and paths, never queries or note bodies;
- audit output has bounded codes and vault-relative paths, never note bodies;
- QMD `bench` remains the raw engine precision/recall/MRR/F1 tool;
- existing `memory-evals.json` remains the agent-behavior suite and is not automatically graded by the retrieval evaluator;
- both commands are manual and absent from SessionStart and Stop hooks;
- the action-driving metadata matrix exactly matches the approved design;
- findings never auto-fix, rename, delete, refresh, embed, or commit.

- [ ] **Step 4: Run final plan verification**

```bash
python3 wiki/scripts/check.py
python3 scripts/plugins.py check
git diff --check
git status --short
```

Expected: both suites pass and only the seven documentation/checker files are modified after Task 5.

- [ ] **Step 5: Commit the evaluated/audited operator contract**

```bash
git add wiki/scripts/check.py wiki/README.md wiki/ARCHITECTURE.md \
  wiki/plugins/obsidian-memory/skills/obsidian-memory/SKILL.md \
  wiki/plugins/obsidian-memory/skills/obsidian-memory/references/evaluation.md \
  wiki/plugins/obsidian-memory/skills/obsidian-memory/references/memory-governance.md \
  wiki/plugins/obsidian-memory/skills/obsidian-memory/references/recall-providers.md
git commit -m "docs(wiki): define memory evaluation and audit workflows"
```
