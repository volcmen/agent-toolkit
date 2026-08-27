# Governed Global Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal, governed global-memory layer to the existing shared Obsidian-memory plugin, enforce it identically for Codex and Claude Code, and migrate only the already-evidenced Agent Toolkit registry record.

**Architecture:** Markdown plus Git remains the sole writable authority. `wiki/global/records/` is a logical namespace inside the configured vault; the existing Python runtime validates its flat frontmatter, applies sensitivity filtering after provider discovery and before L1 output, and exposes the same behavior to native and QMD recall. The project-owned installer writes Claude's global rule and a bounded managed block in Codex's global `AGENTS.md`; the workspace installer repairs and reports this guidance without duplicating policy-writing logic.

**Tech Stack:** Python 3.11+ standard library, `unittest`, Markdown/Obsidian wikilinks, JSON configuration and eval fixtures, Git, QMD 2.8.3 as a disposable local index, Codex CLI, Claude Code CLI.

**Spec:** `wiki/docs/superpowers/specs/2026-08-27-governed-global-memory-design.md`

## Global constraints

- Work in an isolated worktree created with `superpowers:using-git-worktrees` before changing runtime code.
- Preserve the untracked workspace file `download.html`; it is unrelated user-owned work.
- Use `apply_patch` for hand-authored edits.
- Do not edit generated plugin manifests. `plugins.json` remains their authority.
- Do not run `wiki/scripts/update.py`; it is a mutating release operation outside this change.
- Do not add Restate, OpenWiki, Vouch, Basic Memory, OpenViking, a second database, or a second writable memory representation.
- Do not write identity, approval, health, finance, dating, employment, or other personal-profile records during the initial migration.
- Treat private and restricted record bodies as excluded by default, including during QMD fallback and supersession redirects.
- Keep startup output L0-sized: a route to global memory is allowed; global record bodies are not.
- Run `python3 wiki/scripts/check.py` and `python3 scripts/plugins.py check` after plugin changes.
- Keep the workspace implementation and the vault migration in separate Git commits and repositories.
- The real vault currently has seven unrelated governance errors. Acceptance is no new global-memory error and a passing migrated record, not a falsely claimed zero-error whole-vault audit.

---

### Task 1: Add and validate the global-memory root configuration

**Files:**

- Modify: `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py`
- Modify: `wiki/plugins/obsidian-memory/config.example.json`
- Modify: `wiki/scripts/install.py`
- Modify: `wiki/scripts/check.py`
- Test: `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py`

- [ ] **Step 1: Write failing runtime configuration tests**

Add tests to `ObsidianMemoryTests` covering the default, normalization, containment, unsafe paths, and explicit missing-root marker:

```python
def test_global_memory_root_defaults_inside_recall_roots(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        vault = self.make_vault(root)
        config_path = self.write_config(root, vault)
        with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
            config, _ = MODULE.load_config()
        self.assertEqual(config["global_memory_root"], "wiki/global")
        self.assertTrue(config["_global_memory_root_from_defaults"])

def test_explicit_global_memory_root_must_be_safe_and_recalled(self) -> None:
    cases = ("../global", ".private/global", "inbox/global", "outside/global")
    for value in cases:
        with self.subTest(value=value), tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            config_path = self.write_config(root, vault, global_memory_root=value)
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                with self.assertRaises(MODULE.ConfigurationError):
                    MODULE.load_config()

def test_explicit_missing_global_memory_root_is_remembered_for_audit(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        vault = self.make_vault(root)
        config_path = self.write_config(root, vault, global_memory_root="wiki/global")
        with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
            config, _ = MODULE.load_config()
        self.assertFalse(config["_global_memory_root_from_defaults"])
        self.assertFalse((vault / config["global_memory_root"]).exists())
```

- [ ] **Step 2: Run the runtime test file and confirm the new tests fail**

Run:

```bash
python3 -m unittest discover -s wiki/plugins/obsidian-memory/tests -p 'test_obsidian_memory.py' -v
```

Expected: the new tests fail because `global_memory_root` is not in `DEFAULTS` or validated.

- [ ] **Step 3: Implement the safe configuration boundary**

Add to `DEFAULTS`:

```python
"global_memory_root": "wiki/global",
```

In `load_config()`, after normalizing `recall_roots`, validate `global_memory_root` with the same lexical safety rules and require that it equals or descends from a configured recall root. Preserve whether the user configured it explicitly:

```python
raw_global_root = config.get("global_memory_root")
if (
    not isinstance(raw_global_root, str)
    or not raw_global_root.strip()
    or len(raw_global_root) > MAX_PROJECTED_CONFIG_PATH_CHARS
):
    raise ConfigurationError(
        f"{path} field 'global_memory_root' must be a safe vault-relative path"
    )
global_relative = PurePosixPath(raw_global_root)
if (
    global_relative.is_absolute()
    or not global_relative.parts
    or ".." in global_relative.parts
    or not safe_recall_parts(global_relative.parts)
):
    raise ConfigurationError(
        f"{path} field 'global_memory_root' must be a safe vault-relative path"
    )
global_root = global_relative.as_posix()
if not any(path_in_scope(global_root, root) for root in normalized_recall_roots):
    raise ConfigurationError(
        f"{path} field 'global_memory_root' must be contained by recall_roots"
    )
config["global_memory_root"] = global_root
config["_global_memory_root_from_defaults"] = "global_memory_root" not in raw
```

If `path_in_scope` is defined later in the module, introduce the dependency-free helper beside `safe_recall_parts` and use it from both locations:

