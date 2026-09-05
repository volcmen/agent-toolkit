# Waiting on slow work

Applies when the next step depends on CI, a deployment, build, server, test
suite, container, queue, filesystem event, or other slow state transition.
Observe a condition or event instead of guessing a delay.

## Capability order

Use the highest available option:

1. **Event or stream.** Subscribe to the system's events. When available, use
   `Monitor` for a command, log, WebSocket, or state-change stream so Claude is
   notified without blocking or repeatedly re-running the model.
2. **Native wait.** Prefer commands that already block until a terminal state,
   such as `glab ci status --wait`, `gh pr checks --watch`, `kubectl wait`,
   `kubectl rollout status`, `docker wait`, `docker compose up --wait`, or a
   test command that exits. Run work lasting more than a few seconds with
   `run_in_background: true` when the harness supports it.
3. **Bounded condition loop.** If no native wait exists, run a background loop
   that checks the real condition, tolerates transient read failures, exits on
   success or failure, and enforces a deadline.
4. **State-change polling.** When progress matters, use `Monitor` with a bounded
   poller that emits only when state changes and terminates on every final state.
5. **Scheduled re-evaluation.** Use `/loop` or `CronCreate` only when the state
   cannot be observed continuously or a model turn must reassess it. These are
   session-scoped. For work that must survive the session or a sleeping machine,
   choose a durable scheduler such as a Claude routine, Desktop scheduled task,
   CI workflow, or the platform's native automation.

Example bounded local wait:

```bash
deadline=$((SECONDS + 120))
until curl -fsS http://127.0.0.1:8002/health >/dev/null 2>&1; do
  (( SECONDS < deadline )) || { echo "timeout waiting for health" >&2; exit 1; }
  sleep 1
done
```

The `sleep` is inside a condition observer; it is not a blind delay followed by
a guess.

## Required behavior

- Do not block the main turn on slow work when background execution or
  `Monitor` is available. Continue independent work and react to the completion
  event.
- Do not poll background tasks or subagents when the harness already sends
  completion notifications. Poll only external state the harness cannot see.
- Every custom watcher needs a deadline or attempt bound and must recognize
  terminal failure, cancellation, timeout, and success. Silence must not be
  treated as success.
- Match polling cadence to the system: local ports and files can use short
  intervals; remote APIs and CI usually need 30–60 seconds. Respect server rate
  limits and retry hints.
- Emit state transitions rather than identical heartbeats. When piping a live
  stream, include stderr and use line-buffered stages so events are delivered
  promptly; do not truncate an endless stream with `head`.
- Report the observed terminal state and the evidence that established it.
  Stop monitors and scheduled checks when the task finishes or is abandoned.

## System defaults

- **GitLab:** `glab ci status --wait` for a quiet wait or `--live` for streamed
  progress; use `glab ci get` for final pipeline and job details.
- **GitHub:** `gh run watch` or `gh pr checks --watch`.
- **Kubernetes:** `kubectl wait`, `kubectl rollout status`, `kubectl get -w`, or
  `kubectl logs -f` with a terminal condition.
- **Docker:** healthchecks plus `--wait`, `docker wait`, or `docker logs -f`.
- **Local servers:** wait on the health endpoint, port, or documented ready log
  line; do not sleep for an assumed startup time.
- **Browser:** wait for a selector, URL, network, or DOM condition and take a
  fresh snapshot after navigation or re-render.
- **Filesystem:** use `fswatch` on macOS or another native filesystem event
  source when available.
- **Jenkins MCP:** when no event source exists, check build status every 30–60
  seconds through a scheduled re-evaluation, authenticate once, and fetch the
  console log or test results once after the build reaches a final state.
