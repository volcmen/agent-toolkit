# Failure-modes index (gate-facing)

On-demand risk reference. `SKILL.md` owns readiness, evidence reuse, and
stopping. Consult only relevant rows; neither a detector hit nor a missing
command proves a defect. `preflight-triage.sh` is an optional legacy diagnostic,
not the default gate. History and recurrence origins live separately in
`failure-modes-history.md`. Historical check wording never overrides the skill's
proportional verification rules.

| id | class | trigger (script) | check the gate must evidence |
|----|-------|------------------|------------------------------|
| F1 | contract-change-unconsumed | removed src line with a `def`/`function`/`export` signature | `rg` every call site; table each as consumes / indifferent-with-proof. Fix visible only in tests = FAIL |
| F2 | empty-fallback-as-success | added `except`/`catch`/`??`/`\|\| {}` | per clause: literal returned, does the consumer render it as clean; caught type vs the one expected failure; if the literal feeds >1 consumer, table direction of error per consumer |
| F4 | blast-radius-unmeasured | changed behavior affects a population or fan-out | establish the affected bound when material to correctness, cost, or rollout |
| F5 | sibling-path-unswept | fix changes a repeated behavior or shared contract | search the fixed pattern for affected peers; justify relevant unchanged callers |
| F6 | boundary-uncoerced | added `sorted(`/`min(`/`max(`/`.sort(` | iterable may mix int/float/str from JSON/API? needs `key=str`/canonical key or FAIL |
| F7 | non-discriminating-test | test may pass without the production behavior | inspect its assertions; reuse observed failing-before/passing-after reproduction. Only if doubt remains, run one targeted mutation in isolation; setup/import failures are not proof |
| F8 | partial-function-misuse | added `parseInt`/`Number(`/`JSON.parse`/`int(`/`float(` | justify prefix-parse (`"12abc"`), undefined/NaN, `"1e5"` per call |
| F9 | scope-rider | any src change | hunk not required by the ticket → split or name it in the description |
| F10 | remediation-path-removed | added `disabled`/`readOnly`/`locked`, removed button/link | grep every flow routing users TO the affordance; each keeps a surviving path |
| F11 | hand-copied-mirror | added function in src | `rg <distinctive literal>` repo-wide excluding the diff; hit in shared module → delegate or link extraction ticket. No pasted rg = FAIL |
| F12 | workaround-divergence | dependency/lock file or Node flag/shim added | canonical mechanism exists in another branch/MR? use it |
| F13 | recovery-branch-assumption | added status-code / message string match | provenance for the trigger: doc cite, dependency source, or live probe pasted |
| F14 | untraced-runbook | `.md`/`.sh`/Jenkinsfile/groovy changed | trace the command with the real producer of its inputs; name what it creates/mutates/destroys |
| F15 | validator-intent-mismatch | added `.strip()`/`.trim()`/`.lower()`/`validate*`/`normalize*` | computed-but-discarded results; enumerate inputs violating the guard's stated purpose (`*`, empty, whitespace, comma-list) and show each handled in a test |
| F16 | description-claim-drift | behavior or description changed | match material claims and verification to the reviewed change; refresh changed claims, not every paragraph after every push |
| F17 | slop-comment-in-source | MECH | ticket keys or added comments/docstrings in source = FAIL (script pastes each line) |
| F18 | test-harness-convention-mismatch | new test uses a different harness | inspect nearby tests and runner config; follow the established harness unless the task needs a justified difference |
| F19 | example-only-test-for-contract-function | new test without hypothesis/fast-check; pinned seed is MECH FAIL | target is a pure/contract function? name the property class (round-trip/invariant/idempotence/oracle/metamorphic) or why none applies |
| F20 | capability-duplicates-existing-validator | new validation capability | search existing validators for the same contract; reuse overlap before adding another mechanism |
| F21 | session-link-leak | MECH | session URL / `Co-Authored-By: Claude` / `Generated with Claude` in commit bodies or MR description = FAIL |
| F22 | test-unwired-from-runner | new test file with no CI/runner-config reference | name the CI job + discovery glob (paste line), or paste an OPEN ticket/MR URL that wires it; prose disclosure = FAIL |
| F23 | paginated-response-first-page-only | added API list read | endpoint paginates? loop follows `next` or passes a server-honoured filter (read the ViewSet) |
| F24 | dead-code-left-by-fix | removed behavior may leave unused symbols | use existing lint evidence for affected files or inspect consumers; do not invoke an unrelated compiler on every change |
| F25 | feedback-surface-occluded | added toast/snackbar/Alert/notify | rejection renders above its trigger (z-order, unmount); test asserts `toBeVisible` |
| F27 | live-drift-without-tracking-artifact | description mentions kubectl/set env/out-of-band/hotfix | each drift item has an OPEN MR or ticket URL pasted; closed MR is not an artifact |
| F30 | remote-call-volume-invisible-in-tests | added outbound HTTP call in src | calls-per-user-action (N items × M endpoints × retries) vs upstream budget; test asserts an upper bound on transport `call_count` |
| F31 | client-timeout-claimed-as-upstream-protection | added `wait_for(`/`timeout=`/AbortController | what happens to the abandoned request server-side (paste upstream worker/timeout config); client cap alone is not a fix |

| F32 | mr-state-hygiene | remote readiness claim or MR-state diagnosis | fetch relevant current MR fields from the correct repo; compare reviewed refs. `mr-doctor.sh` offers merge-state diagnostics; draft/reviewer/pending-CI rows block only where the checkpoint requires them |

## Out-of-gate checkpoints (not evaluated at ready-for-review)

| id | class | when | check |
|----|-------|------|-------|
| F3 | fix-composition-hazard | before pushing a batch of MRs | `PREFLIGHT_BATCH=1` triage (or `glab mr list --author=@me`) to intersect changed files across open MRs; state and test each composed behavior |
| F26 | merge-without-required-approval | before merging | `glab api …/approvals`; every listed reviewer approved or waived in thread; component owner's row must be approved |
| F28 | inherited-diagnosis-unverified | before posting a root-cause claim externally | `rg` every named symbol (zero hits = fiction); reproduce boundary behavior against the real boundary, paste transcript |
| F29 | acceptance-item-unmet-at-closure | before `Closes <KEY>` or moving to Ready for Validation | fetch the newest acceptance list; table each item delivered (code + test) / not-delivered / withdrawn (quote) |
