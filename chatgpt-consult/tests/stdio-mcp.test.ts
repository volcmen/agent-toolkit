import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const temporaryPaths: string[] = [];
const absoluteBin = join(dirname(import.meta.dir), "bin", "chatgpt-consult.ts");

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const waitForExit = async (pid: number): Promise<boolean> => {
  const deadline = Date.now() + 1_000;
  while (processIsAlive(pid) && Date.now() < deadline) await Bun.sleep(10);
  return !processIsAlive(pid);
};

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("local stdio MCP", () => {
  test("rejects serve options without writing non-protocol JSON to stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-stdio-options-"));
    temporaryPaths.push(root);
    const result = Bun.spawnSync(
      ["bun", absoluteBin, "serve", "local", "--json"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("INVALID_INPUT");
    expect(result.stderr.toString()).not.toContain("\"jsonrpc\"");
  });

  test("serves the exact local surface from one temporary project with protocol-clean stderr", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-consult-stdio-mcp-"));
    temporaryPaths.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "queue.ts"), "export const queue = [];\n");

    const transport = new StdioClientTransport({
      command: "bun",
      args: [absoluteBin, "serve", "local"],
      cwd: root,
      stderr: "pipe",
    });
    let stderr = "";
    const stderrStream = transport.stderr;
    const stderrSettled = stderrStream
      ? new Promise<void>((resolve) => stderrStream.once("end", resolve))
      : Promise.resolve();
    stderrStream?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const client = new Client({ name: "stdio-mcp-test", version: "1.0.0" });
    let claimToken = "";
    let childPid: number | null = null;
    try {
      await client.connect(transport);
      childPid = transport.pid;
      expect(childPid).toBeInteger();
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "consult_start",
        "consult_status",
        "consult_show",
        "consult_followup",
        "consult_cancel",
        "consult_publish",
      ]);
      const started = await client.callTool({
        name: "consult_start",
        arguments: {
          goal: "Review queue policy",
          files: ["src/queue.ts"],
          profile: "lean",
          idempotency_key: "stdio-start",
        },
      });
      expect(started.isError).not.toBe(true);
      expect(started.structuredContent).toMatchObject({ state: "pending" });
      const value = started.structuredContent as Record<string, unknown>;
      expect(value.claimToken).toBeString();
      claimToken = value.claimToken as string;
      const requestId = value.requestId as string;
      await writeFile(join(root, "completion.json"), JSON.stringify({
        summary: "Safe result",
        answer: "Keep the claim private.",
        evidence: [],
        assumptions: [],
        risks: [],
        recommendations: [],
        followUpQuestions: [],
      }));
      const imported = Bun.spawnSync([
        "bun",
        absoluteBin,
        "import-result",
        requestId,
        "--input",
        "completion.json",
        "--json",
      ], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(imported.exitCode).toBe(0);
      expect(imported.stdout.toString()).not.toContain(claimToken);
      expect(imported.stderr.toString()).not.toContain(claimToken);

      const rejected = await client.callTool({
        name: "consult_publish",
        arguments: {
          request_id: requestId,
          output: `claim-output/x${claimToken}x.md`,
        },
      });
      expect(rejected.isError).toBeTrue();
      expect(rejected.structuredContent).toEqual({
        error: { code: "INVALID_INPUT", message: "Publication path contains forbidden claim material" },
      });
      expect(JSON.stringify(rejected)).not.toContain(claimToken);
      expect(await Bun.file(join(root, "claim-output")).exists()).toBeFalse();
      expect(stderr).not.toContain("\"jsonrpc\"");
      expect(stderr).not.toContain(claimToken);
    } finally {
      await client.close();
    }

    const stderrEnded = await Promise.race([
      stderrSettled.then(() => true),
      Bun.sleep(1_000).then(() => false),
    ]);
    expect(childPid).not.toBeNull();
    expect(transport.pid).toBeNull();
    expect(stderrEnded).toBeTrue();
    expect(await waitForExit(childPid!)).toBeTrue();
    expect(stderr).not.toContain("\"jsonrpc\"");
    expect(stderr).not.toContain(claimToken);
  });
});