```python
def relative_path_is_within(path: str, root: str) -> bool:
    path_parts = PurePosixPath(path).parts
    root_parts = PurePosixPath(root).parts
    return path_parts[: len(root_parts)] == root_parts
```

- [ ] **Step 4: Put the setting in generated local configuration and static validation**

Add this field to both `wiki/scripts/install.py::configure()` and `config.example.json`:

```json
"global_memory_root": "wiki/global"
```

In `wiki/scripts/check.py::validate_config_example()`, require `global_memory_root` to pass `safe_indexed_path()` and to be contained by at least one `recall_roots` entry. Do not add `include_sensitive_by_default`; default exclusion is a runtime invariant, not a user-tunable setting.

- [ ] **Step 5: Run focused and project checks**

Run:

```bash
python3 -m unittest discover -s wiki/plugins/obsidian-memory/tests -p 'test_obsidian_memory.py' -v
python3 wiki/scripts/check.py
```

Expected: all tests pass and the wiki checker reports success.

- [ ] **Step 6: Commit the configuration slice**

```bash
git add wiki/plugins/obsidian-memory/scripts/obsidian_memory.py wiki/plugins/obsidian-memory/config.example.json wiki/scripts/install.py wiki/scripts/check.py wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py
git commit -m "feat(memory): configure governed global root"
```

---

### Task 2: Enforce the global record schema in the existing audit

**Files:**

- Modify: `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py`
- Modify: `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py`
- Modify: `wiki/scripts/check.py`

- [ ] **Step 1: Add a test helper for valid global records**

Add to `ObsidianMemoryTests`:

```python
def write_global_record(
    self,
    vault: Path,
    relative: str = "wiki/global/records/project-registry/agent-toolkit.md",
    **overrides: str,
) -> Path:
    values = {
        "id": "global.project_registry.agent_toolkit",
        "memory_class": "fact",
        "scope": "global",
        "owner": "david",
        "category": "project_registry",
        "statement": "Agent Toolkit is David's cross-agent plugin workspace.",
        "status": "verified",
        "evidence_type": "environment_verified",
        "confidence": "high",
        "stability": "review_periodically",
        "sensitivity": "internal",
        "observed": "2026-08-27",
        "verified_by": "repository and installed-state checks",
    }
    values.update(overrides)
    path = vault / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["---"]
    lines.extend(f'{key}: "{value}"' for key, value in values.items())
    lines.extend(["source:", '  - "repository README at cd73ba2"', "---", "# Agent Toolkit", ""])
    path.write_text("\n".join(lines), encoding="utf-8")
    return path
```

- [ ] **Step 2: Write failing schema and contamination tests**

Cover all fixed invariants with isolated subtests:

```python
def test_global_record_contract_accepts_one_valid_atomic_record(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        vault = self.make_vault(root)
        self.write_global_record(vault)
        config_path = self.write_config(root, vault, global_memory_root="wiki/global")
        with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
            config, _ = MODULE.load_config()
            report = MODULE.audit_vault(config)
        global_codes = [
            item["code"] for item in report["findings"] if item["code"].startswith("global-")
        ]
        self.assertEqual(global_codes, [])

def test_global_record_contract_reports_each_invalid_field_without_values(self) -> None:
    cases = {
        "id": ("not-global", "global-invalid-id"),
        "scope": ("project", "global-invalid-scope"),
        "owner": ("someone", "global-invalid-owner"),
        "category": ("project_state", "global-invalid-category"),
        "statement": ("", "global-missing-statement"),
        "evidence_type": ("model_summary", "global-invalid-evidence-type"),
        "stability": ("forever", "global-invalid-stability"),
        "sensitivity": ("secretish", "global-invalid-sensitivity"),
    }
    for field, (value, expected_code) in cases.items():
        with self.subTest(field=field), tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            vault = self.make_vault(root)
            self.write_global_record(vault, **{field: value})
            config_path = self.write_config(root, vault, global_memory_root="wiki/global")
            with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
                config, _ = MODULE.load_config()
                report = MODULE.audit_vault(config)
            matches = [item for item in report["findings"] if item["code"] == expected_code]
            self.assertEqual(len(matches), 1)
            self.assertNotIn(value, json.dumps(matches))
```

Add separate tests proving:

- two records with the same ID produce `global-duplicate-id` on both paths;
- `global.*` outside `<global_memory_root>/records` produces `global-misplaced-record`;
- a file inside the records tree without a valid global ID produces `global-invalid-id`;
- `assistant_recommended` or `inferred` with `verified`, `accepted`, or `active` produces `global-unconfirmed-current`;
- `time_sensitive` without `valid_until` produces `global-missing-valid-until`;
- a statement longer than 600 characters produces `global-statement-too-long`;
- an explicitly configured missing root produces `global-missing-root`, while a defaulted absent root remains backward compatible;
- a symlinked global root produces `global-symlink-root` and is not traversed.

- [ ] **Step 3: Run the audit tests and confirm failure**

```bash
python3 -m unittest discover -s wiki/plugins/obsidian-memory/tests -p 'test_obsidian_memory.py' -v
```

Expected: new global-audit assertions fail because the specialized validator does not exist.

- [ ] **Step 4: Add bounded global-schema constants**

Place these beside the existing audit constants:

