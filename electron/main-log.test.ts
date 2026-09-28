import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `main-log.ts` imports `app` from "electron" at module scope for its default
// `dir`, even though every test below passes `dir` explicitly — importing the
// module still needs a mock, same approach as `electron/app-menu.test.ts`.
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/should-not-be-used"),
  },
}));

/** Poll until `predicate` holds, or fail the test on timeout. */
async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error(`Timed out waiting for: ${label}`);
}

function readLogSafe(logPath: string): string {
  try {
    return fs.readFileSync(logPath, "utf-8");
  } catch {
    return "";
  }
}

describe("main-log", () => {
  let dir: string;
  let originalConsoleLog: typeof console.log;

  beforeEach(() => {
    vi.resetModules();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "main-log-test-"));
    originalConsoleLog = console.log;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("formatLine", () => {
    it("renders an ISO timestamp, uppercased level, and util.format'd args", async () => {
      const { formatLine } = await import("./main-log");
      const now = new Date("2024-01-01T00:00:00.000Z");
      expect(formatLine("info", ["hello", 42], now)).toBe(
        "2024-01-01T00:00:00.000Z INFO hello 42\n",
      );
    });
  });

  it("appends console.log lines to main.log while the original console still receives the call", async () => {
    const { installMainLog } = await import("./main-log");
    const calls: unknown[][] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      calls.push(args);
    });

    installMainLog({ dir });
    console.log("hello", 42);

    expect(calls).toEqual([["hello", 42]]);

    const logPath = path.join(dir, "main.log");
    await waitFor(() => readLogSafe(logPath).includes("hello 42"), "log line written");
    expect(readLogSafe(logPath)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z LOG hello 42\n$/,
    );
  });

  it("is idempotent: a second installMainLog call is a no-op", async () => {
    const { installMainLog } = await import("./main-log");
    const calls: unknown[][] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      calls.push(args);
    });

    installMainLog({ dir });
    const otherDir = path.join(dir, "other");
    installMainLog({ dir: otherDir });

    console.log("once");

    await waitFor(() => readLogSafe(path.join(dir, "main.log")).includes("once"), "write landed");
    expect(calls.length).toBe(1);
    // The second install's dir was never touched — proof it was a no-op.
    expect(fs.existsSync(otherDir)).toBe(false);
  });

  it("rotates main.log to main.log.1 once writes push past maxBytes, keeping exactly one backup", async () => {
    const { installMainLog } = await import("./main-log");
    vi.spyOn(console, "log").mockImplementation(() => {});

    installMainLog({ dir, maxBytes: 100 });

    const logPath = path.join(dir, "main.log");
    const rotatedPath = path.join(dir, "main.log.1");

    // A short pause between writes lets each rotation's stream finish
    // opening before the next line is written. The module tracks size
    // in-memory rather than statting per line, so a rotation's `renameSync`
    // only sees the file it expects once the previous open has landed —
    // exactly how real, sporadic console output behaves.
    for (let i = 0; i < 12; i++) {
      console.log("x".repeat(20), i);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await waitFor(() => fs.existsSync(rotatedPath), "rotated backup created");
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.existsSync(rotatedPath)).toBe(true);
    // Only one generation of backup is ever kept.
    expect(fs.existsSync(path.join(dir, "main.log.2"))).toBe(false);
  });

  it("does not throw when the log directory cannot be created", async () => {
    const { installMainLog } = await import("./main-log");
    // Occupy the target path with a plain file so mkdir(dir, {recursive}) fails.
    const blockedDir = path.join(dir, "blocked");
    fs.writeFileSync(blockedDir, "occupied");

    expect(() => installMainLog({ dir: blockedDir })).not.toThrow();

    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => console.log("still safe")).not.toThrow();
  });
});
