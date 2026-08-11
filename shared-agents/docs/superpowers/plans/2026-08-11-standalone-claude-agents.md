# Standalone Claude Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `shared-agents` plugin with four source-controlled, copy-installed Claude Code user agents, including an exact `Explore` override and a bare `controller` launcher.

**Architecture:** Keep `agents.json` and `prompts/*.md` canonical. Render Claude Markdown into `shared-agents/claude/agents/` and dormant Codex TOML into `shared-agents/codex/agents/`; make `manage.py` validate both source adapters but install only regular-file copies of the Claude agents into `~/.claude/agents/`. Remove the plugin, duplicated Claude policies, and plugin-scoped identifiers.

**Tech Stack:** Python 3.11+ standard library, JSON, TOML via `tomllib`, Claude Code 2.1.227, Fish shell, `unittest`, Git.

## Global Constraints

- The live Claude agent names are exactly `controller`, `task-analyst`, `Explore`, and `alan-wake`.
- `claude/agents/Explore.md` must contain exact frontmatter `name: Explore`, `model: sonnet`, and `effort: medium` so it overrides the built-in Explore without inheriting Fable.
- `controller` remains Fable with high effort; all three workers remain Sonnet.
- Installed Claude agents are regular-file copies, never symlinks or plugin-cache files.
- Installation must be atomic, idempotent, and backup a conflicting target before replacement.
- `shared-agents@ai-workspace` must not remain in `plugins.json`, generated marketplace manifests, the source plugin tree, or Claude's installed plugin list.
- Do not install or mutate active Codex shared-agent configuration; retain the dormant Codex source adapters and validation.
- Preserve the user's existing controller high-effort change and current Alan Wake link/Slack formatting changes.
- Do not change other plugins, unrelated Fish configuration, or unrelated working-tree edits.
- Use only the current official Claude Code subagent contract at <https://code.claude.com/docs/en/sub-agents>.

---

## File Map

- `shared-agents/agents.json`: canonical identities, descriptions, models, effort, and tool boundaries.
- `shared-agents/prompts/controller.md`: standalone controller and bare-name routing contract.
- `shared-agents/prompts/repo-explorer.md`: source prompt for the exact `Explore` override and its thoroughness levels.
- `shared-agents/prompts/alan-wake.md`: preserve the user's current writing updates unchanged.
- `shared-agents/scripts/render.py`: render Claude agents into `claude/agents/` and Codex adapters into `codex/agents/`.
- `shared-agents/claude/agents/*.md`: generated, source-controlled Claude user-agent definitions.
- `shared-agents/scripts/manage.py`: validate sources and copy/install/status/uninstall only the Claude definitions.
- `shared-agents/tests/test_shared_agents.py`: rendering, routing, copy lifecycle, package, and migration regression tests.
- `shared-agents/evals/controller-routing.json`: routing eval cases moved out of the deleted plugin.
- `plugins.json`: workspace plugin catalog without `shared-agents`.
- `.claude-plugin/marketplace.json`: generated Claude marketplace without `shared-agents`.
- `.agents/plugins/marketplace.json`: generated Codex marketplace without `shared-agents`.
- `shared-agents/README.md`, `shared-agents/ARCHITECTURE.md`, `shared-agents/docs/sources.md`, `README.md`: standalone architecture and commands.
- `~/.claude/agents/*.md`: live copied definitions.
- `~/.config/fish/config.fish`: user-owned `clauded` alias selecting bare `controller` at high effort.

---

### Task 1: Render standalone agents and override built-in Explore

**Files:**

- Modify: `shared-agents/tests/test_shared_agents.py`
- Modify: `shared-agents/agents.json`
- Modify: `shared-agents/prompts/controller.md`
- Modify: `shared-agents/prompts/repo-explorer.md`
- Modify: `shared-agents/scripts/render.py`
- Create: `shared-agents/claude/agents/controller.md`
- Create: `shared-agents/claude/agents/task-analyst.md`
- Create: `shared-agents/claude/agents/Explore.md`
- Create: `shared-agents/claude/agents/alan-wake.md`
- Modify: `shared-agents/codex/agents/alan_wake.toml`
- Modify: `shared-agents/codex/agents/repo_explorer.toml`
- Modify: `shared-agents/codex/agents/task_analyst.toml`

**Interfaces:**

