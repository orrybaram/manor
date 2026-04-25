/**
 * Tests for the standalone Node hook script (electron/scripts/agent-hook.js).
 *
 * Imports the script as a module and exercises main() against fake stdin,
 * fake fetch, and fake env, asserting the URL and query parameters that
 * would have been issued to the hook server.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const agentHook = require("../scripts/agent-hook.js") as {
  main: (opts: MainOpts) => Promise<void>;
  resolvePort: (
    env: Record<string, string | undefined>,
    homeDir: string,
  ) => number | null;
  buildUrl: (
    port: number,
    params: {
      paneId: string | null;
      eventType: string | null;
      kind?: string;
      sessionId?: string | null;
      toolUseId?: string | null;
    },
  ) => string | null;
};

type FakeStderr = { write: (chunk: string) => boolean; lines: string[] };
type FakeFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean }>;
type MainOpts = {
  argv?: string[];
  stdin?: NodeJS.ReadableStream;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  fetch?: FakeFetch;
  stderr?: FakeStderr;
};

function makeStdin(payload: string): NodeJS.ReadableStream {
  // Readable.from(string) emits the string in one chunk and ends.
  return Readable.from([payload]);
}

function makeStderr(): FakeStderr {
  const lines: string[] = [];
  return {
    lines,
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
  };
}

function makeFetch(): {
  fn: FakeFetch;
  calls: { url: string; init?: { signal?: AbortSignal } }[];
} {
  const calls: { url: string; init?: { signal?: AbortSignal } }[] = [];
  const fn: FakeFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true });
  };
  return { fn, calls };
}

describe("agent-hook.js — main()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `manor-hook-js-test-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("issues a GET with all expected query params when payload includes session_id and tool_use_id", async () => {
    fs.mkdirSync(path.join(tmpDir, ".manor"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".manor", "hook-port"), "54321");

    const stderr = makeStderr();
    const { fn: fetchFn, calls } = makeFetch();

    const payload = JSON.stringify({
      hook_event_name: "SubagentStart",
      session_id: "sess-abc",
      tool_use_id: "tool-xyz",
    });

    await agentHook.main({
      argv: ["node", "agent-hook.js"],
      stdin: makeStdin(payload),
      env: { MANOR_PANE_ID: "pane-1", MANOR_AGENT_KIND: "claude" },
      homeDir: tmpDir,
      fetch: fetchFn,
      stderr,
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.protocol).toBe("http:");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe("54321");
    expect(url.pathname).toBe("/hook/event");
    expect(url.searchParams.get("paneId")).toBe("pane-1");
    expect(url.searchParams.get("eventType")).toBe("SubagentStart");
    expect(url.searchParams.get("kind")).toBe("claude");
    expect(url.searchParams.get("sessionId")).toBe("sess-abc");
    expect(url.searchParams.get("toolUseId")).toBe("tool-xyz");
    // No stderr noise on the happy path.
    expect(stderr.lines).toHaveLength(0);
  });

  it("omits sessionId and toolUseId when not present in payload", async () => {
    fs.mkdirSync(path.join(tmpDir, ".manor"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".manor", "hook-port"), "12000");

    const { fn: fetchFn, calls } = makeFetch();

    const payload = JSON.stringify({ hook_event_name: "Stop" });

    await agentHook.main({
      argv: ["node", "agent-hook.js"],
      stdin: makeStdin(payload),
      env: { MANOR_PANE_ID: "pane-2" },
      homeDir: tmpDir,
      fetch: fetchFn,
      stderr: makeStderr(),
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("paneId")).toBe("pane-2");
    expect(url.searchParams.get("eventType")).toBe("Stop");
    expect(url.searchParams.get("kind")).toBe("claude");
    expect(url.searchParams.has("sessionId")).toBe(false);
    expect(url.searchParams.has("toolUseId")).toBe(false);
  });

  it("uses MANOR_AGENT_KIND from env when provided", async () => {
    fs.mkdirSync(path.join(tmpDir, ".manor"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".manor", "hook-port"), "11111");

    const { fn: fetchFn, calls } = makeFetch();

    const payload = JSON.stringify({ hook_event_name: "PreToolUse" });

    await agentHook.main({
      argv: ["node", "agent-hook.js"],
      stdin: makeStdin(payload),
      env: { MANOR_PANE_ID: "p", MANOR_AGENT_KIND: "codex" },
      homeDir: tmpDir,
      fetch: fetchFn,
      stderr: makeStderr(),
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("kind")).toBe("codex");
  });

  it("reads payload from argv[2] when present (legacy single-arg invocation)", async () => {
    fs.mkdirSync(path.join(tmpDir, ".manor"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".manor", "hook-port"), "9999");

    const { fn: fetchFn, calls } = makeFetch();

    const payload = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "sess-1",
    });

    // Stdin should be ignored when argv[2] is set.
    await agentHook.main({
      argv: ["node", "agent-hook.js", payload],
      stdin: makeStdin("garbage-not-read"),
      env: { MANOR_PANE_ID: "pane-x" },
      homeDir: tmpDir,
      fetch: fetchFn,
      stderr: makeStderr(),
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("eventType")).toBe("UserPromptSubmit");
    expect(url.searchParams.get("sessionId")).toBe("sess-1");
  });

  it("prefers ~/.manor/hook-port over MANOR_HOOK_PORT env when both are set", async () => {
    fs.mkdirSync(path.join(tmpDir, ".manor"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".manor", "hook-port"), "55555");

    const { fn: fetchFn, calls } = makeFetch();

    await agentHook.main({
      argv: ["node", "agent-hook.js"],
      stdin: makeStdin(JSON.stringify({ hook_event_name: "Stop" })),
      env: { MANOR_PANE_ID: "p", MANOR_HOOK_PORT: "11111" },
      homeDir: tmpDir,
      fetch: fetchFn,
      stderr: makeStderr(),
    });

    const url = new URL(calls[0]!.url);
    expect(url.port).toBe("55555");
  });

  it("falls back to MANOR_HOOK_PORT env when ~/.manor/hook-port is absent", async () => {
    // No port file written.
    const { fn: fetchFn, calls } = makeFetch();

    await agentHook.main({
      argv: ["node", "agent-hook.js"],
      stdin: makeStdin(JSON.stringify({ hook_event_name: "Stop" })),
      env: { MANOR_PANE_ID: "p", MANOR_HOOK_PORT: "33333" },
      homeDir: tmpDir,
      fetch: fetchFn,
      stderr: makeStderr(),
    });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.port).toBe("33333");
  });

  it("does not call fetch when MANOR_PANE_ID is missing", async () => {
    fs.mkdirSync(path.join(tmpDir, ".manor"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".manor", "hook-port"), "1234");

    const { fn: fetchFn, calls } = makeFetch();

    await agentHook.main({
      argv: ["node", "agent-hook.js"],
      stdin: makeStdin(JSON.stringify({ hook_event_name: "Stop" })),
      env: {}, // no MANOR_PANE_ID
      homeDir: tmpDir,
      fetch: fetchFn,
      stderr: makeStderr(),
    });

    expect(calls).toHaveLength(0);
  });

  it("does not call fetch when no port is available", async () => {
    const { fn: fetchFn, calls } = makeFetch();
    const stderr = makeStderr();

    await agentHook.main({
      argv: ["node", "agent-hook.js"],
      stdin: makeStdin(JSON.stringify({ hook_event_name: "Stop" })),
      env: { MANOR_PANE_ID: "p" }, // no env port, no port file
      homeDir: tmpDir,
      fetch: fetchFn,
      stderr,
    });

    expect(calls).toHaveLength(0);
    // Logged to stderr but did not throw.
    expect(stderr.lines.join("")).toContain("no hook port");
  });

  it("logs to stderr and returns without throwing on invalid JSON payload", async () => {
    fs.mkdirSync(path.join(tmpDir, ".manor"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".manor", "hook-port"), "1234");

    const { fn: fetchFn, calls } = makeFetch();
    const stderr = makeStderr();

    await agentHook.main({
      argv: ["node", "agent-hook.js"],
      stdin: makeStdin("not-json{{{"),
      env: { MANOR_PANE_ID: "p" },
      homeDir: tmpDir,
      fetch: fetchFn,
      stderr,
    });

    expect(calls).toHaveLength(0);
    expect(stderr.lines.join("")).toContain("invalid JSON");
  });

  it("correctly parses payloads containing escaped quotes inside string values", async () => {
    // The bash version's grep-based extractor breaks on this kind of
    // payload. JSON.parse handles it correctly.
    fs.mkdirSync(path.join(tmpDir, ".manor"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".manor", "hook-port"), "4040");

    const { fn: fetchFn, calls } = makeFetch();

    const payload = JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: 'has "embedded" quotes',
      tool_use_id: "tool-1",
    });

    await agentHook.main({
      argv: ["node", "agent-hook.js"],
      stdin: makeStdin(payload),
      env: { MANOR_PANE_ID: "p" },
      homeDir: tmpDir,
      fetch: fetchFn,
      stderr: makeStderr(),
    });

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("sessionId")).toBe('has "embedded" quotes');
    expect(url.searchParams.get("toolUseId")).toBe("tool-1");
  });

  it("swallows fetch failures (logs to stderr, does not throw)", async () => {
    fs.mkdirSync(path.join(tmpDir, ".manor"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".manor", "hook-port"), "4040");

    const stderr = makeStderr();
    const fetchFn: FakeFetch = () => Promise.reject(new Error("connect refused"));

    await expect(
      agentHook.main({
        argv: ["node", "agent-hook.js"],
        stdin: makeStdin(JSON.stringify({ hook_event_name: "Stop" })),
        env: { MANOR_PANE_ID: "p" },
        homeDir: tmpDir,
        fetch: fetchFn,
        stderr,
      }),
    ).resolves.toBeUndefined();
    expect(stderr.lines.join("")).toContain("request failed");
  });
});

describe("agent-hook.js — resolvePort()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `manor-hook-js-port-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when neither file nor env supplies a port", () => {
    expect(agentHook.resolvePort({}, tmpDir)).toBeNull();
  });

  it("ignores invalid (non-numeric) file content", () => {
    fs.mkdirSync(path.join(tmpDir, ".manor"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".manor", "hook-port"), "not-a-number");
    expect(
      agentHook.resolvePort({ MANOR_HOOK_PORT: "9000" }, tmpDir),
    ).toBe(9000);
  });

  it("ignores invalid env value when no file present", () => {
    expect(agentHook.resolvePort({ MANOR_HOOK_PORT: "garbage" }, tmpDir)).toBeNull();
  });
});

describe("agent-hook.js — buildUrl()", () => {
  it("returns null without paneId", () => {
    expect(
      agentHook.buildUrl(1234, { paneId: null, eventType: "Stop" }),
    ).toBeNull();
  });

  it("returns null without eventType", () => {
    expect(
      agentHook.buildUrl(1234, { paneId: "p", eventType: null }),
    ).toBeNull();
  });

  it("URL-encodes special characters in query values", () => {
    const url = agentHook.buildUrl(1234, {
      paneId: "p&id=evil",
      eventType: "Stop",
      sessionId: "x y/z",
    });
    expect(url).toBeTruthy();
    const parsed = new URL(url!);
    expect(parsed.searchParams.get("paneId")).toBe("p&id=evil");
    expect(parsed.searchParams.get("sessionId")).toBe("x y/z");
  });
});
