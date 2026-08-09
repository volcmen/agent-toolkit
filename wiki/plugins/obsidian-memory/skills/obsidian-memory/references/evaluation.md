# Memory evaluation

Memory quality is behavioral: a stored item is useful only when the agent
recalls it at the right time, applies it correctly, and ignores it when it is
irrelevant or unsafe.

The canonical cases live in
`../../../evals/memory-evals.json`. They are framework-neutral specifications,
not a claim that a model passed.

## Evaluation protocol

1. Run capability evaluation separately from regression evaluation.
2. Start each case from the declared memory state and use a fresh agent
   session.
3. Run multiple trials for nondeterministic agents.
4. Grade the final outcome and inspect the tool/trajectory transcript.
5. Record model, agent version, prompt/skill version, retrieval strategy,
   date, latency, and token/tool cost.
6. Calibrate any model grader against a sample of human judgments.
7. Promote a memory-policy or skill change only when its target category
   improves and no safety-critical category regresses.

Useful aggregate views:

- task success by category;
- unsafe-memory acceptance rate;
- stale-memory use rate;
- retrieval recall at a fixed context budget;
- `pass@k` for "can succeed at least once";
- `pass^k` for "succeeds consistently";
- median context characters, tool calls, latency, and cost.
- median estimated startup tokens and recall-result tokens;
- notes opened per successful recall and stale results exposed to the model;
- success with memory disabled for tasks that do not need it.

Read failures before changing prompts. A correct answer with an unsafe or
unnecessarily long trajectory is not a clean pass.

## Scaling the suite

The suite covers recall, provider failure fallback, scoped isolation, conflict,
action grounding, security, selectivity, forgetting, and experiential learning.
Replace synthetic cases with anonymized real tasks as they arise. Preserve
failures that caused actual work disruption as permanent regression cases.

Do not store secrets or sensitive transcripts in fixtures.