```python
GLOBAL_ID_RE = re.compile(
    r"global\.(identity|communication|operating_principle|approval_policy|"
    r"technical_environment|recurring_goal|project_registry|privacy|preference|"
    r"constraint)\.[a-z0-9][a-z0-9_-]{0,79}"
)
GLOBAL_CATEGORIES = {
    "identity",
    "communication",
    "operating_principle",
    "approval_policy",
    "technical_environment",
    "recurring_goal",
    "project_registry",
    "privacy",
    "preference",
    "constraint",
}
GLOBAL_EVIDENCE_TYPES = {
    "user_stated",
    "user_confirmed",
    "repeated_user_pattern",
    "environment_verified",
    "assistant_recommended",
    "inferred",
}
GLOBAL_STABILITIES = {"durable", "review_periodically", "time_sensitive"}
GLOBAL_SENSITIVITIES = {"public", "internal", "private", "restricted"}
MAX_GLOBAL_STATEMENT_CHARS = 600
```

- [ ] **Step 5: Add the specialized validator without weakening generic governance**

Add `global_record_findings(vault_relative, metadata)` that emits only fixed, value-free `AuditFinding.detail` strings. It must validate required scalar/list presence, category-to-ID agreement, `scope: global`, `owner: david`, statement length, evidence/status compatibility, and temporal qualification. It must not replace `governance_findings()`; call both.

Use path classification based on normalized `PurePosixPath.parts`, not substring matching:

```python
def global_records_prefix(config: dict[str, Any]) -> str:
    return f"{config['global_memory_root'].rstrip('/')}/records"

def is_global_record_path(config: dict[str, Any], vault_relative: str) -> bool:
    return relative_path_is_within(vault_relative, global_records_prefix(config))
```

In `audit_vault()`, collect IDs before returning so duplicates are order-independent:

```python
global_id_paths: dict[str, list[str]] = {}
```

For every scanned Markdown file, call the specialized validator when it lies in the records tree. If metadata contains a scalar ID beginning with `global.` outside the tree, record `global-misplaced-record`. After traversal, record `global-duplicate-id` for each path associated with an ID whose path list has more than one member.

Before scan traversal, inspect the configured global root. An explicitly configured missing root records `global-missing-root`; a symlink records `global-symlink-root`. Do not follow the symlink. The global root README is routing documentation and is exempt from record fields.

- [ ] **Step 6: Mirror new constants and structural assertions in the project checker**

Add static checks in `wiki/scripts/check.py` that confirm the runtime declares all ten categories, six evidence types, four sensitivity levels, and `MAX_GLOBAL_STATEMENT_CHARS == 600`. Confirm `global-memory/SKILL.md` will be required once Task 4 creates it; do not introduce that file requirement early enough to break this task's commit.

- [ ] **Step 7: Run focused tests and the full wiki suite**

```bash
python3 -m unittest discover -s wiki/plugins/obsidian-memory/tests -p 'test_obsidian_memory.py' -v
python3 wiki/scripts/check.py
```

Expected: all schema, generic governance, supersession, provider, and existing regression tests pass.

- [ ] **Step 8: Commit the audit slice**

```bash
git add wiki/plugins/obsidian-memory/scripts/obsidian_memory.py wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py wiki/scripts/check.py
git commit -m "feat(memory): audit governed global records"
```

---

### Task 3: Gate sensitive recall identically for native and QMD providers

**Files:**

- Modify: `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py`
- Modify: `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py`
- Modify: `wiki/plugins/obsidian-memory/evals/recall-evals.example.json`
- Modify: `wiki/plugins/obsidian-memory/skills/obsidian-memory/references/recall-providers.md`
- Modify: `wiki/README.md`

- [ ] **Step 1: Write failing compaction and CLI tests**

Add tests that construct public, internal, private, and restricted records, then feed provider-shaped rows directly to `compact_recall_results()`:

```python
def test_compaction_excludes_sensitive_results_for_every_provider(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        vault = self.make_vault(root)
        public = self.write_global_record(
            vault,
            "wiki/global/records/project-registry/public.md",
            id="global.project_registry.public",
            sensitivity="public",
        )
        private = self.write_global_record(
            vault,
            "wiki/global/records/privacy/private.md",
            id="global.privacy.private",
            category="privacy",
            sensitivity="private",
        )
        config_path = self.write_config(root, vault, global_memory_root="wiki/global")
        rows = [
            {"path": str(public.relative_to(vault)), "snippet": "public"},
            {"path": str(private.relative_to(vault)), "snippet": "private"},
        ]
        with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
            config, _ = MODULE.load_config()
        for provider in ("native", "qmd"):
            with self.subTest(provider=provider):
                counts: dict[str, int] = {}
                compact, _ = MODULE.compact_recall_results(
                    config,
                    rows,
                    limit=5,
                    max_tokens=900,
                    include_stale=False,
                    provider=provider,
                    filter_counts=counts,
                )
                self.assertEqual([item["path"] for item in compact], [str(public.relative_to(vault))])
                self.assertEqual(counts, {"sensitive": 1})
```

Add tests proving:

- `include_sensitive=True` without `scope` raises `ValueError` before provider execution;
- scopes `wiki`, `projects`, `daily`, `wiki/global`, and `wiki/global/records` are rejected as broad;
- `wiki/global/records/privacy` and a deeper project-sensitive directory are accepted;
- the explicit flag plus narrow scope returns private/restricted records within that scope;
- a stale record redirecting to a sensitive successor does not leak the successor;
- an auto-provider QMD-empty/native-fallback path preserves `filtered_sensitive` and never returns a sensitive result;
- `qmd_recall()` compatibility retains `include_sensitive=False`;
- parser help contains `--include-sensitive`.

