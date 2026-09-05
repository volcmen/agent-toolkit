---
paths:
  - "**/*.{asm,bash,c,cc,clj,cljs,cmake,cpp,cs,css,cxx,dart,eex,erl,ex,exs,fs,fsx,go,gradle,groovy,h,hcl,hh,hpp,hrl,html,hxx,java,js,jsx,json,kt,kts,lua,m,mm,nix,php,pl,pm,proto,py,r,R,rb,rs,sass,scala,scss,sh,sol,sql,svelte,swift,tf,tfvars,toml,ts,tsx,vue,xml,yaml,yml,zig}"
  - "**/{BUILD,BUILD.bazel,CMakeLists.txt,Containerfile,Dockerfile,Gemfile,GNUmakefile,Jenkinsfile,Makefile,Rakefile,Vagrantfile,WORKSPACE,WORKSPACE.bazel}"
  - "**/.{bash_profile,bashrc,profile,zprofile,zshrc}"
---

# Code quality

Applies when writing or modifying code and structured configuration. Project
instructions, formatter output, and established repository conventions win.

## Comments

The default is no comment. A comment is a failure to express intent in code.
When code seems to need narration, rename, extract, or restructure it instead.

Never add:

- explanatory comments describing what the code does or how it works;
- rationale for the change, the alternative rejected, or the bug being fixed;
- section banners, step numbering, or reviewer narration;
- docstrings that restate a signature already carried by names and types;
- module or test docstrings that narrate context, fixtures, provenance,
  history, or the ticket that motivated the code — test intent lives in the
  test name; provenance lives in the commit body;
- `TODO`, `FIXME`, deferred-work markers, or issue and ticket keys such as
  `NTD-1234` anywhere in source;
- commented-out code, dead code kept "for reference", or attribution notes.

Rationale belongs in the commit body and the merge-request description, never
inline. Deferred work belongs in the tracker, never in a marker.

Narrow exceptions, permitted only when the language, toolchain, or published
contract requires them:

- license headers and generated-file markers;
- public API documentation the project actually publishes;
- tool directives such as `# noqa`, `# type: ignore`, or
  `// eslint-disable-next-line`;
- one line stating an externally imposed constraint that cannot be inferred
  from the code at all — a protocol quirk, upstream defect, or hardware limit.
  State the constraint, not the reasoning, and only when the file already
  carries comments of that kind.

Match the surrounding file's comment density and never raise it. Delete
comments the change makes false; do not update a comment that should not exist.

## Naming and functions

- Names state intent and are searchable and pronounceable. No abbreviations,
  type prefixes, encodings, or generic terms such as `data`, `info`, `handle`,
  `process`, `manager`, `helper`, or `util`.
- A function does one thing at a single level of abstraction, and its name says
  which thing. Extract when a block needs a heading to be understood.
- Prefer zero to two parameters. Replace a boolean flag parameter with two
  named functions. Avoid output parameters.
- Separate commands from queries. A name that reads as a question must not
  mutate state, and a function must not hide side effects from its caller.
- Return neither `null`/`None` nor a sentinel where the type system offers an
  empty value, an option, or an explicit error.

## Structure and failure behavior

- Keep the happy path easy to follow; use guard clauses when they reduce
  nesting. Choose precise domain names instead of generic counters or helpers.
- Keep functions and modules focused. Prefer explicit data flow and narrow
  interfaces over hidden mutation, global state, or action at a distance.
- Prefer small local duplication over a premature abstraction. Extract when the
  repeated behavior represents a stable concept and the abstraction makes its
  callers and contract clearer.
- Validate untrusted input and external responses at system boundaries. Trust
  internal invariants once established; do not add defensive branches for
  impossible states.
- Fail explicitly on broken invariants and preserve useful error context.
  Defaults or fallbacks are acceptable when required by the contract, but must
  not silently conceal corruption, outages, or programmer errors.

## Change discipline

- Touch only what the requested change needs. Avoid drive-by formatting,
  renames, dependency changes, or adjacent refactors.
- Refactor inside the change's footprint when it directly reduces the risk or
  complexity of the requested change. Propose broader cleanup separately.
- Reuse repository dependencies and patterns before adding new ones. Add a
  dependency only when its benefit justifies its maintenance and supply-chain
  cost.

## Tests

- Test observable behavior through stable public or integration boundaries
  where practical; avoid assertions tied only to implementation details.
- A new test file adopts the harness of its sibling tests — base class,
  assert style, fixture mechanism, runner — verified by reading two neighbor
  files before writing; never mix unittest-style classes with pytest fixtures
  in a suite that uses one convention.
- Prefer property-based tests for pure and contract-bearing functions per
  `~/.claude/rules/testing.md`; hand-picked examples pin regressions only.
- When behavior changes and a test harness exists, add or update tests in
  proportion to the risk. Bug fixes should include a regression case that
  demonstrates the prior failure when practical.
- Keep tests deterministic and independent. Do not weaken, delete, or skip a
  failing test merely to make a check green; fix the cause or report why the
  expectation is wrong.
