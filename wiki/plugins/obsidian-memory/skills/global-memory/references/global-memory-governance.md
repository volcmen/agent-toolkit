# Global Memory Governance

Global memory is the smallest durable layer that remains useful across unrelated
projects. Markdown plus Git is the sole writable authority; the configured global
root is a logical namespace, not a second database, controller, or automatic-learning
system.

## Contents

- [Workflow](#workflow)
- [Evidence and authority hierarchy](#evidence-and-authority-hierarchy)
- [Promotion test](#promotion-test)
- [Project boundary and resolution](#project-boundary-and-resolution)
- [Atomic record schema](#atomic-record-schema)
- [Sensitivity handling](#sensitivity-handling)
- [Operations and apply gate](#operations-and-apply-gate)
- [Validation](#validation)
- [Common mistakes](#common-mistakes)
- [Final report contract](#final-report-contract)

## Workflow

1. Read `~/.config/obsidian-memory/config.json` and resolve its configured vault.
   If `global_memory_root` is absent, use the verified runtime default `wiki/global`.
   If `recall_roots` is absent, use the verified runtime defaults `wiki`, `projects`,
   and `daily`. Refuse an absent, unsafe, symlinked, or out-of-recall-root destination.
2. Select `READ_ONLY` for an audit or review. Use `APPLY_SAFE` only when the user's
   request authorizes the named mutation; it never relaxes the evidence gate.
3. Run the read-only audit, retrieve only the relevant global category, and inspect
   the actual records plus their precise sources before deciding anything.
4. Inventory each candidate with its stable record ID, current statement/status,
   source locator, scope, sensitivity, conflict state, and intended destination.
5. Classify evidence, apply the promotion test, resolve conflicts, then select one
   operation from the fixed vocabulary. Correct subject matter is not evidence.
6. In `APPLY_SAFE`, apply only eligible operations. Preserve uncertain or
   assistant-originated material as a candidate/proposal or `NEEDS_REVIEW`.
7. Validate deterministic structure with audit and validate retrieval through the
   native provider. Review the exact reversible patch.
8. Return the nine-section report exactly; use `None` for empty sections.

## Evidence and authority hierarchy

For curation evidence, use this descending order:

1. latest user correction;
2. approved global record;
3. repeated user statement;
4. single user statement;
5. environment evidence;
6. assistant recommendation;
7. inference.

Classify every input with one or more of these labels:

- `USER_STATED`: a direct user statement; use `repeated_user_pattern` only when
  multiple attributable statements establish the repetition.
- `USER_CONFIRMED`: the user explicitly accepted the exact proposition.
- `ASSISTANT_RECOMMENDED`: agent-authored advice or architecture, including a
  generated summary of another source.
- `PROJECT_SPECIFIC`: architecture, decisions, state, or authority owned by one
  project.
- `TEMPORARY`: session state or volatile implementation evidence.
- `INFERRED`: a conclusion the user or an independent source did not state.
- `SENSITIVE`: content needing private or restricted handling.
- `STALE_OR_CONFLICTED`: expired, superseded, contradicted, or unresolved content.

The linked-chat message IDs `b66c4b7a-5650-40ff-992a-8ea33a56f553` and
`67d1ff8a-5d80-469d-943a-e0b4a17354a5` are examples of source locators for
assistant recommendations. They are not global facts, transcripts to store, or
approval of the architectures they describe. A retrieval result, summary, or
trusted-tool echo cannot promote its own authority. Environment evidence can
verify an environment fact, not a personal preference or approval rule.

## Promotion test

A candidate is globally promotable only when every answer is yes:

1. Would it still be useful in a different project after six months?
2. Does retaining it prevent repeated friction or unsafe work?
3. Is it actually global rather than project-specific or session recovery state?
4. Is the exact atomic proposition sourced with attributable current evidence?
5. Is it minimally sensitive, with no less-exposing locator or project scope?

One failed or unknown answer means `MOVE_TO_PROJECT`, `KEEP_UNCHANGED`, or
`NEEDS_REVIEW`, not global promotion. A stable-sounding communication preference
or approval rule still needs user-stated, user-confirmed, or other appropriate
evidence. Repetition inside project files never proves a global user preference.

## Project boundary and resolution

Global memory may hold a compact project-registry identity and locator. Keep the
project's current architecture, branches, commits, bugs, test output, versions,
cache/install state, commands, handoffs, recovery state, current media variants,
and active task details project-local or session-local. A registry pointer must
not duplicate current architecture or status history.

### Resolution order

Apply this order, from strongest to weakest:

```text
system and safety policy
  > latest explicit user instruction
  > explicit project-local authority and policy
  > approved global defaults
  > project-derived context
  > agent inference
```

A project override affects only that project and does not rewrite the global
default automatically. A stored global default never outranks the user's latest
explicit instruction. Host policy remains above both.

## Atomic record schema

Use one flat frontmatter record for one bounded proposition. `statement` is the
durable proposition and is limited to 600 characters. Do not replace this with
nested governance envelopes, event/controller schemas, evidence grades, or IDs
such as `global-index` or `durable-technical-context`.

```yaml
---
id: global.<category>.<stable-name>
type: entity
memory_class: fact
scope: global
owner: david
category: <recognized-category>
statement: "<one atomic proposition>"
status: <recognized-status>
evidence_type: <recognized-evidence-type>
source:
  - "<precise attributable source reference>"
confidence: <recognized-confidence>
stability: <recognized-stability>
sensitivity: <recognized-sensitivity>
observed: YYYY-MM-DD
valid_from:
valid_until:
supersedes:
superseded_by:
retrieval_tags:
  - <tag>
verified_by: "<verification evidence when required>"
---
```

Recognized runtime values are exactly:

| Field | Values |
| --- | --- |
| `memory_class` | `fact`, `decision`, `heuristic` |
| `category` | `identity`, `communication`, `operating_principle`, `approval_policy`, `technical_environment`, `recurring_goal`, `project_registry`, `privacy`, `preference`, `constraint` |
| `status` | `candidate`, `proposed`, `verified`, `accepted`, `active`, `superseded`, `deprecated`, `rejected` |
| `evidence_type` | `user_stated`, `user_confirmed`, `repeated_user_pattern`, `environment_verified`, `assistant_recommended`, `inferred` |
| `confidence` | `low`, `medium`, `high` |
| `stability` | `durable`, `review_periodically`, `time_sensitive` |
| `sensitivity` | `public`, `internal`, `private`, `restricted` |

The ID category must match `category`; `<stable-name>` is 1–80 lowercase ASCII
letters, digits, underscores, or hyphens and starts with a letter or digit.
`scope` is `global`, `owner` is `david`, `source` has at least one non-empty
reference, and `observed` is an exact ISO date. A `time_sensitive` record needs
`valid_until`. Current records retain the existing `verified_by` requirements.
`assistant_recommended` and `inferred` may use only `candidate` or `proposed`;
they are never `verified`, `accepted`, or `active` without new evidence and the
corresponding evidence-type correction.

Global-record supersession is namespace-preserving. Every successor after a
chain enters the configured global `records/**` tree must remain in that tree;
cross-namespace successors fail closed and audit as a fixed, value-free error.

## Sensitivity handling

No secrets, credentials, private keys, raw correspondence, hidden reasoning,
volatile prices, laws, or package rankings, or broad biography belong in global
memory. Prefer authoritative locators for changing facts. Dating, employment,
health, finance, and comparable personal detail stays omitted or narrowly
compartmentalized; do not infer traits from it.

`public` and `internal` records may use ordinary bounded recall. `private` and
`restricted` records are excluded by default. Recall them only after an explicit
request with `--include-sensitive` and an explicit narrow scope below the relevant
domain. They are never injected at startup, and startup contains only a route,
not global record bodies or hints that sensitive material exists.

## Operations and apply gate

Use only this operation vocabulary:

| Operation | Use |
| --- | --- |
| `ADD` | Create one new atomic, evidenced record. |
| `UPDATE` | Correct metadata or wording without hiding material history. |
| `SPLIT` | Replace a compound statement with separately sourced atomic records. |
| `MERGE` | Consolidate true duplicates while preserving provenance and redirects. |
| `SUPERSEDE` | Preserve an old record and point it to the current correction. |
| `EXPIRE` | Mark temporally invalid content non-current with its validity evidence. |
| `DELETE_SENSITIVE` | Propose or perform explicitly authorized removal of disallowed sensitive content while preserving the permitted audit trail. |
| `MOVE_TO_PROJECT` | Put project-owned material under its project, leaving at most a compact registry locator globally. |
| `KEEP_UNCHANGED` | Retain a valid record exactly as inspected. |
| `NEEDS_REVIEW` | Make no mutation when evidence, authority, conflict, or sensitivity remains unresolved. |

`APPLY_SAFE` may apply only an explicit, non-sensitive, non-conflicting, atomic,
and sourced global fact that passes every promotion test. Changes must be minimal
and reversible. It must not apply assistant recommendations or inference, invent
missing approval, globalize project/session state, resolve an uncertain conflict,
or delete sensitive material without explicit deletion authority. Prefer
`SUPERSEDE` to silent historical overwrite. Record stable IDs, exact old/new
values, precise source references, and patch text for every applied operation.

Example: a repository README and installed-state checks may support an
`environment_verified` `global.project_registry.agent_toolkit` locator. They do
not support a global copy of that repository's current architecture, branch, test
results, or session handoff.

## Validation

After inspection and again after any mutation, run from the plugin installation:

```bash
python3 "<plugin-root>/scripts/obsidian_memory.py" audit --json
python3 "<plugin-root>/scripts/obsidian_memory.py" recall \
  "<stable record id and distinguishing terms>" \
  --provider native --mode fast \
  --scope "<global_memory_root>/records/<category>"
```

For an explicitly authorized sensitive check, add `--include-sensitive` only
with that narrow category or record scope. Native recall is the immediate
retrieval validation; QMD maintenance remains a separate explicit operation.
Inspect the changed Markdown/frontmatter and Git diff. Report command, exit code,
relevant finding codes and paths, returned record paths, and any unrelated
pre-existing errors separately. An audit exit 1 does not prove this patch failed
if all affected global records pass and only documented unrelated findings remain;
it does require `partial`, not an unqualified success claim.

## Common mistakes

| Mistake | Correct response |
| --- | --- |
| Adopting a useful assistant architecture | Keep it `ASSISTANT_RECOMMENDED` and candidate/proposed pending independent acceptance. |
| Globalizing architecture or recovery state | Use `MOVE_TO_PROJECT`; retain only a compact registry locator globally. |
| Designing a nicer schema | Use the exact flat runtime contract and vocabulary above. |
| Promoting a plausible preference or rule | Apply the evidence gate; subject matter alone proves nothing. |
| Letting a stored default beat a correction | Follow the resolution order; the latest explicit user instruction wins below host policy. |
| Returning a free-form summary | Use all nine exact sections with traceable operations and validation. |

## Final report contract

Return these headings, spelling, and order exactly. Do not add or remove a
section. Each entry under section 2 uses `OPERATION / RECORD ID / OLD VALUE / NEW
VALUE / SOURCE / REASON`; write `None` when no change was applied. Proposals in
section 3 use the same fields and explain the missing gate. Section 8 contains
the exact reversible patch or `None`. Section 9 is last and ends with the YAML
block shown below.

## 1. Global-memory health

Summarize record counts, scope/sensitivity posture, audit state, and material
quality issues without reproducing sensitive bodies.

## 2. Applied changes

`OPERATION / RECORD ID / OLD VALUE / NEW VALUE / SOURCE / REASON`, or `None`.

## 3. Proposed changes requiring review

List `NEEDS_REVIEW` or other unapplied operations with the exact missing evidence
or authority.

## 4. Kept project-local

List project/session items and their owning destination or locator.

## 5. Rejected candidates

List assistant-originated, inferred, overly broad, volatile, or unsupported
global candidates and the failed promotion test.

## 6. Conflicts and stale records

List stable IDs, competing sources, resolution status, and any supersession or
expiry operation; never silently choose.

## 7. Validation evidence

Give exact commands, exit codes, affected finding/path results, targeted recall
paths, and separately identified pre-existing issues.

## 8. Final global-memory patch

Provide the exact reversible Markdown/frontmatter patch, or `None`.

## 9. Compact outcome

End the response with this YAML block and no prose after it:

```yaml
outcome:
  mode: READ_ONLY | APPLY_SAFE
  global_records_added: 0
  global_records_updated: 0
  global_records_superseded: 0
  records_moved_to_project_scope: 0
  sensitive_records_removed_or_restricted: 0
  unresolved_conflicts: 0
  validation: passed | partial | failed
  memory_quality:
    before: "<compact assessment>"
    after: "<compact assessment>"
```
