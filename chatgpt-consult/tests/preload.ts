import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.CHATGPT_CONSULT_CONFIG_HOME === undefined) {
  process.env.CHATGPT_CONSULT_CONFIG_HOME = mkdtempSync(join(tmpdir(), "chatgpt-consult-test-config-home-"));
}
