# Bun global tools

This directory is the reproducible manifest and health check for user-installed
JavaScript command-line tools. Bun owns user globals; npm is retained only as
the package manager bundled with the Homebrew Node runtime.

## Policy

- Install user CLI packages with `bun add --global --exact <package>@<version>`.
- Record every global tool and expected binary in `manifest.json`.
- Pin exact versions so another machine or rebuild does not silently drift.
- Add lifecycle-script trust only for reviewed packages that require it.
- Do not use `npm install --global`. The check permits only runtime-owned
  `npm` and `corepack` in npm's global prefix.
- Keep `~/.bun/bin` on `PATH`. The check fails when another installation
  shadows a declared Bun binary.

QMD requires native SQLite, llama.cpp, and tree-sitter lifecycle scripts.
`go-ios` requires its own postinstall script and `npm_config_prefix=~/.bun`.
The manifest records this narrow trust set; do not replace it with
`bun pm trust --all`.

## Reproduce

```bash
python3 bun-global-tools/sync.py apply
```

This installs the pinned packages, applies only the declared lifecycle trust,
and performs the deep health check. It does not automatically uninstall npm
globals; remove any drift reported by the check only after its Bun replacement
is verified.

## Validate

```bash
python3 bun-global-tools/sync.py check
python3 bun-global-tools/sync.py check --deep
```

The deep form also opens the existing QMD database. The derived QMD index and
models remain under `~/.cache/qmd`; package-manager migration does not move or
replace them.
