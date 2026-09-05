# Failure-modes index (gate-facing)

Compact, gate-facing. `preflight-triage.sh` decides which rows are TRIGGERED from the diff; the gate evidences only those. Origins, recurrence counts and attribution live in `failure-modes-history.md` (written by review-retro, never read by the gate). A row is MECH when the script settles it alone.

| id | class | trigger (script) | check the gate must evidence |
|----|-------|------------------|------------------------------|
| F1 | contract-change-unconsumed | removed src line with a `def`/`function`/`export` signature | `rg` every call site; table each as consumes / indifferent-with-proof. Fix visible only in tests = FAIL |
| F2 | empty-fallback-as-success | added `except`/`catch`/`??`/`\|\| {}` | per clause: literal returned, does the consumer render it as clean; caught type vs the one expected failure; if the literal feeds >1 consumer, table direction of error per consumer |
| F4 | blast-radius-unmeasured | any src change | count the affected population or name its bound; "unknown" on a blocking/visible change = FAIL |
| F5 | sibling-path-unswept | any src change | paste `rg` of the fixed pattern's structural shape; table every hit fixed / justified |
| F6 | boundary-uncoerced | added `sorted(`/`min(`/`max(`/`.sort(` | iterable may mix int/float/str from JSON/API? needs `key=str`/canonical key or FAIL |
| F7 | non-discriminating-test | new/changed test file | per changed test: does it assert the production result of the changed behaviour (not a mock of the subject)? Mutation red→green only through the RUNNER command (`OK`/`OVERRIDE`), up to 3 groups, one disposable worktree, never an environment bootstrap; groups not mutated = RUN-REQUIRED with the exact command (NOT READY until pasted) |
| F8 | partial-function-misuse | added `parseInt`/`Number(`/`JSON.parse`/`int(`/`float(` | justify prefix-parse (`"12abc"`), undefined/NaN, `"1e5"` per call |
| F9 | scope-rider | any src change | hunk not required by the ticket → split or name it in the description |
| F10 | remediation-path-removed | added `disabled`/`readOnly`/`locked`, removed button/link | grep every flow routing users TO the affordance; each keeps a surviving path |
| F11 | hand-copied-mirror | added function in src | `rg <distinctive literal>` repo-wide excluding the diff; hit in shared module → delegate or link extraction ticket. No pasted rg = FAIL |
| F12 | workaround-divergence | dependency/lock file or Node flag/shim added | canonical mechanism exists in another branch/MR? use it |
| F13 | recovery-branch-assumption | added status-code / message string match | provenance for the trigger: doc cite, dependency source, or live probe pasted |
| F14 | untraced-runbook | `.md`/`.sh`/Jenkinsfile/groovy changed | trace the command with the real producer of its inputs; name what it creates/mutates/destroys |
| F15 | validator-intent-mismatch | added `.strip()`/`.trim()`/`.lower()`/`validate*`/`normalize*` | computed-but-discarded results; enumerate inputs violating the guard's stated purpose (`*`, empty, whitespace, comma-list) and show each handled in a test |
| F16 | description-claim-drift | any src change | per behavioral claim in the STANDING description + commit bodies: code line AND test. Reverse: fixed behavior not claimed = FAIL. Re-run on every push after ready |
| F17 | slop-comment-in-source | MECH | ticket keys or added comments/docstrings in source = FAIL (script pastes each line) |
| F18 | test-harness-convention-mismatch | new test file | table 2 sibling files: base class, assert style, fixtures, runner; any divergence without a named repo reason = FAIL. Siblings are the rule, never a repo-wide claim |
| F19 | example-only-test-for-contract-function | new test without hypothesis/fast-check; pinned seed is MECH FAIL | target is a pure/contract function? name the property class (round-trip/invariant/idempotence/oracle/metamorphic) or why none applies |
| F20 | capability-duplicates-existing-validator | new file under validators/checks/audit or added `check_`/`validate_` | `rg` the checked key across existing validators; table redundant / distinct in the MR description plus the tool's negative space |
| F21 | session-link-leak | MECH | session URL / `Co-Authored-By: Claude` / `Generated with Claude` in commit bodies or MR description = FAIL |
| F22 | test-unwired-from-runner | new test file with no CI/runner-config reference | name the CI job + discovery glob (paste line), or paste an OPEN ticket/MR URL that wires it; prose disclosure = FAIL |
| F23 | paginated-response-first-page-only | added API list read | endpoint paginates? loop follows `next` or passes a server-honoured filter (read the ViewSet) |
| F24 | dead-code-left-by-fix | any src change | run ruff `F401,F841` / `tsc --noUnusedLocals` on touched files; delete or justify each leftover |
| F25 | feedback-surface-occluded | added toast/snackbar/Alert/notify | rejection renders above its trigger (z-order, unmount); test asserts `toBeVisible` |
| F27 | live-drift-without-tracking-artifact | description mentions kubectl/set env/out-of-band/hotfix | each drift item has an OPEN MR or ticket URL pasted; closed MR is not an artifact |
| F30 | remote-call-volume-invisible-in-tests | added outbound HTTP call in src | calls-per-user-action (N items × M endpoints × retries) vs upstream budget; test asserts an upper bound on transport `call_count` |
| F31 | client-timeout-claimed-as-upstream-protection | added `wait_for(`/`timeout=`/AbortController | what happens to the abandoned request server-side (paste upstream worker/timeout config); client cap alone is not a fix |

| F32 | mr-state-hygiene | MECH | `mr-doctor.sh` settles 11 MR-metadata invariants (stale diff refs after a retarget, phantom `changes_count`, head behind branch tip, merge conflict, missing/red pipeline on head, session-link leak, draft, unresolved threads, missing ticket key, no reviewer). Paste its rows. Never expand them here — mechanical rules live in the script, not in this table |

## Out-of-gate checkpoints (not evaluated at ready-for-review)

| id | class | when | check |
|----|-------|------|-------|
| F3 | fix-composition-hazard | before pushing a batch of MRs | `PREFLIGHT_BATCH=1` triage (or `glab mr list --author=@me`) to intersect changed files across open MRs; state and test each composed behavior |
| F26 | merge-without-required-approval | before merging | `glab api …/approvals`; every listed reviewer approved or waived in thread; component owner's row must be approved |
| F28 | inherited-diagnosis-unverified | before posting a root-cause claim externally | `rg` every named symbol (zero hits = fiction); reproduce boundary behavior against the real boundary, paste transcript |
| F29 | acceptance-item-unmet-at-closure | before `Closes <KEY>` or moving to Ready for Validation | fetch the newest acceptance list; table each item delivered (code + test) / not-delivered / withdrawn (quote) |
