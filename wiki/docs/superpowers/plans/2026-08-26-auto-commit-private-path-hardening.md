# Auto-Commit Private-Path Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fail closed before staging when any configured memory commit path is
dot-private directly or after symlink resolution.

**Architecture:** Share a case-insensitive dot-segment predicate between recall
and commit validation. Keep recall's top-level inbox exclusion separate, and
validate both raw configured parts and vault-relative resolved parts before the
existing Git lock/stage/commit flow.

**Tech Stack:** Python 3 standard library, `unittest`, temporary Git
repositories, and the workspace plugin validation scripts.

**Spec:** `wiki/docs/superpowers/specs/2026-08-26-auto-commit-private-path-hardening-design.md`

## Global Constraints

- Reject every dot-prefixed segment case-insensitively, including `.raw`, `.obsidian`, `.git`, nested forms, and symlink-resolved targets.
- Keep top-level `inbox` commit-eligible; only recall excludes it.
- Reject the complete commit request before staging any path when one configured path is unsafe.
- `commit` without `--path` retains configured-path behavior; repeated `--path` commits only exact validated `.md` files.
- Reject duplicate and non-Markdown `--path` values before staging.
- Preserve current absolute-path, `..`, vault-escape, lock, and Git behavior.
- Never read or print private file contents.
- Do not edit generated manifests or `plugins.json`.
- Do not run install, `install --force`, or `wiki/scripts/update.py`.

---

### Task 1: Reject private configured commit targets before Git staging

**Files:**

- Modify: `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py`
- Modify: `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py`
- Modify: `wiki/ARCHITECTURE.md`

**Interfaces:**

- Consumes: `safe_recall_parts(parts: tuple[str, ...]) -> bool` and
  `safe_commit_paths(config: dict[str, Any], config_file: Path) -> tuple[bool, str]`.
- Produces: `has_private_vault_segment(parts: tuple[str, ...]) -> bool`, reused
  by recall and commit validation without changing their public CLI contracts.

- [ ] **Step 1: Write failing real-Git commit-safety tests**

Add `test_auto_commit_rejects_private_configured_paths_before_staging`. For
each literal below, create a fresh temporary vault Git repository with a dirty
allowed Markdown file and a dirty private target, configure both the allowed
path and the hostile path, call `safe_commit_paths`, and assert it returns
`False`, reports the configured value, creates no new commit, and leaves the
Git index empty:

```python
hostile_paths = [
    ".raw",
    ".obsidian",
    ".git",
    "projects/factorio-bot/.raw",
    "projects/factorio-bot/.ObSiDiAn",
]
```

Add `test_auto_commit_rejects_symlink_to_private_path`. Create
`wiki/private-link` as a symlink to `.raw`, configure that public-looking path,
and assert the same fail-before-stage behavior.

Add `test_auto_commit_accepts_exact_public_markdown_paths`. Configure only
`projects/factorio-bot/README.md` and `wiki/log.md`, dirty those files plus an
unconfigured `.obsidian/workspace.json`, and assert one commit contains exactly
the two configured Markdown paths while `.obsidian` remains dirty and
unstaged.

- [ ] **Step 2: Run RED and verify the safety gap**

Run:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py
```

Expected: the private-path cases fail because current code permits the paths;
the failure must not be a fixture or import error.

- [ ] **Step 3: Implement the minimal shared private-segment boundary**

Add the predicate near `safe_recall_parts`:

```python
def has_private_vault_segment(parts: tuple[str, ...]) -> bool:
    return any(part.casefold().startswith(".") for part in parts)
