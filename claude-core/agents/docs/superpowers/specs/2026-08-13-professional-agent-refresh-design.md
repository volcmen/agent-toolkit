# Professional Agent Refresh Design

**Date:** 2026-08-13

**Status:** Approved direction

**Scope:** Claude Code controller, Alan Wake, task analyst, and repository explorer

## Goal

Make the shared Claude agents concise, reliable, and professional. Preserve
useful safeguards without turning prompts into policy manuals.

## Research basis

Current official guidance favors focused agents, clear routing descriptions,
least-privilege tools, concise structured instructions, concrete examples, and
checks the agent can verify. Technical writing guidance favors active voice,
one idea per sentence, parallel lists, and direct wording.

The design uses current documented behavior as of 2026-08-13. It does not claim
future 2027 behavior.

## Approaches considered

### 1. Focused prompt refresh — selected

Keep the current catalog, renderer, installer, and four roles. Rewrite each
canonical prompt around its single job. Preserve only rules that change the
result or protect accuracy, safety, or authorization.

This keeps deployment simple and removes prompt overlap without introducing a
new runtime layer.

### 2. Move Alan Wake guidance into a skill

Keep a small agent and preload a separate writing skill. This could make the
editorial reference reusable, but it adds another source of truth and more
loading behavior. The current agent is already the correct isolation boundary.

### 3. Patch the current prompts in place

Keep the current structure and remove selected sentences. This carries less
change, but Alan Wake would still mix editorial policy, research procedure,
link construction, destination syntax, and artifact templates across more than
400 lines. The overlap would remain difficult to maintain.

## Agent design

### Controller

The controller remains the Fable main-thread technical lead. Its prompt will
cover five concerns:

- shape the outcome from evidence;
- choose direct work or a focused specialist;
- route final workplace prose to Alan Wake;
- implement safely and proportionally;
- verify before reporting completion.

The prompt will keep model routing and the peer-session trust boundary, but
remove repeated process language. Delegation stays optional except for the
explicit Alan Wake prose route.

### Alan Wake

Alan Wake remains the final-draft writing specialist and uses Claude Opus with
medium effort. Opus is appropriate because fidelity, implication, tone, and
compression require judgment. Medium effort keeps routine drafts responsive;
the task packet supplies the facts.

Alan Wake will:

- return one ready-to-use artifact without a preamble;
- preserve facts, meaning, identifiers, links, and uncertainty;
- lead with the outcome, request, decision, or current state;
- use short, active sentences and plain technical language;
- follow the destination's template and markup;
- inspect only the context needed for accuracy;
- use bounded read-only lookup for missing material facts or current syntax;
- omit nonessential gaps and mark only gaps that prevent a correct draft;
- never publish or mutate an external system.

The current official Slack, Notion, Confluence, and GitLab references remain
available in the standalone prompt. Their rules will be compact baselines, not
long destination manuals. Connector schemas take precedence when they
explicitly define a payload format.

Links should be useful and verified. Known URLs should use clear labels. Alan
Wake may construct a canonical URL only from established host, project, ref,
and identifier facts. A missing URL does not make an otherwise correct short
draft unusable.

Artifact guidance will state what readers need from Slack updates, issues,
PRs/MRs, review comments, docs, status updates, and release notes. It will not
force sections, fixed line counts, or templates when the content does not need
them.

### Task analyst

The task analyst remains a read-only Sonnet specialist for unclear or risky
requests. It separates stated intent, observed evidence, inference, scope,
acceptance criteria, and one decision when needed. It does not draft final
workplace prose or propose a fix before evidence supports one.

### Repository explorer

The repository explorer remains a read-only Sonnet specialist. It answers one
bounded repository question at the requested depth, cites precise paths and
symbols, separates evidence from inference, and returns only findings relevant
to the question.

## Source and deployment

`agents.json` and `prompts/*.md` remain canonical. `scripts/render.py`
regenerates Claude Markdown and Codex TOML. `scripts/manage.py install` updates
the live files under `~/.claude/agents/`. Generated and installed files are
never edited by hand.

Existing uncommitted work is part of the input to this refresh. The Opus Alan
Wake change, read-only lookup tools, and controller routing will be preserved
and refined. Unrelated files remain untouched.

## Verification

Tests will verify behavior and provider contracts rather than prose length or
exact paragraph wording:

- expected Claude models and effort levels;
- focused descriptions and read-only specialist tools;
- explicit Alan Wake routing on Opus;
- no invented facts, unsupported completion claims, or external publishing;
- bounded lookup and official destination references;
- concise, artifact-only output;
- task-analyst and explorer output contracts;
- deterministic rendered files and a matching live installation.

Prompt size will be reviewed as a maintainability signal, not enforced as a
hard limit. The final review will also check duplicated rules, contradictions,
unsupported future claims, YAML/TOML validity, renderer drift, and the full
repository diff.

## Acceptance criteria

- All four agents have clear, non-overlapping roles.
- Alan Wake uses Opus with medium effort and stays read-only.
- Alan Wake is materially shorter while preserving accuracy, destination
  formatting, bounded research, missing-fact handling, and output guarantees.
- Guidance favors professional judgment over arbitrary word, line, section, or
  formatting limits.
- Canonical, generated, and live Claude files match.
- Focused tests, the full project suite, package checks, and diff checks pass.