- Consumes: `render.load_catalog() -> list[dict[str, Any]]`, optional `claude.name`, and prompt files named by each catalog entry.
- Produces: `render.CLAUDE_AGENTS == ROOT / "claude" / "agents"` and four generated Markdown files, including exact `Explore.md`.

- [ ] **Step 1: Write failing rendering and routing tests**

Replace plugin-path assertions with standalone-path assertions and add the exact Explore contract:

```python
def test_claude_agents_render_to_standalone_source_directory(self) -> None:
    expected = {"controller.md", "task-analyst.md", "Explore.md", "alan-wake.md"}
    actual = {path.name for path in (ROOT / "claude" / "agents").glob("*.md")}
    self.assertEqual(actual, expected)

def test_explore_overrides_the_builtin_with_a_pinned_model(self) -> None:
    text = (ROOT / "claude" / "agents" / "Explore.md").read_text(encoding="utf-8")
    self.assertIn("\nname: Explore\n", text)
    self.assertIn("\nmodel: sonnet\n", text)
    self.assertIn("\neffort: medium\n", text)
    self.assertIn("tools: Read, Grep, Glob, LSP", text)
    self.assertIn("disallowedTools: Write, Edit, NotebookEdit", text)
    for thoroughness in ("quick", "medium", "very thorough"):
        self.assertIn(thoroughness, text.lower())

def test_controller_uses_bare_standalone_agent_names(self) -> None:
    text = (ROOT / "prompts" / "controller.md").read_text(encoding="utf-8")
    self.assertIn("`Explore` on Sonnet", text)
    self.assertIn("`task-analyst` on Sonnet", text)
    self.assertIn("`alan-wake` on Sonnet", text)
    self.assertNotIn("shared-agents:", text)
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
python3 shared-agents/tests/test_shared_agents.py -v \
  Rendering.test_claude_agents_render_to_standalone_source_directory \
  Rendering.test_explore_overrides_the_builtin_with_a_pinned_model \
  ClaudeRoutingSurfaces.test_controller_uses_bare_standalone_agent_names
```

Expected: FAIL because `claude/agents/Explore.md` does not exist and the controller still uses plugin-scoped identifiers.

- [ ] **Step 3: Add a Claude-only Explore identity and update routing**

Keep the provider-neutral catalog ID `repo-explorer` and add a Claude-only
adapter name. This prevents the built-in Claude identity from leaking into the
Codex description or filename:

```json
{
  "id": "repo-explorer",
  "description": "Use proactively for quick, medium, or very thorough read-only repository research, file and symbol discovery, architecture analysis, dependency tracing, behavior analysis, and implementation-context gathering. Answers one bounded question and never modifies files.",
  "prompt": "prompts/repo-explorer.md",
  "claude": {
    "name": "Explore",
    "model": "sonnet",
    "effort": "medium",
    "tools": ["Read", "Grep", "Glob", "LSP"],
    "disallowedTools": ["Write", "Edit", "NotebookEdit"]
  },
  "codex": {
    "name": "repo_explorer",
    "model": "gpt-5.6-terra",
    "model_reasoning_effort": "medium",
    "sandbox_mode": "read-only"
  }
}
```

Replace the three plugin-scoped worker references in `prompts/controller.md` with exact bare names: `task-analyst`, `Explore`, and `alan-wake`. Change the built-in-agent model-routing sentence so it no longer describes Explore as built-in:

```markdown
- `sonnet` — default worker for analysis, exploration, implementation, tests,
  debugging, research, review, and prose. The standalone workers pin Sonnet in
  their definitions; pass `sonnet` explicitly when dispatching built-in agents
  such as `Plan` or `general-purpose`.
```

- [ ] **Step 4: Add thoroughness handling to the Explore prompt**

Add this block near the start of `prompts/repo-explorer.md`:

```markdown
## Thoroughness

Honor the controller's requested exploration level:

- `quick`: locate the exact file, symbol, definition, or direct caller and
  return the smallest sufficient answer.
- `medium`: trace one bounded behavior, control flow, dependency, or test path
  and report the surrounding constraints.
- `very thorough`: examine the relevant architecture, cross-cutting callers and
  consumers, dependencies, tests, analogous implementations, and recent
  history before answering.

If no level is supplied, use `medium`. Every level remains read-only and must
separate observed evidence from inference.
```

- [ ] **Step 5: Point the renderer at the standalone source directory**

