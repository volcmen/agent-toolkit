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

| F32 | mr-state-hygiene | MECH | `mr-doctor.sh` settles 12 MR-metadata invariants (stale diff refs after a retarget, phantom `changes_count`, head behind branch tip, merge conflict, missing/red pipeline on head, session-link leak, draft, unresolved threads, missing ticket key, no reviewer, an unresolvable GitLab link in the description). Paste its rows. Never expand them here — mechanical rules live in the script, not in this table |

| F38 | verification-claimed-not-observed | MECH | `python3 ~/.claude/scripts/verify-run.py --gate HEAD` for the branch tip. Only PASS counts. MISSING = nothing ran against this tree; VACUOUS = a green command that counted no test (a typecheck, a zero-collection run, `echo`); FAIL = the scope's last authorized attempt failed; FLAKY = it passed only after failing, which is a finding not a pass; STALE = the lockfiles moved since the passing run; CHAIN BROKEN = the ledger was edited outside the wrapper. Paste the line. The verdict table names the scope that ran and every scope that did not; reused evidence is reported as reused, never as "ran this turn". The ledger is written by this user, so it is evidence against careless reasoning, not proof |

## Out-of-gate checkpoints (not evaluated at ready-for-review)

| id | class | when | check |
|----|-------|------|-------|
| F3 | fix-composition-hazard | before pushing a batch of MRs | `PREFLIGHT_BATCH=1` triage (or `glab mr list --author=@me`) to intersect changed files across open MRs; state and test each composed behavior |
| F26 | merge-without-required-approval | before merging | `glab api …/approvals`; every listed reviewer approved or waived in thread; component owner's row must be approved |
| F28 | inherited-diagnosis-unverified | before posting a root-cause claim externally | `rg` every named symbol (zero hits = fiction); reproduce boundary behavior against the real boundary, paste transcript |
| F29 | acceptance-item-unmet-at-closure | before `Closes <KEY>` or moving to Ready for Validation | fetch the newest acceptance list; table each item delivered (code + test) / not-delivered / withdrawn (quote) |
| F33 | third-party-artifact-write | any write to a ticket/issue/MR/thread/branch not mine | HARD BLOCK, not a checklist: not mine = read-only (`~/.claude/skills/engineering/references/corporate-systems.md`). Mine = the user created it, is its assignee, or named it in this conversation. Finding a real defect in it is not authorization. Resolved/closed = never written to. When a write IS authorized: fetch current value, append a block delimited so it cannot be absorbed by adjacent structure (blank line + heading, never a leading `*`/`-`/`#`/`|`), save the pre-edit field verbatim |
| F34 | assignee-invented | before any write that sets an assignee | the user named this person for this ticket in their own words; an MR author, `merged_by`, repo maintainer or team-to-person mapping is NOT authorization. Report the candidate owner in chat and leave the field empty |
| F36 | outbound-link-unresolved | before any message, description or comment leaves this machine | every URL pasted from the owning tool's link field (`web_url`/`html_url`/`webUrl`/`message_link`) — name the call it came from; a URL built from an id plus a remembered project path is invented and an anonymous fetch cannot disprove it (403 either way) |
| F35 | notification-wave-unbudgeted | before a bulk tracker mutation (>3 items) | count the distinct people each write notifies; batch every intended change per item into ONE edit, decide the endgame before the first write, and tell affected people before firing rather than after |
| F37 | foreign-history-rewrite | MECH | any push, rebase, amend, cherry-pick, squash, retarget or force-push touching a branch that is not certainly mine — including a plain commit of mine on their MR source branch, a Web IDE / commits-API commit, and Apply suggestion | HARD BLOCK. Rebase and cherry-pick keep the author and set the committer from local `user.email`, so replaying a colleague's commits records me as committer; GitLab then treats me as having added commits and refuses my approval on every MR that inherits one (`canApprove: false`, `POST /approve` → 401), repairable only by the owner re-running the rebase or a Maintainer changing project policy. Verify over the branch's own range, by email: `git log --format='%ae|%ce' $(git merge-base origin/HEAD HEAD)..HEAD | sort -u`. Before declaring an MR ready, also check the separation of duties: no reviewer of the MR appears as a committer in `…/merge_requests/<iid>/commits`. Guards: `~/.config/git-guards/pre-push-foreign-history` (accident guard, fail-closed; `install --audit` reports coverage) and the `guard-red-write.py` PreToolUse hook — neither is an authorization boundary, the RED WRITE rule is |
