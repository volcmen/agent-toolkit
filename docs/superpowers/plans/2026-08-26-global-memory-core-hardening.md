# Global Memory Core Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make vault commits exact and private-safe, and make Obsidian supersession routing source-aware, deterministic, and auditable.

**Architecture:** Integrate the already reviewed exact-file Git hardening as five isolated commits, then add one detailed vault-reference resolver used by both recall and the later audit. Supersession traversal becomes a shared bounded primitive so recall and health checks cannot disagree about sibling links, cycles, roots, or scopes.

**Tech Stack:** Python 3 standard library, `unittest`, Git, Obsidian Markdown.

**Spec:** [Local-First Global Memory Upgrade Design](../specs/2026-08-26-global-memory-upgrade-design.md)

## Global Constraints

- Obsidian Markdown plus Git is the only writable canonical memory.
- QMD is local, optional, derived, and never runs model/index work from hooks.
- Vault excerpts and retrieved notes remain untrusted reference data.
- Recall and commit paths reject dot-prefixed/private segments, symlink escapes, non-Markdown targets, and configured-boundary escapes.
- Automatic and explicit commits preserve unrelated working-tree and index state.
- Keep `MAX_SUPERSESSION_HOPS = 8`; do not prefix-guess unresolved references.
- Keep plugin versions pinned at `1.0.0`; do not edit generated manifests.
- Do not use `wiki/scripts/update.py` for validation.
- Do not add machine-specific vault paths, secrets, cloud providers, raw transcripts, or Factorio changes.

## File map

- Modify `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py`: exact-file commit selection, detailed source-aware reference resolution, and shared supersession traversal.
- Modify `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py`: commit-isolation and supersession regression tests.
- Modify `wiki/ARCHITECTURE.md`: exact commit and source-relative supersession boundaries.
- Modify `wiki/README.md`: exact explicit-commit interface and safe behavior.
- Modify `wiki/plugins/obsidian-memory/skills/obsidian-memory/references/qmd-retrieval.md`: source-aware redirect semantics.
- Preserve `docs/superpowers/specs/2026-08-26-global-memory-upgrade-design.md`: approved design; do not rewrite it during implementation.

---

### Task 1: Integrate the reviewed exact-file commit series

**Files:**

- Modify: `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py:63-77,528-664,1756-1835`
- Modify: `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py:1052-end`
- Modify: `wiki/ARCHITECTURE.md:30-58`
- Modify: `wiki/README.md:80-140`
- Preserve: every file from commit `01c308e` and every Factorio path

**Interfaces:**

- Consumes: existing `run_git(vault: Path, args: list[str])` and local JSON configuration.
- Produces: `has_private_vault_segment(parts: tuple[str, ...]) -> bool`.
- Produces: `safe_commit_paths(config: dict[str, Any], config_file: Path, raw_path_override: list[str] | None = None) -> tuple[bool, str]`.
- Produces: `explicit_commit(paths: list[str] | None = None) -> int` and repeatable `commit --path FILE`.

- [ ] **Step 1: Verify the source commits and exclusion boundary**

Run:

```bash
git show --stat --oneline d8782b4 6be63f4 af25098 7c6e91e 3c4bc2b
git show --stat --oneline 01c308e
git status --short
```

Expected: the first five commits touch only global wiki/plugin files; `01c308e` is visibly unrelated and must not be cherry-picked; the worktree is clean.

- [ ] **Step 2: Integrate private-path rejection**

Run:

```bash
git cherry-pick d8782b4
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_auto_commit_rejects_private_configured_paths_before_staging \
  ObsidianMemoryTests.test_auto_commit_rejects_symlink_to_private_path -v
```

Expected: cherry-pick succeeds and both tests pass.

- [ ] **Step 3: Integrate repeatable exact explicit paths**

Run:

```bash
git cherry-pick 6be63f4
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_explicit_commit_paths_commit_only_exact_markdown_files \
  ObsidianMemoryTests.test_explicit_commit_paths_reject_invalid_overrides_before_staging -v
```