Change the Claude output constant in `scripts/render.py`:

```python
CLAUDE_AGENTS = ROOT / "claude" / "agents"
```

Teach `load_catalog()` to validate unique Claude adapter names and make
`render_claude()` use the adapter name when present:

```python
claude_names: set[str] = set()
for agent in agents:
    claude = agent.get("claude")
    if claude:
        claude_name = claude.get("name", agent["id"])
        if not isinstance(claude_name, str) or not claude_name:
            raise Problem(f"{agent['id']}: claude.name must be a non-empty string")
        if claude_name in claude_names:
            raise Problem(f"agents.json: duplicate Claude name {claude_name}")
        claude_names.add(claude_name)
```

```python
def render_claude(agent: dict[str, Any], prompt: str) -> str:
    config = agent["claude"]
    claude_name = config.get("name", agent["id"])
    frontmatter = [
        "---",
        f"name: {claude_name}",
        "description: >",
        yaml_folded(str(agent["description"])),
        f"model: {config['model']}",
        f"effort: {config['effort']}",
    ]
```

Update `expected_files()` to use the same adapter name for the Claude filename:

```python
if agent.get("claude"):
    claude_name = agent["claude"].get("name", agent["id"])
    rendered[CLAUDE_AGENTS / f"{claude_name}.md"] = render_claude(agent, prompt)
```

Keep the Codex output constant and `codex.name` logic unchanged, so the dormant
adapter remains `repo_explorer.toml` with `name = "repo_explorer"`.

- [ ] **Step 6: Render provider files**

Run:

```bash
python3 shared-agents/scripts/render.py
```

Expected: four files created under `shared-agents/claude/agents/`; Codex TOMLs updated only where shared prompt/catalog inputs changed.

- [ ] **Step 7: Run the focused rendering tests**

Run:

```bash
python3 shared-agents/tests/test_shared_agents.py -v \
  Rendering.test_claude_agents_render_to_standalone_source_directory \
  Rendering.test_explore_overrides_the_builtin_with_a_pinned_model \
  ClaudeRoutingSurfaces.test_controller_uses_bare_standalone_agent_names
python3 shared-agents/scripts/render.py --check
```

Expected: the three focused tests and renderer drift check PASS. The complete
suite is deferred until Task 2 replaces the old installation-lifecycle tests.

- [ ] **Step 8: Commit the rendering boundary**

```bash
git add shared-agents/agents.json shared-agents/prompts/controller.md shared-agents/prompts/repo-explorer.md shared-agents/prompts/alan-wake.md shared-agents/scripts/render.py shared-agents/claude/agents shared-agents/codex/agents shared-agents/tests/test_shared_agents.py
git commit -m "feat(shared-agents): render standalone Claude agents"
```

---

### Task 2: Replace plugin/native wiring with atomic Claude copies

**Files:**

- Modify: `shared-agents/tests/test_shared_agents.py`
- Modify: `shared-agents/scripts/manage.py`

**Interfaces:**

- Consumes: regular source files returned by `claude_agent_sources() -> list[Path]`.
- Produces: `same_regular_file(source: Path, target: Path) -> bool`, `copy_claude_agent(source: Path, target: Path, backups: BackupStore) -> bool`, `install_claude_agents(backups: BackupStore) -> list[Path]`, and byte-for-byte live status.

- [ ] **Step 1: Replace symlink/plugin lifecycle tests with copy lifecycle tests**

Delete the obsolete `ManagedBlocks` and `Symlinks` test classes. They verify
global policy edits, Codex symlinks, plugin installation, settings mutation,
and install-state restoration that the standalone installer no longer owns.

Add a `StandaloneCopies` test class using `TemporaryDirectory` and patched constants:

