/**
 * Detached process-group leader for a worker run. It durably registers its own
 * PGID before starting the agent CLI, closing the parent-death gap between
 * Bun.spawn() returning and the dispatcher recording the child PID.
 */

import { LeaseDb } from "./lease.ts";

const [root, cardId, runId, ...argv] = process.argv.slice(2);
if (!root || !cardId || !runId || argv.length === 0) process.exit(64);

const db = new LeaseDb(root);
const registered = db.setProcessGroup(cardId, runId, process.pid);
db.close();
if (!registered) process.exit(75);

const child = Bun.spawn(argv, {
  cwd: process.cwd(),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
process.exit(await child.exited);