- [ ] **Step 2: Run the runtime tests and confirm failure**

```bash
python3 -m unittest discover -s wiki/plugins/obsidian-memory/tests -p 'test_obsidian_memory.py' -v
```

Expected: tests fail on unknown `filter_counts`, missing flag, and absent filtering.

- [ ] **Step 3: Implement narrow-scope validation**

Add:

```python
def validate_sensitive_scope(config: dict[str, Any], scope: str | None) -> str:
    normalized = normalize_recall_scope(scope)
    if normalized is None:
        raise ValueError("--include-sensitive requires an explicit narrow --scope")
    broad = {
        *config["recall_roots"],
        config["global_memory_root"],
        f"{config['global_memory_root'].rstrip('/')}/records",
    }
    if normalized in broad:
        raise ValueError("--include-sensitive requires a scope below a broad recall root")
    return normalized

def metadata_is_sensitive(metadata: dict[str, str]) -> bool:
    return metadata.get("sensitivity") in {"private", "restricted"}
```

In `recall_payload()`, normalize with `validate_sensitive_scope()` only when the explicit flag is true. The check must execute before `select_recall_provider()` or either provider function.

- [ ] **Step 4: Enforce sensitivity in the shared compactor and redirects**

Extend the compatibility-preserving signature:

```python
def compact_recall_results(
    config: dict[str, Any],
    raw_results: Any,
    *,
    limit: int,
    max_tokens: int,
    include_stale: bool,
    include_sensitive: bool = False,
    filter_counts: dict[str, int] | None = None,
    scope: str | None = None,
    provider: str = "native",
) -> tuple[list[dict[str, Any]], int]:
```

At the start of the compactor, call `validate_sensitive_scope(config, scope)`
when `include_sensitive` is true. This duplicates the public-entry-point guard
at the final enforcement boundary, so a future internal caller cannot bypass
the narrow-scope requirement.

After parsing frontmatter and before building a hit, increment `filter_counts["sensitive"]` and continue when the record is private/restricted and `include_sensitive` is false. Pass the same decision into `supersession_redirect()` and reject a sensitive successor there before its body or title is read into an L1 hit.

Keep the two-item return tuple unchanged. In `recall_payload()`, use a counts dictionary for both primary and native fallback compaction and expose:

```python
"filtered_sensitive": filter_counts.get("sensitive", 0),
```

When fallback replaces QMD output, report the native fallback count associated with the returned result set; do not add provider counts that were never returned.

- [ ] **Step 5: Thread the explicit flag through CLI and evaluation**

Add `include_sensitive: bool` to `RecallEvalCase`, add `include_sensitive` to `_RECALL_EVAL_CASE_KEYS`, validate it as an optional boolean defaulting to false, pass it as a keyword to the recall runner, and require non-negative `filtered_sensitive` in `_evaluation_payload_fields()`. Include `filtered_sensitive` in each bounded case report.

Add to the recall parser:

```python
recall_parser.add_argument(
    "--include-sensitive",
    action="store_true",
    help="Include private or restricted records only within an explicit narrow scope",
)
```

Thread `args.include_sensitive` into `recall()`, then into `recall_payload()` as a keyword argument. Keep existing positional arguments stable.

- [ ] **Step 6: Extend the portable eval fixture**

Add fixture cases using checked-in non-sensitive synthetic paths to prove ordinary recall's contract, and add unit-test-only temporary private fixtures to prove sensitive access. Do not check private user data or a machine-local vault path into the repository. Update the fixture parser tests so an `include_sensitive` value other than a JSON boolean fails as `fixture-error`.

- [ ] **Step 7: Document the operator contract**

Update `recall-providers.md` and `wiki/README.md` with exact examples:

```bash
python3 plugins/obsidian-memory/scripts/obsidian_memory.py recall "project registry" --scope wiki/global/records/project-registry
python3 plugins/obsidian-memory/scripts/obsidian_memory.py recall "private rule" --scope wiki/global/records/privacy --include-sensitive
```

State that the second form is the only sensitive path: explicit flag plus scope below a broad root. State that QMD ranking cannot override the final filter.

- [ ] **Step 8: Run focused, evaluation, and full checks**

```bash
python3 -m unittest discover -s wiki/plugins/obsidian-memory/tests -p 'test_obsidian_memory.py' -v
python3 wiki/scripts/check.py
python3 scripts/plugins.py check
```

Expected: the full existing suite plus new sensitive branches pass.

- [ ] **Step 9: Commit the privacy slice**

```bash
git add wiki/plugins/obsidian-memory/scripts/obsidian_memory.py wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py wiki/plugins/obsidian-memory/evals/recall-evals.example.json wiki/plugins/obsidian-memory/skills/obsidian-memory/references/recall-providers.md wiki/README.md
git commit -m "feat(memory): gate sensitive recall"
```

---

### Task 4: Add the portable global-memory curator skill and policy route

**Files:**

- Create: `wiki/plugins/obsidian-memory/skills/global-memory/SKILL.md`
- Create: `wiki/plugins/obsidian-memory/skills/global-memory/references/global-memory-governance.md`
- Modify: `wiki/plugins/obsidian-memory/skills/obsidian-memory/SKILL.md`
- Modify: `wiki/plugins/obsidian-memory/rules/obsidian-vault.md`
- Modify: `wiki/plugins/obsidian-memory/evals/memory-evals.json`
- Modify: `wiki/scripts/check.py`
- Modify: `wiki/ARCHITECTURE.md`
- Modify: `wiki/README.md`