Expected: both tests pass; `commit --path wiki/a.md --path projects/b.md` commits only those files.

- [ ] **Step 4: Integrate literal Git pathspec handling**

Run:

```bash
git cherry-pick af25098
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_explicit_commit_paths_reject_git_pathspec_magic_before_staging -v
```

Expected: pass; `run_git` invokes `git --literal-pathspecs` and Git magic cannot broaden a target.

- [ ] **Step 5: Integrate exact safe configured-file enumeration**

Run:

```bash
git cherry-pick 7c6e91e
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_configured_directory_cannot_commit_nested_private_markdown \
  ObsidianMemoryTests.test_configured_directories_commit_markdown_changes_deletions_and_inbox -v
```

Expected: pass; configured directories select changed Markdown files without following private or symlinked content.

- [ ] **Step 6: Integrate deleted-directory fail-closed behavior**

Run:

```bash
git cherry-pick 3c4bc2b
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_explicit_commit_absent_paths_require_exact_tracked_markdown_file \
  ObsidianMemoryTests.test_explicit_commit_rejects_markdown_directory_before_staging -v
```

Expected: pass; a deleted directory or prefix is never accepted as an exact file.

- [ ] **Step 7: Verify the imported deliverable**

Run:

```bash
python3 wiki/scripts/check.py
git diff --check
git log --oneline -7
```

Expected: all wiki tests pass, the diff check is clean, the five global hardening commits follow the approved design commit, and `01c308e` is absent.

### Task 2: Add detailed source-aware reference resolution

**Files:**

- Modify: `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py:6-16,855-929`
- Test: `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py:622-826`

**Interfaces:**

- Consumes: `safe_recall_parts`, `path_within_roots`, configured recall roots, and the source note path.
- Produces: immutable `VaultReferenceResult(path: Path | None, vault_relative: str | None, issue: str | None)`.
- Produces: `resolve_vault_reference_detailed(config, reference, *, source_path=None, allowed_roots=None) -> VaultReferenceResult`.
- Preserves: `resolve_vault_reference(config, reference, *, source_path=None, allowed_roots=None) -> tuple[Path, str] | None` as a compatibility wrapper.

- [ ] **Step 1: Write failing sibling, alias, and ambiguity tests**

Add:

```python
def test_vault_reference_resolves_sibling_alias_and_heading(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        vault = self.make_vault(root)
        decisions = vault / "projects" / "alpha" / "decisions"
        decisions.mkdir()
        source = decisions / "0001-old.md"
        target = decisions / "0002-current.md"
        source.write_text("---\nstatus: superseded\n---\n", encoding="utf-8")
        target.write_text("---\nstatus: accepted\n---\n", encoding="utf-8")
        config_path = self.write_config(root, vault)
        with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
            config, _ = MODULE.load_config()
        result = MODULE.resolve_vault_reference_detailed(
            config,
            "[[0002-current#Decision|current choice]]",
            source_path=source,
            allowed_roots=["projects"],
        )
        self.assertEqual(result.path, target.resolve())
        self.assertEqual(
            result.vault_relative,
            "projects/alpha/decisions/0002-current.md",
        )
        self.assertIsNone(result.issue)


def test_vault_reference_rejects_ambiguous_bare_filename(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        vault = self.make_vault(root)
        source = vault / "projects" / "alpha" / "old.md"
        source.write_text("old", encoding="utf-8")
        for project in ("beta", "gamma"):
            directory = vault / "projects" / project
            directory.mkdir()
            (directory / "current.md").write_text("current", encoding="utf-8")
        config_path = self.write_config(root, vault)
        with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
            config, _ = MODULE.load_config()
        result = MODULE.resolve_vault_reference_detailed(
            config,
            "[[current]]",
            source_path=source,
            allowed_roots=["projects"],
        )
        self.assertIsNone(result.path)
        self.assertEqual(result.issue, "ambiguous")


def test_missing_explicit_root_path_never_falls_back_by_filename(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        vault = self.make_vault(root)
        source = vault / "projects" / "alpha" / "old.md"
        source.write_text("old", encoding="utf-8")
        (vault / "wiki" / "current.md").write_text("current", encoding="utf-8")
        config_path = self.write_config(root, vault)
        with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
            config, _ = MODULE.load_config()
        result = MODULE.resolve_vault_reference_detailed(
            config,
            "projects/missing/current",
            source_path=source,
            allowed_roots=["wiki", "projects"],
        )
        self.assertIsNone(result.path)
        self.assertEqual(result.issue, "missing")
```

