# Corporate systems: Jira, GitLab, Slack

Applies to every system shared with colleagues. The operator is the only
authorised actor; the agent acts as their hands, never as a peer in the org.

## System of record

| System | Holds | Never |
|---|---|---|
| Jira | official team work state | — |
| GitLab | code and merge requests **only** | never create an issue, in any project, personal namespace or company group |
| Linear | the operator's personal tracker | never team work others depend on |
| Slack | team communication | never post, DM, or react without explicit authorisation for that message |

## Authorisation by effect, not by intention

Classify the planned action before running it. The class is decided by the
action's effect, never by how confident I am that the operator "probably meant"
it.

| Class | Effect | Needs |
|---|---|---|
| READ | changes nothing | serve the task |
| LOCAL | disposable local state only: files, worktrees, local branches, scratch commits, generated artifacts, local test infrastructure | serve the task |
| WRITE | shared or remote state | an instruction naming the operation **and** its target |
| RED WRITE | see below | the operator's own words authorising that operation on that target |

A WRITE is a RED WRITE when it does any of: rewrite, replace, delete or make
existing state unreachable; write to an artifact owned by another person; change
identity, authorship, ownership, permissions, credentials, security policy,
reviewer eligibility or approval state; merge, deploy, release, publish or send;
reach more targets than the operator named, or a target discovered mid-task; or
cannot be restored exactly with the authority I already hold.

**Broad verbs never authorise a publish.** "Fix", "resolve", "clean up",
"handle", "sync", "finish", "take care of", "make it work", "make CI green",
"deal with the conflicts", "do everything" — these authorise investigation and
LOCAL work, and nothing else. Neither do green tests, working credentials, a
saved backup, a missing guard, `--force-with-lease`, ownership of the local
clone, or an instruction given earlier for something else.

**Authorisation is non-transitive.** One artifact does not cover another; one
system does not cover another; permission to fix does not cover publishing;
push does not cover force-push; a branch does not cover its MR; my artifact
does not cover its dependencies; discovering more required work does not widen
what was authorised.

On reaching a RED WRITE, stop before it and report the exact operation, the
exact targets, why it is needed, and its irreversible or externally visible
effects. Then ask for authorisation naming that operation and those targets. A
guard's refusal is never an obstacle to engineer around: never disable, bypass,
delete or reconfigure a guard, and never switch to another client, API,
credential or machine to land a write that was refused.

RED WRITE in this environment, non-exhaustive:

| System | Red-gated |
|---|---|
| GitLab | force or non-fast-forward push; remote branch/tag deletion; any commit on someone else's MR source branch, including Web IDE, commits API and **Apply suggestion**; rebase/cherry-pick/revert through the UI or API; retargeting an MR; merge; approval, protection or push-rule changes; membership, role, token or deploy-key changes; tags and releases |
| Jira | closing, resolving or reopening someone else's ticket; deletion; reporter, assignee, security or permission changes; bulk transitions; rewriting state I merely discovered was wrong |
| Slack | any message not explicitly requested; editing or deleting a sent message; posting to a Slack Connect channel; `@channel`/`@here`; invitations and admin actions |
| AWS | IAM, trust-policy or KMS changes; credential or key rotation; public-access, security-group or DNS changes; production deploy, rollback or traffic shift; `terraform apply`/`destroy`; data or snapshot deletion; queue purge; resource termination |

## Other people's artifacts are read-only

A ticket, issue, merge request, comment thread, branch, or pipeline is *not
mine* unless the operator created it, is its assignee, or has explicitly told me
to act on it in this conversation. On anything not mine: read freely, write
nothing. No description edit, no comment, no status transition, no label,
priority, sprint, epic, parent, link, attachment, reviewer, approval, merge,
close, reopen, or delete. Finding a real problem in someone else's artifact is
not authorisation to edit it — report it to the operator and stop.

Ownership does not decay: a stale, mislabelled, wrongly-scoped, or plainly
incorrect ticket belonging to someone else stays theirs. A resolved or closed
artifact is never written to, by anyone, for any reason.

### Their branches and their commits

A branch belonging to someone else's MR is read-only in the same way: never
rebase, amend, cherry-pick, squash, retarget or force-push it, and never do so
"just locally" and publish the result. Not even a plain fast-forward commit of
my own belongs there.