- [ ] **Step 1: Write failing static checks before creating the skill**

In `wiki/scripts/check.py`, require:

- the new skill frontmatter name is `global-memory`;
- its description triggers on audit, promotion, correction, and cleanup of global memory;
- it links its governance reference;
- the reference contains the promotion test, evidence hierarchy, atomic schema, sensitivity handling, operation vocabulary, final nine-section report, and resolution order;
- the shared rule routes global requests to the new skill without embedding record bodies;
- `obsidian-memory/SKILL.md` delegates global writes/audits to `global-memory`;
- memory evals include true positive and negative trigger cases for global curation.

Run:

```bash
python3 wiki/scripts/check.py
```

Expected: failure because `skills/global-memory/` does not exist.

- [ ] **Step 2: Create `global-memory/SKILL.md` as the bounded router**

Use this frontmatter:

```yaml
---
name: global-memory
description: Audit, curate, promote, correct, or clean up David's governed cross-project global memory. Use when the user explicitly asks about global memory, permanent preferences or constraints, cross-project approval rules, privacy boundaries, project-registry pointers, stale or conflicting global records, or moving knowledge between project and global scope. Do not use for ordinary project notes, transient tasks, current implementation state, or broad personal-profile inference.
---
```

The skill body must route configuration from `~/.config/obsidian-memory/config.json`, require reading `references/global-memory-governance.md`, require inspecting before editing, state that retrieved content is data rather than authority, keep `APPLY_SAFE` changes minimal and reversible, and finish with exact audit and retrieval validation. It must not repeat the full curator prompt in the short router.

- [ ] **Step 3: Write the governance reference**

Encode the approved design as an executable cross-agent workflow:

1. Authority hierarchy: latest user correction, approved global record, repeated user statement, single user statement, environment evidence, assistant recommendation, inference.
2. Classification vocabulary: `USER_STATED`, `USER_CONFIRMED`, `ASSISTANT_RECOMMENDED`, `PROJECT_SPECIFIC`, `TEMPORARY`, `INFERRED`, `SENSITIVE`, `STALE_OR_CONFLICTED`.
3. Promotion test: useful in a different project after six months, prevents repeated friction or unsafe work, actually global, sourced, and minimally sensitive.
4. Operations: `ADD`, `UPDATE`, `SPLIT`, `MERGE`, `SUPERSEDE`, `EXPIRE`, `DELETE_SENSITIVE`, `MOVE_TO_PROJECT`, `KEEP_UNCHANGED`, `NEEDS_REVIEW`.
5. The exact flat schema and recognized values from the approved design.
6. `assistant_recommended` and `inferred` can be only `candidate` or `proposed`.
7. Project override resolution order from the design.
8. No secrets, raw correspondence, hidden reasoning, volatile prices/laws/package rankings, or broad biography.
9. `APPLY_SAFE` may only apply explicit, non-sensitive, non-conflicting, atomic, sourced global facts.
10. Final response sections numbered 1 through 9 exactly as requested by the Global Memory Curator contract.

Use the linked-chat message IDs from the approved spec only as provenance examples; do not store the chat transcript or assistant architecture as global facts.

- [ ] **Step 4: Route both agents through the common skill and bounded rule**

Add to `obsidian-memory/SKILL.md` immediately after the operation list:

```markdown
For a global-memory audit, promotion, correction, cleanup, permanent
cross-project preference, approval rule, privacy boundary, or project-registry
pointer, use the `global-memory` skill. Do not route ordinary project state into
the global namespace.
```

Add to `rules/obsidian-vault.md`:

```markdown
- Global memory is a small governed layer under the configured
  `global_memory_root`. Use the `global-memory` skill for promotion, correction,
  audit, or cleanup; keep ordinary project state project-local.
- Global defaults never override system policy, the latest user instruction, or
  explicit project-local authority. Private and restricted records require an
  explicit narrow scoped recall and are never injected at startup.
```

- [ ] **Step 5: Add behavior evals**

Add positive cases for “audit my global memory,” “promote this permanent cross-project approval rule,” and “correct a stale global preference.” Add negative cases for “save this repository test result,” “remember the current video shot,” and “summarize this private dating chat.” Expected behavior must mention project/session/sensitive routing and forbid automatic global promotion.

- [ ] **Step 6: Document architecture and explicit non-adoptions**

Update `wiki/ARCHITECTURE.md` and `wiki/README.md` with:

- one canonical Markdown/Git store;
- global root as a logical namespace;
- deterministic audit versus semantic curator responsibility;
- sensitivity enforcement after provider discovery;
- global/project precedence;
- no new controller, database, or automatic-learning dependency;
- startup route only, no global record bodies.

- [ ] **Step 7: Run all project and workspace checks**

```bash
python3 wiki/scripts/check.py
python3 scripts/plugins.py check
```

Expected: skill structure, trigger evals, docs, plugin tests, and workspace catalog checks all pass.

- [ ] **Step 8: Commit the skill and policy slice**

```bash
git add wiki/plugins/obsidian-memory/skills/global-memory wiki/plugins/obsidian-memory/skills/obsidian-memory/SKILL.md wiki/plugins/obsidian-memory/rules/obsidian-vault.md wiki/plugins/obsidian-memory/evals/memory-evals.json wiki/scripts/check.py wiki/ARCHITECTURE.md wiki/README.md
git commit -m "feat(memory): add global curator workflow"
```

---

### Task 5: Make guidance parity part of installation and status