```python
class StandaloneCopies(unittest.TestCase):
    def test_install_copies_regular_files_and_is_idempotent(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "live"
            source.mkdir()
            (source / "controller.md").write_text("controller\n", encoding="utf-8")
            backups = manage.BackupStore(root / "backups" / "first")
            with mock.patch.multiple(
                manage,
                CLAUDE_SOURCE=source,
                CLAUDE_TARGET=target,
                create=True,
            ):
                changed = manage.install_claude_agents(backups)
                self.assertEqual(changed, [target / "controller.md"])
                self.assertFalse((target / "controller.md").is_symlink())
                self.assertEqual((target / "controller.md").read_text(), "controller\n")
                self.assertEqual(manage.install_claude_agents(backups), [])

    def test_install_backs_up_a_conflicting_target(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "live"
            source.mkdir()
            target.mkdir()
            (source / "Explore.md").write_text("new\n", encoding="utf-8")
            (target / "Explore.md").write_text("personal\n", encoding="utf-8")
            backups = manage.BackupStore(root / "backups" / "install")
            with mock.patch.multiple(manage, CLAUDE_SOURCE=source, CLAUDE_TARGET=target):
                manage.install_claude_agents(backups)
            self.assertEqual((target / "Explore.md").read_text(), "new\n")
            self.assertEqual(len(backups.created), 1)
            self.assertEqual(backups.created[0].read_text(), "personal\n")

    def test_uninstall_preserves_a_user_modified_copy(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            target = root / "live"
            source.mkdir()
            target.mkdir()
            (source / "controller.md").write_text("managed\n", encoding="utf-8")
            (target / "controller.md").write_text("user changed\n", encoding="utf-8")
            with mock.patch.multiple(manage, CLAUDE_SOURCE=source, CLAUDE_TARGET=target):
                self.assertEqual(manage.uninstall_claude_agents(), [])
            self.assertTrue((target / "controller.md").exists())
```

- [ ] **Step 2: Run the copy tests and confirm they fail**

Run:

```bash
python3 shared-agents/tests/test_shared_agents.py -v StandaloneCopies
```

Expected: FAIL because the new copy interfaces do not exist.

- [ ] **Step 3: Reduce `manage.py` to standalone Claude lifecycle plus source validation**

Retain `Problem`, modern-Python detection, `BackupStore`, `run`, `package_problems`, the `render/check/install/status/uninstall` CLI, and dormant Codex source validation. Remove plugin installation, Codex live linking, global managed-block installation, Claude settings mutation, and install-state restoration.

Use these constants and helpers:

```python
ROOT = Path(__file__).resolve().parents[1]
CLAUDE_SOURCE = ROOT / "claude" / "agents"
CLAUDE_TARGET = Path.home() / ".claude" / "agents"
CLAUDE_SETTINGS = Path.home() / ".claude" / "settings.json"
BACKUP_ROOT = Path.home() / ".config" / "shared-agents" / "backups"
CODEX_SOURCE = ROOT / "codex" / "agents"
CODEX_CONTROLLER_PROFILE = ROOT / "codex" / "controller.config.toml"


def claude_agent_sources() -> list[Path]:
    return sorted(CLAUDE_SOURCE.glob("*.md"))


def same_regular_file(source: Path, target: Path) -> bool:
    return (
        target.is_file()
        and not target.is_symlink()
        and source.read_bytes() == target.read_bytes()
    )


def copy_claude_agent(source: Path, target: Path, backups: BackupStore) -> bool:
    if same_regular_file(source, target):
        return False
    if target.exists() or target.is_symlink():
        backups.preserve(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.shared-agents.tmp")
    temporary.unlink(missing_ok=True)
    try:
        shutil.copy2(source, temporary)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def install_claude_agents(backups: BackupStore) -> list[Path]:
    changed: list[Path] = []
    for source in claude_agent_sources():
        target = CLAUDE_TARGET / source.name
        if copy_claude_agent(source, target, backups):
            changed.append(target)
    return changed


def uninstall_claude_agents() -> list[Path]:
    removed: list[Path] = []
    for source in claude_agent_sources():
        target = CLAUDE_TARGET / source.name
        if same_regular_file(source, target):
            target.unlink()
            removed.append(target)
    return removed
```

- [ ] **Step 4: Update package and live validation**

Make `package_problems()` validate this exact Claude set and the special override:

```python
expected_claude = {"controller.md", "task-analyst.md", "Explore.md", "alan-wake.md"}
actual_claude = {path.name for path in claude_agent_sources()}
if actual_claude != expected_claude:
    problems.append(
        f"Claude agents are {sorted(actual_claude)}, expected {sorted(expected_claude)}"
    )
explore = CLAUDE_SOURCE / "Explore.md"
if explore.is_file():
    text = explore.read_text(encoding="utf-8")
    for required in ("name: Explore", "model: sonnet", "effort: medium"):
        if required not in text:
            problems.append(f"Explore.md is missing {required!r}")
```

