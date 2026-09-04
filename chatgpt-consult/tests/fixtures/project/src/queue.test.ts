import { describe, expect, test } from "bun:test";
import { retryDelay } from "./queue";

describe("retryDelay", () => {
  test("uses bounded exponential backoff", () => {
    const policy = { maxAttempts: 3, baseDelayMs: 100 };
    expect(retryDelay(1, policy)).toBe(100);
    expect(retryDelay(3, policy)).toBe(400);
    expect(retryDelay(4, policy)).toBe(0);
  });
});