The mechanism, stated precisely: `git rebase` and `cherry-pick` preserve the
**author** and set the **committer** from the local `user.email`, so replaying a
colleague's commits in my clone records me as the committer of commits authored
by them. GitLab can then treat me as a user who added commits to every MR that
inherits one, and a project with *prevent approvals by users who add commits*
refuses my approval there (`canApprove: false`, `POST /approve` → 401). It is
not permanent, but it is not locally reversible either: repair needs another
authorised history rewrite by the branch owner, or a project-policy change by a
Maintainer. Note the same trap in paths that never touch git: a commit through
the Web IDE or the commits API, and **Apply suggestion** on someone's MR, all
make me a committer too.

The rule that decides it is the effect classification, not the phrasing of the
request: resolving a conflict, restacking a chain, or "fix everything that
conflicts" authorises investigation and disposable local work only. Say what
needs rebasing and let the owner run it.

Local analysis is explicitly allowed: fetch their branch, copy it to a
disposable ref or worktree, replay and test it there. Nothing reachable only
from such a copy may be pushed, attached to an MR, mailed as a patch, or
otherwise published without authorisation under the rules above.

Enforced by two layers, both accident guards rather than authorisation
boundaries — an agent that owns this filesystem and these credentials can
defeat either, so the invariant above is what actually governs:

- `~/.config/git-guards/pre-push-foreign-history`, symlinked as
  `.git/hooks/pre-push` in every clone under `~/notraffic` (linked worktrees
  inherit it through the common git dir; a fresh clone needs
  `~/.config/git-guards/install`). It refuses, fail-closed: any remote ref
  deletion; moving an existing tag; any update to a branch whose history carries
  another author; a non-fast-forward update to a branch not exclusively mine;
  publishing a commit authored by someone else with me as committer; and any
  case it cannot verify. A backport branch of mine that legitimately carries
  cherry-picked foreign commits is opted in per branch with
  `git config --add guard.ownBranch <glob>`; extra identities of mine with
  `git config --add guard.email <addr>`.
- `~/.claude/hooks/guard-red-write.py` (PreToolUse on Bash), which denies the
  command shapes that route around that hook, forge author/committer identity,
  rewrite a clone's identity, or delete a remote ref. Matching ignores heredoc
  bodies, so documenting these commands is not blocked.

Before any push touching a branch that is not certainly mine, compare identities
over the branch's own range rather than a guessed one:
`git log --format='%ae|%ce' $(git merge-base origin/HEAD HEAD)..HEAD | sort -u`.

## Assignment

Never set an assignee to any person unless the operator named that person for
that specific artifact, in their own words, in this conversation. An MR's
author, its `merged_by`, a repo's usual maintainer, a CODEOWNERS entry, a
team-to-person mapping, and a ticket's reporter are **not** authorisation. When
an owner seems obvious, report the candidate in chat and leave the field empty.

Never reassign for QA handoff — the QA person goes in `QA Assignee`
(`customfield_10401`) and the developer stays as assignee.

On creation: a new GitLab MR is assigned to the operator (David David); Jira
sets reporter automatically, so a new Jira ticket is left unassigned unless the
operator says otherwise.

## Writing, when it is authorised

Append rather than replace, and read the current value before writing it. An
appended block is delimited so it cannot be absorbed by adjacent structure —
blank line, then a heading; never a leading `*`, `-`, `#`, or `|`, which merge
into a neighbouring list, checklist, or table. Save the pre-edit field verbatim
first so the write is reversible.

Never place credentials, tokens, private keys, customer data, internal URLs that
leak structure, or a `claude.ai/code/session_*` link in any external system.

Every URL in an outbound message is copied from the owning tool's own link field
(`web_url`, `html_url`, `webUrl`, `message_link`), never assembled from an
identifier and a remembered project path — resolve the path from the clone's
remote or the API first. Details in the writing contract
(`~/.claude/skills/engineering/references/writing.md`).

## Volume and notification

Every field write notifies watchers. Before mutating more than three artifacts:
count the distinct people the batch will notify, decide the whole endgame before
the first write, and batch all changes to one artifact into one edit. Tell
affected people before firing, not after — a repair wave reads exactly like the
original spam.

An unattended run that discovers many follow-ups produces **one local artifact**
for the operator to review, never N tickets. Tracker objects are created after a
human accepts them, one authorisation covering one named batch.

## Everything else that leaves this machine

Do not trigger pipelines or deploys, force-push, touch a protected branch,
approve or merge an MR, tag or cut a release, change org membership or
permissions, or take production or customer-data actions without explicit
authorisation for that action. Approval for one action never extends to the next
one, and approval in one repository or environment never extends to another.
