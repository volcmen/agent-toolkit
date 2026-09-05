# Test quality

Applies to every test I write or modify. Complements the `mr-preflight` gate:
F7 there proves a test discriminates; this rule governs how tests are built.

## Default to properties, not examples

- For any pure or contract-bearing function, write a property-based test first;
  hand-picked examples only pin known regressions (`@example` / committed
  counterexamples) or document a spec value.
- Choose the property from the catalogue, strongest fit first:
  round-trip `parse(render(x)) == x` (serializers, migrations, save/load);
  invariant `valid(f(x))` (money conservation, lengths, ordering);
  idempotence `f(f(x)) == f(x)` (normalizers, upserts, retries);
  oracle `fast(x) == trusted(x)` (rewrites, caches — only with a genuinely
  independent reference, never a paraphrase of the same algorithm);
  metamorphic `f(perturb(x)) ~ f(x)` (ranking/scoring with no exact oracle);
  commutativity (merge/union).
- Frameworks: Python `hypothesis` (+`st.builds` for domain objects, stateful
  `RuleBasedStateMachine` for API sequences); TypeScript `fast-check`
  (+`@fast-check/vitest`, `zod-fast-check` when a schema exists). If the repo
  lacks the framework, propose the dependency in its own MR; until it lands,
  write a generative test with per-run entropy that prints the failing input
  in the assertion message.

## Fresh data every run — never pin a seed

- No fixed seeds, ever: no `derandomize=True`, no global fast-check `seed`,
  no `Faker.seed(N)`, no hardcoded RNG seed in homebrew generators. A pinned
  seed freezes one path through input space and rots into false confidence.
- Reproducibility comes from the framework, not the seed: hypothesis persists
  failures to `.hypothesis/examples` and replays them first; fast-check prints
  `{seed, path}` on failure for one-off local replay. Replaying a reported
  failure locally is fine; committing the seed is not — commit the shrunk
  counterexample as an explicit example instead.
- Examples per property: framework default (100) in the dev loop; raise to
  500+ for parsers, money, security-sensitive paths (hypothesis profiles /
  `numRuns`); never lower below default to hide slowness — narrow the
  generator instead.

## Generators

- Generate the right shape directly (`st.builds`, mapped arbitraries); avoid
  `filter`/`assume` chains — starved generators degenerate into hand-picked
  examples and trip health checks.
- Faker supplies realistic surface values (names, emails, locales) NESTED
  inside a property strategy that still owns structure, cardinality, and edge
  cases; Faker alone never provides adversarial values and cannot shrink.
- Never over-constrain away the nasty values: empty, one-element, duplicates,
  NaN/±Infinity/-0.0, unicode (emoji, RTL, combining), leap/DST dates,
  boundary ints — the framework injects these only if the strategy allows them.

## What a test must assert

- The persisted/observable result — the stored row, emitted event, final
  state — not merely the return value or absence of exception.
- One property per test; a five-invariant mega-property shrinks and diagnoses
  poorly.
- No tautologies (asserting what the type or generator already guarantees) and
  no properties that only exercise the generator.
- Every new test must have a named mutation that kills it; run that mutation
  red→green once (mr-preflight F7 re-verifies at the gate). A test that
  survives its mutation is not a test.
