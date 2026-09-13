import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_COOLDOWN_MS, BrowserRateLimitGate } from "../src/browser/rate-limit";

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("independent workers share a cooldown without extending it on blocked reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-rate-limit-"));
  temporaryPaths.push(root);
  let now = Date.now() + 1000;
  const first = new BrowserRateLimitGate(root, () => now);
  const peer = new BrowserRateLimitGate(root, () => now);
  expect(await peer.isBlocked(9222)).toBeFalse();
  await first.pause(9222);
  expect(await peer.isBlocked(9222)).toBeTrue();
  expect(await peer.isBlocked(9333)).toBeFalse();
  const marker = await stat(join(root, "browser-cooldown-9222"));
  expect(marker.size).toBe(0);
  expect(marker.mode & 0o777).toBe(0o600);
  now += BROWSER_COOLDOWN_MS - 1;
  expect(await peer.isBlocked(9222)).toBeTrue();
  now += 1;
  expect(await peer.isBlocked(9222)).toBeFalse();
  await peer.pause(9222);
  expect(await first.isBlocked(9222)).toBeTrue();
});

test("cooldown markers cannot follow a symlink to another file", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-rate-limit-"));
  temporaryPaths.push(root);
  const target = join(root, "existing.txt");
  await writeFile(target, "unchanged");
  await symlink(target, join(root, "browser-cooldown-9222"));
  const gate = new BrowserRateLimitGate(root);
  await expect(gate.isBlocked(9222)).rejects.toThrow("unsafe");
  await expect(gate.pause(9222)).rejects.toThrow();
  expect(await Bun.file(target).text()).toBe("unchanged");
});