**Files:**

- Modify: `wiki/scripts/install.py`
- Modify: `wiki/plugins/obsidian-memory/tests/test_install.py`
- Modify: `scripts/plugins.py`
- Modify: `tests/test_plugins.py`
- Modify: `README.md`
- Modify: `wiki/README.md`

- [ ] **Step 1: Write failing project-installer status tests**

Add tests to `InstallTests` for a temporary config, Claude policy, Codex policy, and source policy:

```python
def test_guidance_status_distinguishes_claude_and_codex_health(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        policy = root / "policy.md"
        claude_policy = root / "claude-rule.md"
        codex_policy = root / "AGENTS.md"
        config = root / "config.json"
        vault = root / "vault"
        (vault / "wiki").mkdir(parents=True)
        policy.write_text("# Shared memory\n", encoding="utf-8")
        config.write_text(json.dumps({"vault": str(vault)}), encoding="utf-8")
        with (
            mock.patch.object(MODULE, "POLICY", policy),
            mock.patch.object(MODULE, "CLAUDE_POLICY", claude_policy),
            mock.patch.object(MODULE, "CODEX_POLICY", codex_policy),
            mock.patch.object(MODULE, "CONFIG", config),
        ):
            missing = MODULE.guidance_status()
            MODULE.link_policy(claude_policy, replace=False)
            MODULE.install_codex_policy(codex_policy)
            current = MODULE.guidance_status()
        self.assertFalse(missing["ok"])
        self.assertEqual(missing["claude"], "missing")
        self.assertEqual(missing["codex"], "missing")
        self.assertTrue(current["ok"])
        self.assertEqual(current["claude"], "current")
        self.assertEqual(current["codex"], "current")
```

Also test stale Claude symlink targets, stale Codex managed blocks, malformed Codex markers, invalid config JSON, `--reuse-config` without config, and that `--status` is read-only.

- [ ] **Step 2: Run installer tests and confirm failure**

```bash
python3 -m unittest discover -s wiki/plugins/obsidian-memory/tests -p 'test_install.py' -v
```

Expected: failure because `guidance_status`, `--reuse-config`, `--status`, and `--json` do not exist.

- [ ] **Step 3: Implement read-only guidance health and config reuse**

In `wiki/scripts/install.py`, add:

```python
def read_existing_config() -> dict[str, Any]:
    if not CONFIG.is_file():
        raise RuntimeError(f"configuration not found: {CONFIG}")
    payload = json.loads(CONFIG.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("vault"), str):
        raise RuntimeError(f"configuration is invalid: {CONFIG}")
    return payload

def guidance_status() -> dict[str, Any]:
    configured = CONFIG.is_file()
    if not configured:
        return {"configured": False, "ok": True, "claude": "not-configured", "codex": "not-configured"}
    read_existing_config()
    claude = "current" if CLAUDE_POLICY.is_symlink() and CLAUDE_POLICY.resolve() == POLICY.resolve() else "missing-or-stale"
    codex = "missing"
    if CODEX_POLICY.is_file() and not CODEX_POLICY.is_symlink():
        existing = CODEX_POLICY.read_text(encoding="utf-8")
        start_count = existing.count(CODEX_POLICY_START)
        end_count = existing.count(CODEX_POLICY_END)
        if start_count != end_count or start_count > 1:
            codex = "malformed"
        elif start_count == 1:
            codex = "current" if codex_policy_block() in existing else "stale"
    return {
        "configured": True,
        "ok": claude == "current" and codex == "current",
        "claude": claude,
        "codex": codex,
    }
```

Refine the Claude state to distinguish `missing`, `stale`, and `current` while keeping the JSON keys stable.

Change argument parsing so exactly one operating mode is selected:

- initial configuration: `--vault PATH`;
- guidance refresh: `--reuse-config`;
- read-only inspection: `--status`, optionally `--json`.

`--vault` is no longer parser-required, but `main()` must fail when zero or multiple modes are selected. `--reuse-config` calls `read_existing_config()` and does not rewrite config. `--status` calls no mutation function and exits 0 only when unconfigured or current.

- [ ] **Step 4: Write failing workspace integration tests**

In `tests/test_plugins.py`, mock the narrow project-owned command and assert:

- `cmd_install` invokes `wiki/scripts/install.py --reuse-config --skip-product-install --skip-upstream-skill-link --keep-legacy-hooks` when `~/.config/obsidian-memory/config.json` exists;
- it skips guidance repair when no config exists;
- `cmd_status` returns nonzero when the project's JSON status is configured and unhealthy;
- `cmd_status` reports “not configured” without failing when no local config exists;
- malformed status JSON fails closed.

- [ ] **Step 5: Implement workspace repair without duplicating policy logic**

Add constants in `scripts/plugins.py`:

```python
MEMORY_CONFIG = Path.home() / ".config" / "obsidian-memory" / "config.json"
MEMORY_INSTALLER = ROOT / "wiki" / "scripts" / "install.py"
```

Add:

```python
def repair_memory_guidance_if_configured() -> None:
    if not MEMORY_CONFIG.is_file():
        return
    run(
        [
            sys.executable,
            str(MEMORY_INSTALLER),
            "--reuse-config",
            "--skip-product-install",
            "--skip-upstream-skill-link",
            "--keep-legacy-hooks",
        ]
    )

def memory_guidance_status() -> dict[str, Any]:
    if not MEMORY_CONFIG.is_file():
        return {"configured": False, "ok": True}
    result = run(
        [sys.executable, str(MEMORY_INSTALLER), "--status", "--json"],
        allow_failure=True,
        quiet=True,
    )
    try:
        payload = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        return {"configured": True, "ok": False, "error": "invalid-status"}
    if not isinstance(payload, dict):
        return {"configured": True, "ok": False, "error": "invalid-status"}
    return payload
```