Implement live validation without inspecting Codex or plugin state:

```python
def live_problems() -> list[str]:
    problems = package_problems()
    for source in claude_agent_sources():
        target = CLAUDE_TARGET / source.name
        if not same_regular_file(source, target):
            problems.append(f"{target}: missing, stale, or not a regular-file copy")
    try:
        settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    except FileNotFoundError:
        settings = {}
    except json.JSONDecodeError as exc:
        problems.append(f"{CLAUDE_SETTINGS}: invalid JSON: {exc}")
        settings = {}
    if "agent" in settings and settings["agent"] != "controller":
        problems.append("Claude user settings select an agent other than controller")
    return problems
```

- [ ] **Step 5: Update CLI handlers**

`cmd_install` must render, validate, copy, report backups, and run status. It must not call Claude/Codex plugin commands or mutate settings:

```python
def cmd_install(_: argparse.Namespace) -> int:
    run([sys.executable, str(ROOT / "scripts" / "render.py")])
    problems = package_problems()
    if problems:
        raise Problem("package validation failed:\n" + "\n".join(f"- {p}" for p in problems))
    backups = BackupStore()
    changed = install_claude_agents(backups)
    for path in changed:
        print(f"copied {path}")
    if backups.created:
        print(f"backed up {len(backups.created)} replaced file(s) under {backups.root}")
    return cmd_status(argparse.Namespace())


def cmd_uninstall(_: argparse.Namespace) -> int:
    removed = uninstall_claude_agents()
    for path in removed:
        print(f"removed {path}")
    print("preserved modified targets and all backups")
    return 0
```

- [ ] **Step 6: Run copy, package, and CLI tests**

Run:

```bash
python3 shared-agents/tests/test_shared_agents.py -v StandaloneCopies
python3 shared-agents/scripts/manage.py check
```

Expected: all tests PASS and package check reports `ok shared-agents package` without reading active Codex installation state.

- [ ] **Step 7: Commit the copy installer**

```bash
git add shared-agents/scripts/manage.py shared-agents/tests/test_shared_agents.py
git commit -m "refactor(shared-agents): install Claude agents as copies"
```

---

### Task 3: Retire the plugin package and document the standalone system

**Files:**

- Modify: `shared-agents/tests/test_shared_agents.py`
- Modify: `plugins.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `.agents/plugins/marketplace.json`
- Create: `shared-agents/evals/controller-routing.json`
- Delete: `shared-agents/plugins/shared-agents/`
- Delete: `shared-agents/policy/claude-global.md`
- Delete: `shared-agents/policy/claude-orchestration.md`
- Modify: `shared-agents/README.md`
- Modify: `shared-agents/ARCHITECTURE.md`
- Modify: `shared-agents/docs/sources.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: the standalone renderer and copy installer from Tasks 1–2.
- Produces: a three-plugin workspace marketplace and a self-contained `shared-agents` project outside the plugin system.

- [ ] **Step 1: Add failing package-boundary tests**

Reduce `ClaudeRoutingSurfaces.SURFACES` and `.DETAILED_SURFACES` to
`("prompts/controller.md",)`, because the standalone controller is the only
Claude routing system prompt. Keep Codex policy assertions separate. Update the
Codex non-inheriting-fork test to inspect only `policy/codex-global.md`, not the
deleted cross-provider skill:

```python
SURFACES = ("prompts/controller.md",)
DETAILED_SURFACES = ("prompts/controller.md",)

def test_codex_named_agent_route_uses_a_non_inheriting_fork(self) -> None:
    policy = (ROOT / "policy" / "codex-global.md").read_text(encoding="utf-8")
    self.assertIn('fork_turns = "none"', policy)
```

Then add these package-boundary tests:

```python
def test_shared_agents_is_not_a_workspace_plugin(self) -> None:
    catalog = json.loads((ROOT.parent / "plugins.json").read_text(encoding="utf-8"))
    names = {entry["name"] for entry in catalog["plugins"]}
    self.assertNotIn("shared-agents", names)
    self.assertFalse((ROOT / "plugins" / "shared-agents").exists())

def test_claude_routing_has_one_canonical_surface(self) -> None:
    self.assertFalse((ROOT / "policy" / "claude-global.md").exists())
    self.assertFalse((ROOT / "policy" / "claude-orchestration.md").exists())
    controller = (ROOT / "prompts" / "controller.md").read_text(encoding="utf-8")
    self.assertIn("`Explore` on Sonnet", controller)
    self.assertNotIn("shared-agents:", controller)

def test_routing_evals_live_outside_the_plugin_tree(self) -> None:
    path = ROOT / "evals" / "controller-routing.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    self.assertEqual(payload["agent_name"], "controller")
    self.assertGreaterEqual(len(payload["evals"]), 3)
```

