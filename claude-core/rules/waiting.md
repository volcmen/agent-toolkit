# Waiting on slow work

When the next step depends on CI, a deploy, build, server, test suite,
container, or queue, observe the terminal condition; never sleep for a guessed
delay. Use the highest available option:

1. Event or stream: `Monitor` on a command, log, or state-change stream. A
   watch always carries a deadline of at most 30 minutes, 10 in a single-prompt
   `-p` run, and notifies on expiry so it can be re-armed; there is no
   unbounded watch.
2. Native wait: `glab ci status --wait`, `gh pr checks --watch`, `kubectl wait`,
   `kubectl rollout status`, `docker wait`, `docker compose up --wait`, a test
   command that exits. Anything beyond a few seconds runs with
   `run_in_background: true`.
3. Bounded condition loop that checks the real condition, tolerates transient
   read failures, exits on success or failure, and enforces a deadline:
   `deadline=$((SECONDS+120)); until curl -fsS URL >/dev/null 2>&1; do (( SECONDS < deadline )) || exit 1; sleep 1; done`
4. `Monitor` with a bounded poller that emits only on state change.
5. `/loop` or `CronCreate` only when the state cannot be observed continuously;
   both are session-scoped, so durable work needs a routine, CI workflow, or the
   platform's scheduler.

Never block the main turn when background execution exists. Do not poll what
the harness already notifies (background tasks, subagents). Every watcher has a
deadline and recognizes success, failure, cancellation, and timeout; silence is
not success. Local ports poll in seconds, remote APIs and CI every 30–60 s.
Emit transitions, not heartbeats. Report the observed terminal state and its
evidence; stop monitors when done. Browser: wait for a selector, URL, or DOM
condition, then re-snapshot. Filesystem: `fswatch`. Jenkins MCP: re-evaluate
every 30–60 s, authenticate once, fetch the console log once after a final state.
