import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const BROWSER_COOLDOWN_MS = 5 * 60_000;

export class BrowserRateLimitGate {
  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {
    if (!isAbsolute(directory)) throw new TypeError("Browser cooldown directory must be absolute");
  }

  private marker(port: number): string {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new RangeError("Browser cooldown port must be an integer from 1 through 65535");
    }
    return join(this.directory, `browser-cooldown-${port}`);
  }

  async isBlocked(port: number): Promise<boolean> {
    try {
      const info = await lstat(this.marker(port));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Browser cooldown marker is unsafe");
      return info.mtimeMs + BROWSER_COOLDOWN_MS > this.now();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async pause(port: number): Promise<void> {
    const marker = this.marker(port);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Browser cooldown directory is unsafe");
    const handle = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Browser cooldown marker is unsafe");
      const timestamp = new Date(Math.max(this.now(), info.mtimeMs));
      await handle.utimes(timestamp, timestamp);
    } finally {
      await handle.close();
    }
  }
}
