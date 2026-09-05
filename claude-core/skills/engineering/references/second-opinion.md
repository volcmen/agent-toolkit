# Second opinion

Three independent models are available. Each costs real money and minutes;
none is an unrequested gate on routine work. The user's request for one is the
consent for that run; a run you thought of needs the user's yes first.

| Need | Tool | Notes |
|---|---|---|
| Grounded judgment on a decision you already hold a position on | `codex-pair` `ask` | state your position and invite disagreement; agreement proves little |
| Product or technical direction before implementation | `codex-pair` `shape` | background run |
| Red-team a plan you wrote | `codex-pair` `plan` | background run; verdict loop |
| Codex scopes a slice, you build it, Codex reviews against its own spec | `codex-pair` `lead` | the default when the branch is attached; one slice per loop, two correction rounds at most |
| Adversarial review of your diff before pushing | `codex-pair` `review` | background run; verify each finding at its `file:line` before acting |
| Codex should author code or run a long investigation itself | `/codex:rescue` | the only mode where Codex writes |
| The user names ChatGPT or a ChatGPT Project | `chatgpt-consult` | the answer must come from ChatGPT, never paraphrased from your own reasoning |

## Attachment

`inspect.sh status` on the repository tells you `attached`, `declined`, or
`unasked`. Attached means persistent consent for the lead loop on that branch;
declined means never offer again there; unasked means offer once and record the
answer. A single requested run never attaches by itself.

## Verdicts

`APPROVED` — done. `REQUEST_CHANGES` — verify each finding yourself, fix the
legitimate ones, push back on the wrong ones in the same thread, re-review; stop
after two rounds and surface what is still open. `NEEDS_REWORK` — stop and
bring it to the user before any mass edit. Surface a second model's answer
verbatim when it disagrees with you; disagreement is the signal.

## Not worth a run

Trivial lookups; anything settled by reading the code; questions that need the
user's own preference; a small routine diff; `lead` on a one-file change —
downgrade to `ask` or just do the work.