- [ ] **Step 2: Run the focused tests and verify the API is absent**

Run:

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_vault_reference_resolves_sibling_alias_and_heading \
  ObsidianMemoryTests.test_vault_reference_rejects_ambiguous_bare_filename \
  ObsidianMemoryTests.test_missing_explicit_root_path_never_falls_back_by_filename -v
```

Expected: FAIL with `AttributeError` for `resolve_vault_reference_detailed`.

- [ ] **Step 3: Implement the detailed result and compatibility wrapper**

Add:

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class VaultReferenceResult:
    path: Path | None
    vault_relative: str | None
    issue: str | None


def clean_wikilink_target(reference: str) -> PurePosixPath | None:
    cleaned = reference.strip().strip("'\"")
    if cleaned.startswith("[[") and cleaned.endswith("]]"):
        cleaned = cleaned[2:-2]
    cleaned = cleaned.split("|", 1)[0].split("#", 1)[0].strip()
    relative = PurePosixPath(cleaned)
    if not cleaned or relative.is_absolute() or ".." in relative.parts:
        return None
    return relative


def resolve_vault_reference(
    config: dict[str, Any],
    reference: str,
    *,
    source_path: Path | None = None,
    allowed_roots: list[str] | None = None,
) -> tuple[Path, str] | None:
    result = resolve_vault_reference_detailed(
        config,
        reference,
        source_path=source_path,
        allowed_roots=allowed_roots,
    )
    if result.path is None or result.vault_relative is None:
        return None
    return result.path, result.vault_relative
```

Implement `resolve_vault_reference_detailed` with these exact branches:

1. Return issue `unsafe` when `clean_wikilink_target` fails or any lexical segment is private.
2. Restrict all candidates to `allowed_roots or config["recall_roots"]`.
3. With no `source_path`, resolve the exact target from the vault root; this preserves provider-result behavior.
4. If the target is already under an allowed root, resolve only that exact vault-root target and return `missing` when absent.
5. Otherwise resolve the exact target from `source_path.parent`.
6. Only after an absent source-relative candidate, and only for one path segment, use `os.walk(..., followlinks=False)` over allowed roots and accept exactly one case-folded filename match.
7. Return `ambiguous` for multiple safe matches and `missing` for none.
8. Add `.md` only to an extensionless target. Require a real file, Markdown suffix, safe resolved segments, vault containment, allowed-root containment, and no symlink escape. Return `non-markdown` for a declared other suffix, `out-of-root` for a safe candidate outside the allowed roots, and `unsafe` for private segments or a vault/symlink escape.

Do not add fuzzy or numeric-prefix matching.

- [ ] **Step 4: Run new and existing resolver tests**

Run:

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_vault_reference_resolves_sibling_alias_and_heading \
  ObsidianMemoryTests.test_vault_reference_rejects_ambiguous_bare_filename \
  ObsidianMemoryTests.test_missing_explicit_root_path_never_falls_back_by_filename \
  ObsidianMemoryTests.test_provider_resolution_rejects_nested_private_paths \
  ObsidianMemoryTests.test_recall_never_resolves_repository_or_non_markdown_files -v
