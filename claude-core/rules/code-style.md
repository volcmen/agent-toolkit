---
paths:
  - "**/*.{asm,bash,c,cc,clj,cljs,cmake,cpp,cs,css,cxx,dart,eex,erl,ex,exs,fs,fsx,go,gradle,groovy,h,hcl,hh,hpp,hrl,html,hxx,java,js,jsx,json,kt,kts,lua,m,mm,nix,php,pl,pm,proto,py,r,R,rb,rs,sass,scala,scss,sh,sol,sql,svelte,swift,tf,tfvars,toml,ts,tsx,vue,xml,yaml,yml,zig}"
  - "**/{BUILD,BUILD.bazel,CMakeLists.txt,Containerfile,Dockerfile,Gemfile,GNUmakefile,Jenkinsfile,Makefile,Rakefile,Vagrantfile,WORKSPACE,WORKSPACE.bazel}"
  - "**/.{bash_profile,bashrc,profile,zprofile,zshrc}"
---

# Code and test quality

Elaborates the source and test invariants in `CLAUDE.md` for code and
structured configuration. Formatter output and established repository
conventions win on style; instruction precedence is `CLAUDE.md`'s.

## Comments

A comment is a failure to express intent in code: rename, extract, or
restructure instead. Never add narration of what code does, rationale or
rejected alternatives, section banners, docstrings that restate a signature,
module or test docstrings about fixtures or provenance, `TODO`/`FIXME` markers,
commented-out code, or attribution notes. Match the surrounding comment density
and never raise it; delete comments the change makes false.

Permitted only when the language, toolchain, or a published contract demands
them: license headers and generated-file markers; public API documentation the
project actually publishes; tool directives such as `# noqa`, `# type: ignore`,
`// eslint-disable-next-line`; one line stating an externally imposed constraint
that cannot be inferred from the code (protocol quirk, upstream defect,
hardware limit) — the constraint, not the reasoning, and only in a file that
already carries comments of that kind.

## Naming and functions

- Names state intent and are searchable and pronounceable: no abbreviations,
  type prefixes, or generic terms such as `data`, `info`, `handle`, `process`,
  `manager`, `helper`, `util`.
- A function does one thing at one level of abstraction and its name says
  which. Extract when a block needs a heading to be understood.
- Zero to two parameters; two named functions instead of a boolean flag; no
  output parameters. Separate commands from queries — a name that reads as a
  question must not mutate, and side effects are never hidden from the caller.
- Return neither `null`/`None` nor a sentinel where the type system offers an
  empty value, an option, or an explicit error.

## Structure and failure behavior

- Guard clauses over nesting; explicit data flow and narrow interfaces over
  hidden mutation, global state, or action at a distance.
- Small local duplication beats a premature abstraction; extract when the
  repeated behavior is a stable concept and the abstraction clarifies callers.
- Validate untrusted input and external responses at system boundaries; trust
  established internal invariants — no defensive branches for impossible states.
- Fail explicitly on broken invariants and preserve error context. A default or
  fallback is acceptable when the contract requires it and must never conceal
  corruption, an outage, or a programmer error.

## Change discipline

- Touch only what the requested change needs: no drive-by formatting, renames,
  dependency changes, or adjacent refactors. Refactor inside the footprint only
  when it directly reduces the change's risk; propose broader cleanup separately.
- Reuse repository dependencies and patterns before adding new ones; a new
  dependency must justify its maintenance and supply-chain cost.

## Tests

- Test observable behavior through stable public or integration boundaries;
  assert the persisted or emitted result — the stored row, the event, the final
  state — not merely a return value or the absence of an exception.
- A new test file copies the harness of the test files beside it: base class,
  assert style, fixture mechanism, runner. Read two neighbours before writing
  the first line; diverge only for a named repository reason; never mix unittest classes
  with pytest fixtures inside one convention.
- For any pure or contract-bearing function write a property-based test first;
  hand-picked examples only pin known regressions or document a spec value.
  Pick the strongest fitting property: round-trip `parse(render(x)) == x`;
  invariant `valid(f(x))`; idempotence `f(f(x)) == f(x)`; oracle
  `fast(x) == trusted(x)` with a genuinely independent reference; metamorphic
  `f(perturb(x)) ~ f(x)`; commutativity for merges. Python: `hypothesis`
  (`st.builds`, `RuleBasedStateMachine`); TypeScript: `fast-check`
  (`@fast-check/vitest`, `zod-fast-check`). If the repo lacks the framework,
  propose the dependency in its own MR and meanwhile write a generative test
  with per-run entropy that prints the failing input.
- Explore unpinned, reproduce pinned — the axis is the profile, not the presence
  of a seed. The default path a plain run takes gets fresh data every run: no
  `derandomize`, no global seed, no `Faker.seed`, no hardcoded RNG seed there,
  and never a seed on an individual test. A seed belongs only in a *named*
  profile the default does not select: hypothesis `settings.register_profile`
  (`explore` unpinned over `.hypothesis/examples`, a `mutation` profile with
  `derandomize=True` so a mutant is compared against a fixed sequence, `nightly`
  with a larger budget); fast-check reads `FC_SEED`/`FC_PATH` from the
  environment for replay and sets neither by default. Reproducibility comes from
  the framework — hypothesis replays its example database, fast-check prints
  `{seed, path}`; commit the shrunk counterexample as an explicit example, never
  the seed. Framework default example count in the dev loop; 500+ for parsers,
  money, and security-sensitive paths; never lower it to hide slowness.
- Generate the right shape directly (`st.builds`, mapped arbitraries) rather
  than `filter`/`assume` chains. Faker supplies surface values nested inside a
  strategy that owns structure and edge cases; it never provides adversarial
  values. Keep the nasty values reachable: empty, one element, duplicates,
  NaN/±Infinity/-0.0, unicode, leap and DST dates, boundary integers.
- One property per test; no tautologies that only exercise the generator or
  the type. Every new test has a named mutation that kills it, run red → green
  once. For a guard, the mutation is removing the guard: the test must detect the
  prohibited effect, and a "kill" caused by an import error, a collection
  failure, or broken discovery is not a kill. Never weaken, delete, or skip a
  failing test to go green — fix the cause or report why the expectation is wrong.
- A retry never converts a red run into a green one: run the gate with
  `--force-reruns 0` (pytest) or `--retry=0` (vitest), and treat a test that
  passes only on a rerun as flaky — an owner, an expiry, and a visible
  non-gating status, never a quietly smaller denominator.
- A regenerated snapshot is a rewritten baseline, not a verification. Keep
  snapshot updating off in any run that is meant as evidence, and pair a snapshot
  with semantic assertions on the properties that must hold.