- [ ] **Step 2: Run boundary tests and confirm they fail**

Run:

```bash
python3 shared-agents/tests/test_shared_agents.py -v \
  Package.test_shared_agents_is_not_a_workspace_plugin \
  Package.test_claude_routing_has_one_canonical_surface \
  Package.test_routing_evals_live_outside_the_plugin_tree
```

Expected: FAIL because the catalog, plugin tree, and duplicate policies still exist.

- [ ] **Step 3: Move the routing evals**

Create `shared-agents/evals/controller-routing.json` from the existing three evals and change only its ownership field:

```json
{
  "agent_name": "controller",
  "evals": [
    {
      "id": 1,
      "prompt": "Inspect the current branch and write a concise GitLab MR title and description using the repository template.",
      "expected_output": "The controller verifies the branch facts and routes the final ready-to-paste MR prose through Alan Wake.",
      "files": [],
      "expectations": [
        "Uses alan-wake for the final draft",
        "Checks the actual diff, verification, and repository template before drafting",
        "Does not invent test, deployment, or rollout claims"
      ]
    },
    {
      "id": 2,
      "prompt": "The checkout page feels laggy after our refactor. Make it fast and fix whatever is wrong.",
      "expected_output": "The controller first routes bounded problem normalization to task-analyst and establishes measurable evidence before implementation.",
      "files": [],
      "expectations": [
        "Uses task-analyst",
        "Separates the symptom from an established root cause",
        "Chooses an observable performance proxy before proposing a fix"
      ]
    },
    {
      "id": 3,
      "prompt": "What does this configuration key do? Read the local definition and answer me in two sentences.",
      "expected_output": "The controller answers directly when the lookup is small and does not invoke Alan Wake for ordinary conversation.",
      "files": [],
      "expectations": [
        "Does not use alan-wake",
        "Keeps a small tightly coupled lookup in the primary thread",
        "Answers from repository evidence"
      ]
    }
  ]
}
```

- [ ] **Step 4: Remove `shared-agents` from the canonical plugin catalog**

Delete the complete `shared-agents` object from the `plugins` array in `plugins.json`, leaving `obsidian-memory`, `agent-board`, and `codex-pair` unchanged. Regenerate manifests:

```bash
python3 scripts/plugins.py sync
```

Expected: both generated marketplace files report three plugins and contain no `shared-agents` entry.

- [ ] **Step 5: Delete plugin-only sources and duplicate Claude policies**

Delete the complete `shared-agents/plugins/shared-agents/` directory after confirming all four generated agents exist under `shared-agents/claude/agents/` and the eval file exists under `shared-agents/evals/`. Delete `policy/claude-global.md` and `policy/claude-orchestration.md`. Keep `policy/codex-global.md` as dormant Codex source.

- [ ] **Step 6: Rewrite project and workspace documentation**

Document these exact points:

- Claude Code loads copied user agents from `~/.claude/agents/`.
- `Explore.md` intentionally overrides built-in Explore and pins Sonnet.
- `manage.py install` renders, validates, and copies only Claude agents.
- Source changes require rerunning `manage.py install`.
- The plugin is retired and must not be installed through `plugins.py`.
- Codex source adapters are retained but no Codex installation is performed.
- The project never owns Fish aliases; the local `clauded` alias is user-managed.

Update `docs/sources.md` with the current official subagent URL, the exact Explore override rule, user-scope precedence, frontmatter fields, watcher behavior, and the local verification version `Claude Code 2.1.227`.

- [ ] **Step 7: Run package and workspace checks**

Run:

```bash
python3 shared-agents/scripts/render.py --check
python3 shared-agents/scripts/manage.py check
python3 scripts/plugins.py check
git diff --check
```

Expected: all checks PASS; the workspace catalog reports three plugins and still runs the independent `shared-agents` project check.

- [ ] **Step 8: Commit plugin retirement**