```

Expected: all pass.

- [ ] **Step 5: Commit the source-aware resolver**

```bash
git add wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py
git commit -m "fix(wiki): resolve Obsidian references from source notes"
```

### Task 3: Share bounded supersession traversal

**Files:**

- Modify: `wiki/plugins/obsidian-memory/scripts/obsidian_memory.py:978-1153`
- Test: `wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py:523-826,942-977`

**Interfaces:**

- Consumes: `VaultReferenceResult`, `resolve_vault_reference_detailed`, `memory_state`, `path_in_scope`, and `MAX_SUPERSESSION_HOPS`.
- Produces: immutable `SupersessionResult(path, vault_relative, metadata, state, issue)`.
- Produces: `follow_supersession_chain(config, *, source_path, source_relative, metadata, allowed_roots, scope=None) -> SupersessionResult`.
- Preserves: compact recall JSON and `supersession_redirect(...) -> dict[str, Any] | None`.

- [ ] **Step 1: Write the failing real-shape sibling-chain test**

```python
def test_supersession_follows_source_relative_chain_to_current_decision(self) -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        vault = self.make_vault(root)
        decisions = vault / "projects" / "alpha" / "decisions"
        decisions.mkdir()
        rows = (
            ("0017-old.md", "superseded", "[[0018-middle]]"),
            ("0018-middle.md", "superseded", "[[0019-current]]"),
            ("0019-current.md", "accepted", ""),
        )
        for name, status, successor in rows:
            (decisions / name).write_text(
                f'---\nstatus: {status}\nsuperseded_by: "{successor}"\n---\n# {name}\n',
                encoding="utf-8",
            )
        config_path = self.write_config(root, vault)
        with mock.patch.dict(os.environ, {"OBSIDIAN_MEMORY_CONFIG": str(config_path)}):
            config, _ = MODULE.load_config()
        result = MODULE.follow_supersession_chain(
            config,
            source_path=decisions / "0017-old.md",
            source_relative="projects/alpha/decisions/0017-old.md",
            metadata=MODULE.parse_frontmatter(decisions / "0017-old.md"),
            allowed_roots=["projects"],
            scope="projects/alpha",
        )
        self.assertEqual(
            result.vault_relative,
            "projects/alpha/decisions/0019-current.md",
        )
        self.assertEqual(result.state, "current")
        self.assertIsNone(result.issue)
```

Extend existing cycle, root, active-collection, scope, and hop-limit cases to assert issue codes `cycle`, `out-of-root`, `out-of-scope`, and `hop-limit` through the shared function.

- [ ] **Step 2: Run the chain tests and verify the API is absent**

Run:

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_supersession_follows_source_relative_chain_to_current_decision \
  ObsidianMemoryTests.test_supersession_chain_skips_successors_that_are_themselves_stale \
  ObsidianMemoryTests.test_supersession_redirect_stays_within_recall_roots \
  ObsidianMemoryTests.test_supersession_redirect_respects_the_requested_scope -v
```

Expected: the new test fails because `follow_supersession_chain` is absent; existing tests remain green.

- [ ] **Step 3: Implement the shared traversal**

Add:

```python
@dataclass(frozen=True)
class SupersessionResult:
    path: Path | None
    vault_relative: str | None
    metadata: dict[str, str]
    state: str
    issue: str | None


def follow_supersession_chain(
    config: dict[str, Any],
    *,
    source_path: Path,
    source_relative: str,
    metadata: dict[str, str],
    allowed_roots: list[str],
    scope: str | None = None,
) -> SupersessionResult:
    seen = {source_relative}
    current_path = source_path
    current_metadata = metadata
    for _hop in range(MAX_SUPERSESSION_HOPS):
        reference = current_metadata.get("superseded_by", "")
        if not reference:
            return SupersessionResult(None, None, {}, "", "missing-reference")
        resolved = resolve_vault_reference_detailed(
            config,
            reference,
            source_path=current_path,
            allowed_roots=allowed_roots,
        )
        if resolved.issue or resolved.path is None or resolved.vault_relative is None:
            return SupersessionResult(
                None,
                None,
                {},
                "",
                resolved.issue or "missing",
            )
        if not path_in_scope(resolved.vault_relative, scope):
            return SupersessionResult(None, None, {}, "", "out-of-scope")
        if resolved.vault_relative in seen:
            return SupersessionResult(None, None, {}, "", "cycle")
        seen.add(resolved.vault_relative)
        current_path = resolved.path
        current_metadata = parse_frontmatter(current_path)
        state = memory_state(current_metadata)
        if state not in HIDDEN_STATES:
            return SupersessionResult(
                current_path,
                resolved.vault_relative,
                current_metadata,
                state,
                None,
            )
    return SupersessionResult(None, None, {}, "", "hop-limit")
```

