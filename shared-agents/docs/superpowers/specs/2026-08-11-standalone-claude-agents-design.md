# Standalone Claude Agents Design

Date: 2026-08-11
Status: Approved design; pending written-spec review

## Outcome

Replace the `shared-agents` Claude plugin with four personal Claude Code agent
definitions installed under `~/.claude/agents/`:

- `controller`
- `task-analyst`
- `repo-explorer`
- `alan-wake`

The migration restores the earlier standalone user-agent layout while retaining
the current prompt, model, effort, routing, and Alan Wake formatting updates.
Claude Code must resolve the main agent as `controller`, without the former
`shared-agents:` plugin namespace.

## Scope

### In scope

- Move rendered Claude agent sources from the plugin package to
  `shared-agents/claude/agents/`.
- Render Claude agents from the existing canonical `agents.json` and
  `prompts/*.md` inputs.
- Fold the useful Claude routing rules from the removed `shared-agents` skill
  into the standalone controller contract, using bare user-agent names.
- Make `shared-agents/scripts/manage.py install` copy the four rendered files
  into `~/.claude/agents/` atomically and preserve conflicting files in the
  existing backup area.
- Remove `shared-agents` from the workspace plugin catalog and generated
  marketplace manifests.
- Remove the obsolete plugin package and uninstall only
  `shared-agents@ai-workspace` from Claude Code.
- Remove the shared-agents-owned Claude global managed block and orchestration
  rule so they cannot retain plugin-scoped names or duplicate the controller.
- Update the user-owned Fish `clauded` alias to select `--agent controller` at
  high effort.
- Update project documentation and tests for the standalone installation.

### Out of scope

- Installing, restoring, or changing the retired Codex shared-agent stack.
- Modifying other Claude or Codex plugins.
- Reintroducing project-managed shell integration.
- Changing unrelated Fish configuration.
- Changing the current controller and Alan Wake content beyond the namespace
  and packaging adjustments needed for standalone agents.

The dormant Codex source adapters remain in the repository and remain
uninstalled. The migration does not write to active Codex configuration.

## Architecture

`agents.json` remains the metadata source and `prompts/*.md` remain the prompt
sources. The renderer produces provider-native files in separate source
directories:

```text
agents.json + prompts/*.md
            |
            v
     scripts/render.py
        /          \
       v            v
claude/agents/*.md  codex/agents/*.toml
       |
       | manage.py install (atomic copy)
       v
~/.claude/agents/*.md
```

The Claude output directory is ordinary source-controlled project content, not
a plugin component. Claude Code discovers the installed copies as user-level
agents available across projects. `controller` runs as the main thread through
the existing Claude `agent` setting or the explicit `claude --agent controller`
launcher. Its worker references use the bare names `task-analyst`,
`repo-explorer`, and `alan-wake`.

This follows Claude Code's documented user-agent location and main-agent launch
contract: <https://code.claude.com/docs/en/sub-agents>.

## Agent behavior

- `controller` uses Fable with high effort and remains the only main-thread
  controller. It owns scoping, delegation, synthesis, verification, and the
  final response.
- `task-analyst` uses Sonnet with high effort and read-only tools to normalize
  vague, risky, or symptom-based work.
- `repo-explorer` uses Sonnet with medium effort and read-only tools for one
  bounded repository question.
- `alan-wake` uses Sonnet with medium effort and read-only tools for terminal
  drafting of requested human-facing prose.

The standalone controller contains the routing contract formerly duplicated in
the plugin skill. There is no standalone `shared-agents` skill because its
behavior belongs to the main agent's system prompt. Specialist terminal
contracts remain inside their own definitions.

Read-only specialists retain explicit tool allowlists and write-tool denials.
The controller does not declare a restrictive tool allowlist, because doing so
would suppress dynamically available tools and MCP integrations in main
sessions. Its prompt restricts delegation to valid agent names and makes the
controller responsible for reviewing worker output.

## Installation and recovery

`manage.py install` performs only the standalone Claude agent installation:

1. Render and validate the canonical source.
2. Create `~/.claude/agents/` if necessary.
3. Back up an existing non-matching target before replacement.
4. Copy each rendered Markdown file through a temporary file and atomically
   replace its target.
5. Report copied, unchanged, and backed-up files.

The installed files are copies rather than symlinks. Source edits therefore
become live after rerunning `manage.py install`. Repeated installation with
unchanged source is idempotent.

`manage.py status` validates that all four installed files match the rendered
source byte for byte and that Claude's selected agent, when configured, names
`controller`. It does not require or inspect Codex installation state.

Uninstall removes only standalone targets that still match the managed source;
it never removes a file the user changed after installation. Existing backup
paths stay recoverable.

## One-time live migration

The repository change and local activation are separate but coordinated:

1. Remove `shared-agents` from `plugins.json` and regenerate the two workspace
   marketplace manifests.
2. Remove the obsolete `shared-agents/plugins/shared-agents/` tree after moving
   agent definitions to `shared-agents/claude/agents/` and routing evaluations
   to `shared-agents/evals/controller-routing.json`.
3. Uninstall only `shared-agents@ai-workspace` from Claude Code.
4. Remove only the shared-agents-managed block from `~/.claude/CLAUDE.md` and
   the owned `~/.claude/rules/orchestration.md` symlink.
5. Copy the four standalone definitions into `~/.claude/agents/`.
6. Keep `~/.claude/settings.json` selecting `controller`.
7. Change only the `clauded` Fish alias agent identifier and effort, preserving
   its other user-owned flags.

Other installed plugins and unrelated Claude, Codex, and shell configuration
remain untouched.

## Failure handling

- Invalid catalog, frontmatter, model routing, or generated drift fails before
  installation.
- A conflicting personal agent is backed up before replacement.
- Atomic replacement prevents a partially written live definition.
- Invalid Claude settings are reported rather than overwritten.
- Plugin cleanup targets the exact `shared-agents@ai-workspace` identifier.
- Global cleanup recognizes only the existing managed markers and exact owned
  orchestration symlink.
- Status reports missing or stale copies with their exact paths.

## Verification

The migration is complete when all of the following pass:

- `python3 shared-agents/scripts/render.py --check`
- `python3 -m unittest discover -s shared-agents/tests -v`
- `python3 shared-agents/scripts/manage.py check`
- `python3 shared-agents/scripts/manage.py status`
- `python3 scripts/plugins.py check`
- `git diff --check`
- Fish parses the updated configuration.
- Claude lists or successfully launches the bare `controller` agent in a
  bounded runtime probe.
- The live `shared-agents@ai-workspace` Claude plugin is absent.
- No active Claude routing surface references `shared-agents:controller`,
  `shared-agents:task-analyst`, `shared-agents:repo-explorer`, or
  `shared-agents:alan-wake`.

The final diff and Git status must also confirm that the user's pre-existing
controller-effort and Alan Wake changes were preserved.