```bash
git add plugins.json .claude-plugin/marketplace.json .agents/plugins/marketplace.json README.md shared-agents
git commit -m "refactor(shared-agents): retire plugin packaging"
```

---

### Task 4: Activate and prove the standalone Claude configuration

**Files:**

- Modify: `~/.claude/CLAUDE.md` (remove only the shared-agents managed block)
- Delete: `~/.claude/rules/orchestration.md` (only when it is the owned symlink)
- Create/replace: `~/.claude/agents/controller.md`
- Create/replace: `~/.claude/agents/task-analyst.md`
- Create/replace: `~/.claude/agents/Explore.md`
- Create/replace: `~/.claude/agents/alan-wake.md`
- Modify: `~/.config/fish/config.fish` (one alias line only)

**Interfaces:**

- Consumes: `python3 shared-agents/scripts/manage.py install` and exact Claude agent names.
- Produces: live user-level agents and `clauded -> claude --agent controller --effort high`.

- [ ] **Step 1: Capture non-mutating preflight state**

Run:

```bash
claude --version
claude plugin list --json
python3 shared-agents/scripts/manage.py status
readlink /Users/david.david/.claude/rules/orchestration.md
fish -n /Users/david.david/.config/fish/config.fish
```

Expected before migration: Claude 2.1.227; the shared-agents plugin is installed; standalone status reports missing copies; the orchestration link targets this checkout; Fish parses.

- [ ] **Step 2: Uninstall only the retired Claude plugin**

Run:

```bash
claude plugin uninstall shared-agents@ai-workspace --scope user --yes
```

Expected: success for exactly `shared-agents@ai-workspace`; other plugins remain installed.

- [ ] **Step 3: Remove only obsolete shared-agent global routing**

In `~/.claude/CLAUDE.md`, delete from this marker through its matching end marker, preserving all surrounding text:

```markdown
<!-- shared-agents:managed:start -->
```

through:

```markdown
<!-- shared-agents:managed:end -->
```

Delete `~/.claude/rules/orchestration.md` only after `readlink` confirms it targets `/Users/david.david/Personal/ai/shared-agents/policy/claude-orchestration.md`. Do not delete any other rule.

Run the guarded deletion as two separate commands after the check succeeds:

```bash
test "$(readlink /Users/david.david/.claude/rules/orchestration.md)" = "/Users/david.david/Personal/ai/shared-agents/policy/claude-orchestration.md"
unlink /Users/david.david/.claude/rules/orchestration.md
```

- [ ] **Step 4: Install copied agents**

Run:

```bash
python3 shared-agents/scripts/manage.py install
python3 shared-agents/scripts/manage.py install
python3 shared-agents/scripts/manage.py status
```

Expected: first install copies four files; second install reports no changes; status passes. `find ~/.claude/agents -maxdepth 1 -type l` returns no managed agent symlinks.

- [ ] **Step 5: Update only the Fish controller alias**

Change this line:

```fish
alias clauded "claude --agent shared-agents:controller --effort medium --dangerously-skip-permissions"
```

to:

```fish
alias clauded "claude --agent controller --effort high --dangerously-skip-permissions"
```

Preserve all other Fish content. Validate:

```bash
fish -n /Users/david.david/.config/fish/config.fish
fish -ic 'alias clauded'
```

Expected: Fish parses and the alias contains `--agent controller --effort high`.

- [ ] **Step 6: Prove controller and Explore resolution**

Create a temporary debug directory and run bounded, non-writing probes from the repository root:

```bash
shared_agents_probe_dir=$(mktemp -d)
claude --agent controller --effort high --debug-file "$shared_agents_probe_dir/controller.log" --print --output-format json "Reply exactly CONTROLLER-STANDALONE-OK. Do not use tools."
claude --agent Explore --effort medium --debug-file "$shared_agents_probe_dir/explore.log" --print --output-format json "Reply exactly EXPLORE-STANDALONE-OK. Do not use tools."
```

Then run one controller delegation:

```bash
claude --agent controller --effort high --debug-file "$shared_agents_probe_dir/delegation.log" --print --output-format stream-json --verbose "Use Agent(Explore) with quick thoroughness to identify the file that defines the standalone Claude output directory. Return its path and no other analysis."
rg -n "Explore|sonnet|shared-agents:" "$shared_agents_probe_dir"
```

