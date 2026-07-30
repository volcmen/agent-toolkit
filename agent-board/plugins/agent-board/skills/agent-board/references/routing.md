# Routing — work type to role (soul)

Roles live in `board/roles/<name>/SOUL.md`. The `description:` field is what the
triage model matches a card against, so it is written as "owns X / not for Y".
Edit a soul to change how that worker behaves — it is the system prompt.

| Role | Owns | Do not send | Runtime | Access |
|---|---|---|---|---|
| `orchestrator` | Scope clarification, decomposition into dependency graphs, role selection | Implementation, research, docs, review | codex | writes |
| `backend` | APIs, services, databases, auth, integrations, concurrency, performance, backend tests | UI-only, infra-only, review verdicts | codex | writes |
| `frontend` | React/Vue/Svelte, TypeScript, CSS, state, a11y, responsive, frontend tests | Backend services, infrastructure | codex | writes |
| `devops` | CI/CD, containers, Kubernetes, Terraform, deploys, observability, operational automation | Product features unless infra-facing | codex | writes |
| `data` | SQL, cleaning, statistics, notebooks, visualization, experiments, model evaluation, pipelines | Ordinary app features | codex | writes |
| `qa` | Defect reproduction, test strategy, unit/integration/E2E tests, flaky diagnosis, acceptance validation | Final code-review verdicts | codex | writes |
| `reviewer` | Independent review of a diff/PR/MR; severity-ranked findings; explicit verdict | Writing the code it reviews | claude | **read-only** |
| `researcher` | Source-grounded research, option comparison, freshness checks, citations, decision-ready synthesis | Implementation, product docs | claude | **read-only** |
| `designer` | Requirements framing, user flows, IA, interaction + a11y specs, design critique | Production UI code | claude | **read-only** |
| `docs` | READMEs, architecture guides, API references, runbooks, migration + release notes | Implementation logic | codex | writes |
| `generalist` | Deliberate fallback for well-scoped mixed-domain or operational work | Anything a specialist fits | codex | writes |

## Precedence when two roles fit

1. **Independence beats convenience.** Verdicts go to a role that did not produce
   the artifact — `reviewer` for review, `qa` for executable proof.
2. **Producer over consumer.** Whoever owns the surface being changed owns the
   card: an API contract change is `backend` even if the UI consumes it.
3. **Split instead of stretching.** Cross-domain work becomes two cards joined by
   `--parent`, not one card on `generalist`.
4. **Evidence first.** If the card cannot start without facts, a `researcher` card
   is its parent.
5. **Spec before pixels.** Ambiguous product shape → `designer` card producing a
   spec, then a `frontend` card implementing it.
6. **Docs trail.** A `docs` card depends on the implementation card.
7. `generalist` requires a stated reason; `orchestrator` only decomposes.

## When the triage model is wrong

It reports `confidence` and a `rationale`; both print in `ab triage` output. Common
failure shapes and the fix:

| Symptom | Fix |
|---|---|
| Everything routed to `generalist` | The roles' `description:` fields are too vague — sharpen them, they are the routing signal |
| A review card routed to the implementer | `ab set <id> --role reviewer` — rule 1 always wins |
| One card that should be three | Set it back to `triage` and re-run `ab triage` after adding the missing hints to the body |
| Three cards that should be one | Merge the bodies by hand, then `ab archive <extra-ids>` |
| A long dependency chain | Chains over 3 are almost always wrong; drop edges that are not real data dependencies |
| Confidence below 0.6 | The card is parked, not routed: triage left its proposal on the card and created nothing. Add constraints to the body, then `ab set <id> --action send_to_triage`. Do not escalate the model, and do not force it to `ready` |
| A review/audit card routed to an implementer | The read-only sandbox is now gone — that is the real damage. `ab set <id> --role reviewer` (it drops the stale session too), then fix `reviewer`'s `description:` and re-grade with `bun run eval:routing` |
| A "which tool should we use" card routed to the domain specialist | Same shape: `researcher` owns unmade decisions. Reassign, sharpen the description, re-grade |
| A role never gets picked at all | It may not be loaded — `ab roles` prints the validation failure, and a rejected role is missing from the triage roster entirely |

## Read-only roles are a boundary, not a hint

`reviewer`, `researcher`, and `designer` run with a read-only sandbox (codex
`-s read-only`) or a read-only tool allowlist (claude). A card cannot grant them
write access, and the worker prompt states the boundary explicitly. If a review
card needs a fix applied, that is a second card on an implementing role.
