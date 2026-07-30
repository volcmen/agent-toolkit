# DDR-0005: Standalone Bun project with zero runtime dependencies

- Status: accepted
- Date: 2026-07-27

## Context

The board could be embedded in a larger agent product, packaged as a library for
an existing desktop shell, or shipped as a standalone CLI. Embedding would couple
its storage, provider, and release lifecycle to another product. A standalone
project keeps the markdown format and dispatcher independently usable.

## Decision

Standalone **Bun + TypeScript** project with zero runtime dependencies. Cards,
roles, prompts, dispatcher, runners, and CLI are all in this project; the only
external tools are the agent CLIs already on `PATH`.

Bun's built-ins remove the usual dependency list: `bun:sqlite` (no native
`better-sqlite3` build), `Bun.spawn` (no `execa`), `fetch`, `bun test` (no
jest/vitest), `bunx tsc` for typecheck. Two devDependencies, both exact-pinned:
`typescript` and `@types/bun`.

## Consequences

- No coupling to another product's roadmap, storage, or release cycle.
- No GUI. The CLI is the interface, plus `ab attach` for the interactive case.
  A future GUI can consume this package rather than reimplement it; the storage
  format is files, which is the most portable seam.
- Zero dependencies means no supply-chain surface and no lockfile churn, at the
  cost of a hand-written frontmatter parser (small, tested) instead of a YAML lib.
- Ties this project to bun specifically. Acceptable: bun is the standing JS
  runtime/package-manager choice in this workspace.

## Alternatives

- **Inside a larger host application**: can reuse an existing UI, but couples the
  board to that application's milestones and runtime.
- **Python + uv** (matching the earlier plugin): would have reused the existing
  `check.py`, but streaming NDJSON from two CLIs and a typed card model are
  cleaner in TS, and bun removes the dependency cost that usually argues for
  Python here.