Expected: the event stream contains an `Explore` agent call, the answer identifies
`shared-agents/scripts/render.py`, the trace resolves the Explore worker to
Sonnet, and no plugin-scoped agent name appears.

- [ ] **Step 7: Prove Explore is read-only**

From a new temporary directory, run the standalone Explore agent with a request to create `should-not-exist.txt`:

```bash
claude --agent Explore --effort medium --print --output-format json "Create should-not-exist.txt containing test."
```

Expected: Explore reports that it cannot write and `should-not-exist.txt` does not exist. Its explicit tool allowlist lacks `Write`, `Edit`, `NotebookEdit`, and `Bash`.

- [ ] **Step 8: Verify plugin and namespace removal**

Run:

```bash
claude plugin list --json
rg -n "shared-agents:(controller|task-analyst|repo-explorer|alan-wake)" /Users/david.david/.claude /Users/david.david/.config/fish/config.fish
```

Expected: the plugin list has no `shared-agents@ai-workspace`; the active Claude/Fish search returns no plugin-scoped shared-agent identifiers. Ignore historical transcripts and caches outside active configuration.

---

### Task 5: Final verification and durable handoff

**Files:**

- Modify: `/Users/david.david/Documents/Obsidian Vault/projects/shared-agents/README.md`
- Create: `/Users/david.david/Documents/Obsidian Vault/projects/shared-agents/decisions/0004-standalone-claude-agents.md`
- Modify: `/Users/david.david/Documents/Obsidian Vault/daily/2026-08-11.md`
- Modify when cross-session context materially changes: `/Users/david.david/Documents/Obsidian Vault/wiki/hot.md`

**Interfaces:**

- Consumes: verified repository and live-install evidence from Tasks 1–4.
- Produces: current durable memory stating that Claude uses standalone agents and Codex remains intentionally minimal.

- [ ] **Step 1: Run the complete repository verification gate**

```bash
python3 shared-agents/scripts/render.py --check
python3 -m unittest discover -s shared-agents/tests -v
python3 shared-agents/scripts/manage.py check
python3 shared-agents/scripts/manage.py status
python3 scripts/plugins.py check
python3 wiki/scripts/check.py
fish -n /Users/david.david/.config/fish/config.fish
git diff --check
git status --short
```

Expected: all commands PASS. Git status contains only the intended standalone migration plus any explicitly preserved pre-existing user edits.

- [ ] **Step 2: Inspect the final diff for preservation and scope**

Confirm all of these directly:

- `agents.json` still has controller `effort: high`.
- `prompts/alan-wake.md` retains the canonical-link construction and Slack MCP Markdown exception.
- `codex/agents/alan_wake.toml` reflects the same prompt updates but no live Codex paths were installed.
- No files outside `shared-agents`, the generated root marketplace surfaces, root `README.md`, and the requested Fish/Claude live configuration changed.
- Other plugin entries and installed plugins are unchanged.

- [ ] **Step 3: Update durable memory using the Obsidian memory conventions**

Before writing, read the Obsidian memory skill's `references/vault-layout.md` and `references/memory-governance.md`. Create DDR-0004 with explicit user-request provenance, `status: accepted`, and `supersedes` pointing to the Claude packaging portion of DDR-0001 while preserving DDR-0001's Codex history. Record:

- Claude now loads `controller`, `task-analyst`, `Explore`, and `alan-wake` from `~/.claude/agents/`.
- `Explore` intentionally overrides the built-in and pins Sonnet.
- `shared-agents@ai-workspace` is no longer a plugin.
- `clauded` selects bare `controller` at high effort.
- Codex shared-agents remain retired and were not reinstalled.
- Exact verification commands and live probe results.

Update the project memory page and daily note. Update `wiki/hot.md` only if this migration is useful cross-session startup context; keep the existing Codex-minimal statement intact.

- [ ] **Step 4: Validate memory and working tree**

```bash
python3 wiki/scripts/check.py
git diff --check
git status --short
```

Expected: wiki validation PASS and repository status remains limited to intended changes.

- [ ] **Step 5: Commit the final documentation/memory-adjacent repository changes if any remain**

Do not stage the external Obsidian vault in this repository. For repository files only:

```bash
git add README.md shared-agents
git commit -m "docs(shared-agents): document standalone Claude activation"
```

Skip this commit when Tasks 1–3 already committed every repository change.