Refactor `supersession_redirect` to call this function with `source_path=config["vault"] / stale_path`, `source_relative=stale_path`, the active provider roots, and the requested recall scope. Construct the existing redirect hit only when `issue is None`. Do not alter hit keys, stale counts, or token budgeting.

- [ ] **Step 4: Run all supersession and recall tests**

Run:

```bash
python3 wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py \
  ObsidianMemoryTests.test_supersession_follows_source_relative_chain_to_current_decision \
  ObsidianMemoryTests.test_qmd_recall_filters_stale_results_unless_requested \
  ObsidianMemoryTests.test_supersession_chain_skips_successors_that_are_themselves_stale \
  ObsidianMemoryTests.test_supersession_redirect_stays_within_recall_roots \
  ObsidianMemoryTests.test_qmd_supersession_redirect_honors_active_collections_only \
  ObsidianMemoryTests.test_supersession_redirect_respects_the_requested_scope -v
```

Expected: all pass and compact recall output remains compatible.

- [ ] **Step 5: Commit shared supersession traversal**

```bash
git add wiki/plugins/obsidian-memory/scripts/obsidian_memory.py \
  wiki/plugins/obsidian-memory/tests/test_obsidian_memory.py
git commit -m "fix(wiki): follow source-aware supersession chains"
```

### Task 4: Document and verify the core contract

**Files:**

- Modify: `wiki/scripts/check.py:182-241`
- Modify: `wiki/ARCHITECTURE.md:20-70`
- Modify: `wiki/README.md:80-145`
- Modify: `wiki/plugins/obsidian-memory/skills/obsidian-memory/references/qmd-retrieval.md:30-55`

**Interfaces:**

- Consumes: exact-file commit and source-aware supersession behavior from Tasks 1-3.
- Produces: checked operator documentation matching the executable contract.

- [ ] **Step 1: Add failing documentation assertions**

In `validate_memory_policy` add:

```python
architecture = (ROOT / "ARCHITECTURE.md").read_text(encoding="utf-8")
for term in ("exact Markdown files", "source note's directory", "ambiguous"):
    require(
        term in architecture,
        f"architecture omits memory hardening contract: {term}",
    )
```

- [ ] **Step 2: Verify the documentation gate fails**

Run:

```bash
python3 wiki/scripts/check.py --skip-tests
```

Expected: FAIL naming the first missing memory-hardening phrase.

- [ ] **Step 3: Add the operator contract**

Add these statements to the architecture and user documentation:

```markdown
- Automatic commits enumerate exact Markdown files under configured roots and
  commit only those literal paths. Unrelated staged changes, dot-prefixed paths,
  symlink escapes, non-Markdown files, and directory-shaped explicit targets
  are excluded or rejected before commit creation.
- `commit --path <vault-relative.md>` is repeatable and exact; omitting `--path`
  uses the configured safe roots.
- Supersession links resolve from the source note's directory unless they are
  explicitly rooted under an active recall root. A bare filename may fall back
  only to one unique safe match. Missing, ambiguous, cyclic, private,
  out-of-root, and out-of-scope routes fail closed.
```

In `qmd-retrieval.md`, state that source-aware routing is provider-independent and numeric prefixes are never guessed.

- [ ] **Step 4: Run complete core verification**

Run:

```bash
python3 wiki/scripts/check.py
python3 scripts/plugins.py check
git diff --check
git status --short
```

Expected: both check suites pass; only the four documentation/checker files are modified after the previous commit.

- [ ] **Step 5: Commit the checked contract**

```bash
git add wiki/ARCHITECTURE.md wiki/README.md wiki/scripts/check.py \
  wiki/plugins/obsidian-memory/skills/obsidian-memory/references/qmd-retrieval.md
git commit -m "docs(wiki): define exact commit and supersession safety"
```