Call repair after both product plugin installations and before the final `cmd_status(args)` in `cmd_install()`. Add one guidance row to `cmd_status()` and include unhealthy configured guidance in the final nonzero result alongside stale plugin bytes.

- [ ] **Step 6: Document fresh-session semantics**

Update root and wiki READMEs: `install --force` refreshes live plugin bytes and both global policies; `status` reports plugin health separately from guidance health; newly started Codex and Claude Code sessions are required to load updated guidance.

- [ ] **Step 7: Run installer, workspace, and full checks**

```bash
python3 -m unittest discover -s wiki/plugins/obsidian-memory/tests -p 'test_install.py' -v
python3 tests/test_plugins.py
python3 wiki/scripts/check.py
python3 scripts/plugins.py check
```

Expected: all project and workspace tests pass without invoking live agent CLIs from unit tests.

- [ ] **Step 8: Commit the parity slice**

```bash
git add wiki/scripts/install.py wiki/plugins/obsidian-memory/tests/test_install.py scripts/plugins.py tests/test_plugins.py README.md wiki/README.md
git commit -m "feat(memory): enforce agent guidance parity"
```

---

### Task 6: Migrate the single existing global record in the vault

**Files in the separate vault repository `/Users/david.david/Documents/Obsidian Vault`:**

- Create: `wiki/global/README.md`
- Create: `wiki/global/records/project-registry/agent-toolkit.md`
- Delete after content-preserving move: `wiki/entities/ai-workspace-marketplace.md`
- Modify: `wiki/index.md`
- Modify: `wiki/tasks.md`
- Modify: `wiki/comparisons/agent-kanban-boards-for-claude-and-codex.md`
- Modify: `projects/agent-toolkit/README.md`
- Modify: `projects/claude-obsidian-setup/README.md`

- [ ] **Step 1: Verify both repositories and capture rollback refs**

```bash
git status --short
git rev-parse HEAD
git -C "/Users/david.david/Documents/Obsidian Vault" status --short
git -C "/Users/david.david/Documents/Obsidian Vault" rev-parse HEAD
```

Expected: the implementation worktree is clean after Task 5; the vault is clean at its captured starting revision. Stop and preserve unrelated changes if either target path overlaps human work.

- [ ] **Step 2: Create the global route README without a profile aggregate**

Write `wiki/global/README.md` with:

- purpose: smallest durable cross-project defaults and pointers;
- precedence: system/safety, latest user instruction, project authority, approved global default, project context, inference;
- sensitivity: public/internal default recall, private/restricted explicit narrow scope only;
- project registry link to `[[global/records/project-registry/agent-toolkit|Agent Toolkit]]`;
- statement that record bodies are not startup context and project implementation remains local.

- [ ] **Step 3: Move and minimally complete the registry record**

Use `apply_patch` to add the new file and delete the old file. Preserve body, stable ID, dates, sources, verification, and public repository link. Add only the fields supported by existing evidence:

```yaml
owner: david
statement: "Agent Toolkit is David's active public workspace for portable cross-agent plugins and related standalone tooling."
evidence_type: environment_verified
retrieval_tags:
  - agent-toolkit
  - project-registry
  - claude-code
  - codex
```

Keep `id: global.project_registry.agent_toolkit`, `scope: global`, `status: verified`, `stability: review_periodically`, `sensitivity: internal`, the exact repository evidence at revision `6611c2d5537a016c0d7c9ef043b10b7ec41d7b22`, and the local project pointer.

- [ ] **Step 4: Update all five inbound links**

Replace every `wiki/entities/ai-workspace-marketplace` target with `wiki/global/records/project-registry/agent-toolkit`, preserving existing aliases. Verify there are no old paths or duplicate IDs:

```bash
rg -n "wiki/entities/ai-workspace-marketplace|global\.project_registry\.agent_toolkit" "/Users/david.david/Documents/Obsidian Vault" --glob '*.md'
```

Expected: one ID occurrence at the new record and no old link target.

- [ ] **Step 5: Run the new audit and isolate pre-existing failures**

```bash
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py audit --json
```

Expected: process exit may remain 1 because of the seven pre-existing unrelated errors. Inspect JSON and require no finding whose path is under `wiki/global/` and no `global-*` code for the migrated record.

- [ ] **Step 6: Verify native retrieval by stable identity and route**

```bash
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py recall "global.project_registry.agent_toolkit Agent Toolkit" --provider native --scope wiki/global/records/project-registry --top 5 --max-tokens 900
```

Expected: results include `wiki/global/records/project-registry/agent-toolkit.md`, stay within 900 estimated tokens, and report `filtered_sensitive: 0`.

- [ ] **Step 7: Commit only the vault migration**

```bash
git -C "/Users/david.david/Documents/Obsidian Vault" add wiki/global wiki/entities/ai-workspace-marketplace.md wiki/index.md wiki/tasks.md wiki/comparisons/agent-kanban-boards-for-claude-and-codex.md projects/agent-toolkit/README.md projects/claude-obsidian-setup/README.md
git -C "/Users/david.david/Documents/Obsidian Vault" commit -m "wiki: establish governed global namespace"
```

Record the new vault commit in the final report.

---