```

Make `safe_recall_parts` call it before applying its existing top-level inbox
rule. In `safe_commit_paths`, reject an empty/dot path or any raw private
segment, then resolve the candidate, retain the existing vault-escape check,
derive the resolved vault-relative parts, and reject any resolved private
segment. Perform all validation before creating the lock directory or running
Git status/add commands.

- [ ] **Step 4: Run focused GREEN**

Run the exact focused command that produced RED. Expected: every new and
existing unit test passes with no warning output.

- [ ] **Step 5: Document the enforced trust boundary**

Update `wiki/ARCHITECTURE.md` to say configured commit paths are checked before
and after resolution; direct, nested, case-variant, and symlink-routed
dot-private targets fail before staging. Preserve the documented distinction
that `inbox` is commit-eligible but not recallable.

- [ ] **Step 6: Run the complete repository gate**

Run:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py
python3 wiki/scripts/check.py
python3 scripts/plugins.py check
python3 scripts/plugins.py sync --check
git diff --check
```

Expected: all commands exit zero, generated manifests still match
`plugins.json`, and no install/update operation occurs.

- [ ] **Step 7: Self-review and commit**

Confirm the diff is limited to the spec, plan, implementation, tests, and
architecture paragraph. Then run:

```sh
git add wiki/docs/superpowers/specs/2026-08-26-auto-commit-private-path-hardening-design.md \
  wiki/docs/superpowers/plans/2026-08-26-auto-commit-private-path-hardening.md \
  wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  wiki/ARCHITECTURE.md
git diff --cached --check
git commit -m "fix(wiki): reject private auto-commit paths"
```

Expected: one independently reviewable commit and a clean worktree.

---

### Task 2: Add exact-path explicit commits without changing Stop

**Files:**

- Modify: `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py`
- Modify: `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py`
- Modify: `wiki/README.md`

**Interfaces:**

- Consumes: Task 1's private-path validation in `safe_commit_paths`.
- Produces: `explicit_commit(paths: list[str] | None = None) -> int` and
  repeatable CLI `commit --path VAULT_RELATIVE_MARKDOWN`.

- [ ] **Step 1: Write failing CLI isolation tests**

Add `test_explicit_commit_paths_commit_only_exact_markdown_files`. In one real
temporary Git vault, dirty three public Markdown files and one `.obsidian`
file, then invoke the script with two repeated `--path` arguments. Assert the
new commit contains exactly those two Markdown paths; the third public note and
private file remain dirty and unstaged.

Add `test_explicit_commit_paths_reject_invalid_overrides_before_staging` with
subtests for a duplicate normalized path, `wiki/state.json`, `.raw/source.md`,
and a public-looking symlink to `.raw/source.md`. Assert non-zero exit, no new
commit, and an empty index for every case.

- [ ] **Step 2: Run RED and verify the parser gap**

Run:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py
```

Expected: the new CLI tests fail because `commit` does not accept `--path`.

- [ ] **Step 3: Implement the minimal exact-path override**

Give `safe_commit_paths` an optional raw-path override used only when non-`None`.
Give `explicit_commit` the corresponding optional list. Add a repeatable
`--path` argument to the `commit` subparser and pass it from `main`.

When overrides are present, normalize each with `Path(value).as_posix()`, reject
duplicates, require the raw value and resolved vault-relative target to end in
`.md`, and then pass the exact list through Task 1's private/escape validation.
With no override, use configured paths unchanged. Do not pass CLI paths to
`stop_hook`.

- [ ] **Step 4: Run GREEN and regression tests**

Run:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py
```

Expected: the exact-path cases and every existing test pass.

- [ ] **Step 5: Document the exact commit transport**

Add one `wiki/README.md` example using two repeatable `--path` arguments and
state that Stop remains configured-path driven. Do not include a local vault
path in repository documentation.

- [ ] **Step 6: Run the full workspace gate and commit**

Run:

```sh
python3 wiki/scripts/check.py
python3 scripts/plugins.py check
python3 scripts/plugins.py sync --check
git diff --check
```

Then commit only Task 2 files:

```sh
git add wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py wiki/README.md
git diff --cached --check
git commit -m "feat(wiki): commit exact memory paths"
```

Expected: checks exit zero and the task commit changes no hook declaration,
generated manifest, local config, or vault file.
