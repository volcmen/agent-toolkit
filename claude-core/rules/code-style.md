---
paths:
  - "**/*.{asm,bash,c,cc,clj,cljs,cmake,cpp,cs,css,cxx,dart,eex,erl,ex,exs,fs,fsx,go,gradle,groovy,h,hcl,hh,hpp,hrl,html,hxx,java,js,jsx,json,kt,kts,lua,m,mm,nix,php,pl,pm,proto,py,r,R,rb,rs,sass,scala,scss,sh,sol,sql,svelte,swift,tf,tfvars,toml,ts,tsx,vue,xml,yaml,yml,zig}"
  - "**/{BUILD,BUILD.bazel,CMakeLists.txt,Containerfile,Dockerfile,Gemfile,GNUmakefile,Jenkinsfile,Makefile,Rakefile,Vagrantfile,WORKSPACE,WORKSPACE.bazel}"
  - "**/.{bash_profile,bashrc,profile,zprofile,zshrc}"
---

# Code and test quality

Elaborates the source and test invariants in `CLAUDE.md` for code and
structured configuration. Formatter output and established repository
conventions win on style.

## Comments

A comment is a failure to express intent in code: rename, extract, or
restructure instead. Never add narration, rationale, section banners,
docstrings that restate a signature or describe fixtures, `TODO`/`FIXME`,
commented-out code, or attribution. Match the surrounding density, never raise
it; delete comments the change makes false. Permitted only when the toolchain or
a published contract demands them: license headers, generated-file markers,
public API docs the project actually publishes, tool directives (`# noqa`,
`# type: ignore`, `// eslint-disable-next-line`), and one line stating an
externally imposed constraint (protocol quirk, upstream defect, hardware limit)
in a file that already carries such comments.

## Code

- Names state intent, searchable and pronounceable: no abbreviations, type
  prefixes, or `data`/`info`/`handle`/`process`/`manager`/`helper`/`util`.
- One function, one thing, one level of abstraction; extract when a block needs
  a heading. Zero to two parameters; two named functions instead of a boolean
  flag; no output parameters. Queries never mutate; side effects are visible to
  the caller. No `null`/`None` or sentinel where an empty value, option, or
  explicit error exists.
- Guard clauses over nesting; explicit data flow and narrow interfaces over
  hidden mutation or global state. Small local duplication beats a premature
  abstraction.
- Validate untrusted input at system boundaries; trust internal invariants — no
  branches for impossible states. Fail explicitly and preserve error context; a
  fallback never conceals corruption, an outage, or a programmer error.
- Touch only what the change needs: no drive-by formatting, renames, dependency
  changes, or adjacent refactors. A new dependency must justify its maintenance
  and supply-chain cost.

## Tests

- Test observable behavior through stable public or integration boundaries;
  assert the persisted or emitted result, not merely a return value or the
  absence of an exception.
- A new test file copies the harness of its neighbours (base class, assert
  style, fixtures, runner); read two before writing; never mix unittest classes
  with pytest fixtures in one convention.
- Pure or contract-bearing functions get a property-based test first
  (`hypothesis` with `st.builds`/`RuleBasedStateMachine`; `fast-check` with
  `@fast-check/vitest`, `zod-fast-check`); examples only pin known regressions
  or spec values. Pick the strongest property: round-trip, invariant,
  idempotence, oracle against an independent reference, metamorphic,
  commutativity. If the framework is missing, propose it in its own MR and
  meanwhile write a generative test with per-run entropy that prints the
  failing input.
- Explore unpinned, reproduce pinned: the default run gets fresh data — no
  `derandomize`, global seed, `Faker.seed`, or per-test seed. Seeds live only in
  a named profile the default does not select (hypothesis
  `settings.register_profile`: `explore`, `mutation` with `derandomize=True`,
  `nightly`; fast-check reads `FC_SEED`/`FC_PATH` from the environment). Commit
  the shrunk counterexample as an explicit example, never the seed. Default
  example count in the dev loop; 500+ for parsers, money, and security paths.
- Generate the right shape directly (`st.builds`, mapped arbitraries), not
  `filter`/`assume` chains. Faker supplies surface values inside a strategy that
  owns structure and edge cases. Keep the nasty values reachable: empty, one
  element, duplicates, NaN/±Infinity/-0.0, unicode, leap and DST dates,
  boundary integers.
- One property per test; no tautologies. Every new test has a named mutation
  that kills it, run red → green once; for a guard, remove the guard. An import
  or collection failure is not a kill. Never weaken, delete, or skip a failing
  test to go green.
- Gate runs use `--force-reruns 0` (pytest) or `--retry=0` (vitest); a test
  that passes only on rerun is flaky and gets an owner, an expiry, and a
  visible non-gating status.
- A regenerated snapshot is a rewritten baseline, not verification; keep
  snapshot updating off in evidence runs and pair snapshots with semantic
  assertions.