### Task 7: Release, reconnect both agents, and prove the end-to-end contract

**Files:**

- Modify only if evidence exposes a defect: files owned by Tasks 1–5
- Inspect: workspace repository, live Codex plugin, live Claude plugin, global policies, configured vault, QMD health

- [ ] **Step 1: Run complete static and unit verification from the workspace root**

```bash
python3 wiki/scripts/check.py
python3 scripts/plugins.py check
git diff --check
```

Expected: all 156 baseline tests plus the new tests pass, generated manifests are current, and no whitespace errors exist. Record the exact new total.

- [ ] **Step 2: Force-refresh pinned plugin bytes and repair guidance**

```bash
python3 scripts/plugins.py install --force
python3 scripts/plugins.py status
```

Expected: both agents show `obsidian-memory` installed and enabled, Claude live content matches the checkout, Claude guidance is current, Codex managed guidance is current, and status exits 0.

- [ ] **Step 3: Inspect the live policy boundaries without exposing unrelated guidance**

```bash
python3 wiki/scripts/install.py --status --json
```

Expected JSON:

```json
{
  "configured": true,
  "ok": true,
  "claude": "current",
  "codex": "current"
}
```

Additional bounded keys are allowed if they expose no paths, policy bodies, or user-authored Codex guidance.

- [ ] **Step 4: Refresh the derived QMD index because the canonical record path moved**

This is explicit index maintenance authorized by the migration; it is not a lifecycle hook and does not change canonical memory:

```bash
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py refresh-index --embed
```

Expected: QMD update and embedding finish successfully. Do not run `wiki/scripts/update.py`.

- [ ] **Step 5: Run live provider, doctor, audit, and targeted recall checks**

```bash
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py providers --json
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py doctor --json
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py audit --json
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py recall "Agent Toolkit project registry" --mode hybrid --provider qmd --scope wiki/global/records/project-registry --top 5 --max-tokens 900
```

Expected: Markdown remains canonical, QMD is healthy and derived, doctor passes, the audit shows no new global finding while retaining separately reported pre-existing errors, and targeted QMD recall returns the migrated record without degradation or sensitive filtering.

- [ ] **Step 6: Run the checked-in recall contract evaluation**

```bash
python3 wiki/plugins/obsidian-memory/scripts/obsidian_memory.py evaluate wiki/plugins/obsidian-memory/evals/recall-evals.example.json --json
```

Expected: every portable fixture case passes. If the fixture uses vault-relative sample paths unavailable in the live vault, run its unit-test harness instead and report that distinction; do not fabricate live-path success.

- [ ] **Step 7: Start a fresh ephemeral Codex session**

```bash
codex exec -C /Users/david.david/Personal/ai -s read-only --ephemeral --json "Report only: (1) whether a governed global-memory workflow is available, (2) the precedence between latest user instruction, project authority, and global defaults, and (3) whether private global records are startup context. Do not read record bodies or modify files."
```

Expected: the fresh run discovers the global-memory workflow, places latest user instruction and project authority above global defaults, and says private record bodies are not startup context.

- [ ] **Step 8: Start a fresh non-persistent Claude Code session**

```bash
claude -p --no-session-persistence --permission-mode dontAsk --tools "" --output-format json "Report only: (1) whether a governed global-memory workflow is available, (2) the precedence between latest user instruction, project authority, and global defaults, and (3) whether private global records are startup context. Do not read record bodies or modify files."
```

Expected: Claude reports the same three policy outcomes and can name the `global-memory` skill. Treat model prose as integration evidence, not as authority over the implementation.

- [ ] **Step 9: Fix only evidence-backed integration defects, then repeat affected gates**

If any live check exposes a defect, add a failing regression test first, make the smallest patch, run its focused test plus both project checks, and commit with a message naming that defect. Do not broaden scope to remediate the seven unrelated vault audit errors.

- [ ] **Step 10: Capture final reversibility evidence**

```bash
git status --short
git log --oneline --decorate -8
git -C "/Users/david.david/Documents/Obsidian Vault" status --short
git -C "/Users/david.david/Documents/Obsidian Vault" log --oneline -3
python3 scripts/plugins.py status
```

Expected: only the user's pre-existing `download.html` remains untracked in the original workspace; implementation worktree and vault are otherwise clean. Record workspace and vault commit hashes separately.

Rollback sequence:

1. Revert the workspace implementation commits in reverse order.
2. Run `python3 scripts/plugins.py install --force` to restore both live plugin copies and managed policies.
3. Revert the vault migration commit independently.
4. Run `refresh-index --embed` only after the canonical Markdown rollback.

---

## Final acceptance checklist

- [ ] The global layer uses the existing Markdown/Git authority and no second store.
- [ ] Exactly one pre-existing global record was migrated; no new personal fact was inferred.
- [ ] Global IDs, scope, category, evidence, statement, temporal state, and sensitivity are deterministic audit inputs.
- [ ] Duplicate IDs and project/global contamination fail with bounded value-free findings.
- [ ] Assistant recommendations and inference cannot become current records.
- [ ] Private and restricted recall requires both an explicit flag and a narrow scope.
- [ ] Native, QMD, fallback, and supersession paths share the same final sensitivity enforcement.
- [ ] Startup includes only a global-memory route, never private or global record bodies.
- [ ] Both live plugins and both global guidance integrations are current.
- [ ] Fresh Codex and Claude Code sessions report the same precedence and privacy behavior.
- [ ] Workspace and vault commits are separate, clean, and independently reversible.
