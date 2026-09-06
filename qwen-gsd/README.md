# Qwen GSD

Qwen GSD packages `$qwen-gsd-slice` as a workspace plugin for Codex and Claude
Code. The orchestrating agent scopes and reviews each bounded vertical slice;
Qwen Code writes the production and test changes under hard execution budgets.

The workflow includes model-identity verification, partial-run detection,
structured run logs, usage accounting, one bounded correction round, and a
final project-level verification gate.

## Requirements

- Python 3.11 or newer
- Bash
- Qwen Code on `PATH`, authenticated with at least one configured model
- Codex or Claude Code with the repository marketplace installed

## Install

From the workspace root:

```bash
python3 scripts/plugins.py install --force
python3 scripts/plugins.py status
```

Start a new agent session after installation, then invoke
`$qwen-gsd-slice`. The skill performs its own Qwen CLI, authentication, and
model preflight before it scopes or edits a project.

Persistent configuration lives in `~/.qwen-gsd/config.json`; the
`QWEN_GSD_CONFIG` environment variable can relocate it. Run the bundled
`qwen_config.py show` command described by the skill to inspect effective
values and their sources.

## Develop

Run the project suite directly:

```bash
python3 qwen-gsd/scripts/check.py
```

Any plugin change must also pass the workspace lifecycle:

```bash
python3 scripts/plugins.py sync
python3 scripts/plugins.py check
python3 scripts/plugins.py install --force
python3 scripts/plugins.py status
```

The root `plugins.json` is the only marketplace source of truth. Generated
plugin and marketplace manifests must not be edited by hand.

## Layout

```text
qwen-gsd/
├── plugins/qwen-gsd/
│   └── skills/qwen-gsd-slice/
│       ├── SKILL.md
│       ├── agents/openai.yaml
│       ├── config/defaults.json
│       ├── references/
│       └── scripts/
├── scripts/check.py
└── tests/test_qwen_gsd.py
```

