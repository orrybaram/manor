import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as http from "node:http";
import { AgentHookServer, mapEventToStatus } from "../agent-hooks";
import { ClaudeConnector } from "../agent-connectors";
import type { AgentStatus, AgentKind } from "../terminal-host/types";

function httpGet(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error("timeout"));
    });
  });
}

// ── Tests ──

describe("mapEventToStatus", () => {
  it("maps UserPromptSubmit to thinking", () => {
    expect(mapEventToStatus("UserPromptSubmit")).toBe("thinking");
  });

  it("maps PostToolUse to thinking", () => {
    expect(mapEventToStatus("PostToolUse")).toBe("thinking");
  });

  it("maps PostToolUseFailure to thinking", () => {
    expect(mapEventToStatus("PostToolUseFailure")).toBe("thinking");
  });

  it("maps PreToolUse to working", () => {
    expect(mapEventToStatus("PreToolUse")).toBe("working");
  });

  it("maps Stop to responded", () => {
    expect(mapEventToStatus("Stop")).toBe("responded");
  });

  it("maps PermissionRequest to requires_input", () => {
    expect(mapEventToStatus("PermissionRequest")).toBe("requires_input");
  });

  it("maps Notification to requires_input", () => {
    expect(mapEventToStatus("Notification")).toBe("requires_input");
  });

  it("maps StopFailure to error", () => {
    expect(mapEventToStatus("StopFailure")).toBe("error");
  });

  it("maps SubagentStart to working", () => {
    expect(mapEventToStatus("SubagentStart")).toBe("working");
  });

  it("maps SubagentStop to thinking", () => {
    expect(mapEventToStatus("SubagentStop")).toBe("thinking");
  });

  it("maps SessionEnd to idle", () => {
    expect(mapEventToStatus("SessionEnd")).toBe("idle");
  });

  it("returns null for unknown event", () => {
    expect(mapEventToStatus("SomeRandomEvent")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(mapEventToStatus("")).toBeNull();
  });

  it("is case sensitive", () => {
    expect(mapEventToStatus("userpromptsubmit")).toBeNull();
    expect(mapEventToStatus("stop")).toBeNull();
    expect(mapEventToStatus("STOP")).toBeNull();
    expect(mapEventToStatus("permissionrequest")).toBeNull();
  });
});

describe("AgentHookServer", () => {
  let server: AgentHookServer;
  let relayFn: (paneId: string, status: AgentStatus, kind: AgentKind, sessionId: string | null, eventType: string, toolUseId: string | null) => void;

  beforeEach(async () => {
    server = new AgentHookServer();
    relayFn = vi.fn() as unknown as (
      paneId: string,
      status: AgentStatus,
      kind: AgentKind,
      sessionId: string | null,
      eventType: string,
      toolUseId: string | null,
    ) => void;
    await server.start();
    server.setRelay(relayFn);
  });

  afterEach(() => {
    server.stop();
  });

  describe("HTTP server lifecycle", () => {
    it("assigns a port > 0 on start", () => {
      expect(server.hookPort).toBeGreaterThan(0);
    });

    it("stop() closes cleanly and port becomes unusable", async () => {
      const port = server.hookPort;
      server.stop();

      await expect(
        httpGet(port, "/hook/event?paneId=a&eventType=Stop"),
      ).rejects.toThrow();
    });

    it("supports multiple start/stop cycles", async () => {
      server.stop();

      const relay = vi.fn();
      await server.start();
      server.setRelay(relay);
      expect(server.hookPort).toBeGreaterThan(0);

      server.stop();

      await server.start();
      server.setRelay(relay);
      expect(server.hookPort).toBeGreaterThan(0);
    });
  });

  describe("HTTP request handling", () => {
    it("returns 200 for valid request", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=abc&eventType=UserPromptSubmit",
      );
      expect(res.status).toBe(200);
    });

    it("returns 400 when paneId is missing", async () => {
      const res = await httpGet(server.hookPort, "/hook/event?eventType=Stop");
      expect(res.status).toBe(400);
    });

    it("returns 400 when eventType is missing", async () => {
      const res = await httpGet(server.hookPort, "/hook/event?paneId=abc");
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown path", async () => {
      const res = await httpGet(server.hookPort, "/foo");
      expect(res.status).toBe(404);
    });

    it("returns 200 for valid request with unknown eventType (accepted but relay not called)", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=abc&eventType=UnknownThing",
      );
      expect(res.status).toBe(200);
      expect(relayFn).not.toHaveBeenCalled();
    });
  });

  describe("relay callback invocation", () => {
    it("calls relay with correct paneId and status for a valid event", async () => {
      await httpGet(server.hookPort, "/hook/event?paneId=abc&eventType=Stop");

      expect(relayFn).toHaveBeenCalledTimes(1);
      expect(relayFn).toHaveBeenCalledWith(
        "abc",
        "responded",
        "claude",
        null,
        "Stop",
        null,
      );
    });

    it("defaults kind to claude when not specified", async () => {
      await httpGet(server.hookPort, "/hook/event?paneId=abc&eventType=Stop");

      expect(relayFn).toHaveBeenCalledWith(
        "abc",
        "responded",
        "claude",
        null,
        "Stop",
        null,
      );
    });

    it("passes kind parameter from request", async () => {
      await httpGet(
        server.hookPort,
        "/hook/event?paneId=abc&eventType=Stop&kind=codex",
      );

      expect(relayFn).toHaveBeenCalledWith(
        "abc",
        "responded",
        "codex",
        null,
        "Stop",
        null,
      );
    });

    it("calls relay with correct paneId for each request", async () => {
      await httpGet(
        server.hookPort,
        "/hook/event?paneId=pane-1&eventType=Stop",
      );
      await httpGet(
        server.hookPort,
        "/hook/event?paneId=pane-2&eventType=UserPromptSubmit",
      );

      expect(relayFn).toHaveBeenCalledTimes(2);
      expect(relayFn).toHaveBeenNthCalledWith(
        1,
        "pane-1",
        "responded",
        "claude",
        null,
        "Stop",
        null,
      );
      expect(relayFn).toHaveBeenNthCalledWith(
        2,
        "pane-2",
        "thinking",
        "claude",
        null,
        "UserPromptSubmit",
        null,
      );
    });

    it("paneId isolation: event for pane-1 does not relay to pane-2", async () => {
      await httpGet(
        server.hookPort,
        "/hook/event?paneId=pane-1&eventType=Stop",
      );

      expect(relayFn).toHaveBeenCalledTimes(1);
      const mockRelay = relayFn as unknown as ReturnType<typeof vi.fn>;
      const [paneId] = mockRelay.mock.calls[0] as [string, AgentStatus];
      expect(paneId).toBe("pane-1");
      expect(paneId).not.toContain("pane-2");
    });

    it("does not call relay for unknown eventType", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=abc&eventType=SomeUnknown",
      );
      expect(res.status).toBe(200);
      expect(relayFn).not.toHaveBeenCalled();
    });
  });

  describe("toolUseId forwarding", () => {
    it("passes toolUseId to relay when present in query", async () => {
      await httpGet(
        server.hookPort,
        "/hook/event?paneId=p1&eventType=SubagentStart&toolUseId=abc123",
      );
      expect(relayFn).toHaveBeenCalledWith(
        "p1",
        "working",
        "claude",
        null,
        "SubagentStart",
        "abc123",
      );
    });

    it("passes null toolUseId when absent", async () => {
      await httpGet(
        server.hookPort,
        "/hook/event?paneId=p1&eventType=Stop",
      );
      expect(relayFn).toHaveBeenCalledWith(
        "p1",
        "responded",
        "claude",
        null,
        "Stop",
        null,
      );
    });
  });
});

describe("AgentHookServer — buffering (pre-relay queue)", () => {
  let server: AgentHookServer;

  beforeEach(async () => {
    server = new AgentHookServer();
    await server.start();
    // Intentionally NOT calling setRelay here so events are buffered
  });

  afterEach(() => {
    server.stop();
  });

  it("queues events sent before setRelay is called", async () => {
    const relay = vi.fn();

    await httpGet(server.hookPort, "/hook/event?paneId=p1&eventType=Stop");
    await httpGet(server.hookPort, "/hook/event?paneId=p2&eventType=UserPromptSubmit");
    await httpGet(server.hookPort, "/hook/event?paneId=p3&eventType=PreToolUse");

    // relay not yet wired — nothing delivered
    expect(relay).not.toHaveBeenCalled();

    server.setRelay(relay);

    // All three events replayed in order
    expect(relay).toHaveBeenCalledTimes(3);
    expect(relay).toHaveBeenNthCalledWith(1, "p1", "responded", "claude", null, "Stop", null);
    expect(relay).toHaveBeenNthCalledWith(2, "p2", "thinking", "claude", null, "UserPromptSubmit", null);
    expect(relay).toHaveBeenNthCalledWith(3, "p3", "working", "claude", null, "PreToolUse", null);
  });

  it("delivers post-setRelay events directly without queueing", async () => {
    const relay = vi.fn();
    server.setRelay(relay);

    await httpGet(server.hookPort, "/hook/event?paneId=p1&eventType=Stop");
    await httpGet(server.hookPort, "/hook/event?paneId=p2&eventType=UserPromptSubmit");

    expect(relay).toHaveBeenCalledTimes(2);
    expect(relay).toHaveBeenNthCalledWith(1, "p1", "responded", "claude", null, "Stop", null);
    expect(relay).toHaveBeenNthCalledWith(2, "p2", "thinking", "claude", null, "UserPromptSubmit", null);
  });

  it("replays buffered events then immediately delivers subsequent events", async () => {
    const relay = vi.fn();

    // Queue one event before relay is set
    await httpGet(server.hookPort, "/hook/event?paneId=before&eventType=Stop");

    server.setRelay(relay);

    // Replayed immediately on setRelay
    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay).toHaveBeenNthCalledWith(1, "before", "responded", "claude", null, "Stop", null);

    // Post-setRelay event goes straight through
    await httpGet(server.hookPort, "/hook/event?paneId=after&eventType=PreToolUse");
    expect(relay).toHaveBeenCalledTimes(2);
    expect(relay).toHaveBeenNthCalledWith(2, "after", "working", "claude", null, "PreToolUse", null);
  });

  it("caps the queue at MAX_PENDING and drops newest overflow events", async () => {
    const max = AgentHookServer.MAX_PENDING;

    // Fill the queue to the cap. Requests run in parallel for speed — we only
    // care about the final count, not the arrival order within the fill batch.
    const fills: Promise<unknown>[] = [];
    for (let i = 0; i < max; i++) {
      fills.push(httpGet(server.hookPort, `/hook/event?paneId=fill-${i}&eventType=Stop`));
    }
    await Promise.all(fills);

    // Send overflow events sequentially AFTER the queue is known to be full.
    // These must be dropped because the queue is already at capacity.
    await httpGet(server.hookPort, "/hook/event?paneId=overflow-1&eventType=Stop");
    await httpGet(server.hookPort, "/hook/event?paneId=overflow-2&eventType=Stop");

    const relay = vi.fn();
    server.setRelay(relay);

    // Exactly MAX_PENDING calls — the two overflow events were dropped
    expect(relay).toHaveBeenCalledTimes(max);

    // None of the relayed calls should have an overflow paneId
    const relayMock = relay as ReturnType<typeof vi.fn>;
    const paneIds = relayMock.mock.calls.map((c) => (c as string[])[0]);
    expect(paneIds).not.toContain("overflow-1");
    expect(paneIds).not.toContain("overflow-2");
  });
});

describe("ClaudeConnector.registerHooks", () => {
  let tmpDir: string;
  let settingsPath: string;
  let hookScriptPath: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-hooks-test-${crypto.randomUUID()}`);
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    settingsPath = path.join(tmpDir, ".claude", "settings.json");
    hookScriptPath = path.join(tmpDir, ".manor", "hooks", "notify.sh");
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function freshConnector(): ClaudeConnector {
    return new ClaudeConnector();
  }

  it("creates hooks when settings file does not exist", () => {
    freshConnector().registerHooks(hookScriptPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
    expect(Object.keys(settings.hooks)).toHaveLength(11);
  });

  it("creates hooks when file exists but has no hooks key", () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ someKey: "value" }));
    freshConnector().registerHooks(hookScriptPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
    expect(settings.someKey).toBe("value");
  });

  it("adds missing hooks when some already registered", () => {
    const partial = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: hookScriptPath }] }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(partial));
    freshConnector().registerHooks(hookScriptPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(Object.keys(settings.hooks)).toHaveLength(11);
    // Stop should still have exactly 1 entry (not duplicated)
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("does NOT duplicate hooks already present (idempotent)", () => {
    const connector = freshConnector();
    connector.registerHooks(hookScriptPath);
    connector.registerHooks(hookScriptPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    for (const key of Object.keys(settings.hooks)) {
      expect(settings.hooks[key]).toHaveLength(1);
    }
  });

  it("preserves unrelated settings keys", () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark", foo: 42 }));
    freshConnector().registerHooks(hookScriptPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.theme).toBe("dark");
    expect(settings.foo).toBe(42);
  });

  it("handles invalid JSON gracefully (overwrites)", () => {
    fs.writeFileSync(settingsPath, "not valid json {{{");
    freshConnector().registerHooks(hookScriptPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
  });

  it("registers all 11 event types", () => {
    freshConnector().registerHooks(hookScriptPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const expectedEvents = [
      "UserPromptSubmit",
      "Stop",
      "PostToolUse",
      "PostToolUseFailure",
      "PermissionRequest",
      "PreToolUse",
      "Notification",
      "StopFailure",
      "SubagentStart",
      "SubagentStop",
      "SessionEnd",
    ];
    for (const event of expectedEvents) {
      expect(settings.hooks[event]).toBeDefined();
      expect(settings.hooks[event]).toHaveLength(1);
    }
  });

  it("each hook entry points to the hook script path", () => {
    freshConnector().registerHooks(hookScriptPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    for (const event of Object.keys(settings.hooks)) {
      const entries = settings.hooks[event];
      expect(entries[0].hooks[0].command).toBe(hookScriptPath);
    }
  });
});

describe("ensureHookScript", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `manor-hookscript-test-${crypto.randomUUID()}`,
    );
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function freshImport() {
    const mod = await import(
      `../agent-hooks?t=${Date.now()}-${crypto.randomUUID()}`
    );
    return mod;
  }

  it("creates hooks directory if missing", async () => {
    const { ensureHookScript } = await freshImport();
    ensureHookScript();

    const hooksDir = path.join(tmpDir, ".manor", "hooks");
    expect(fs.existsSync(hooksDir)).toBe(true);
  });

  it("writes notify.sh with executable permission", async () => {
    const { ensureHookScript } = await freshImport();
    ensureHookScript();

    const scriptPath = path.join(tmpDir, ".manor", "hooks", "notify.sh");
    expect(fs.existsSync(scriptPath)).toBe(true);

    const stat = fs.statSync(scriptPath);
    // Check executable bit (owner execute = 0o100)
    expect(stat.mode & 0o755).toBe(0o755);
  });

  it("bash wrapper exec's the node implementation alongside it", async () => {
    const { ensureHookScript } = await freshImport();
    ensureHookScript();

    const scriptPath = path.join(tmpDir, ".manor", "hooks", "notify.sh");
    const content = fs.readFileSync(scriptPath, "utf-8");
    expect(content).toContain("#!/bin/bash");
    expect(content).toContain("exec node");
    expect(content).toContain("notify.js");
  });

  it("writes notify.js alongside notify.sh with executable permission", async () => {
    const { ensureHookScript } = await freshImport();
    ensureHookScript();

    const jsPath = path.join(tmpDir, ".manor", "hooks", "notify.js");
    expect(fs.existsSync(jsPath)).toBe(true);
    const stat = fs.statSync(jsPath);
    expect(stat.mode & 0o755).toBe(0o755);
  });

  it("notify.js sources the agent hook implementation (uses MANOR_HOOK_PORT and MANOR_AGENT_KIND)", async () => {
    const { ensureHookScript } = await freshImport();
    ensureHookScript();

    const jsPath = path.join(tmpDir, ".manor", "hooks", "notify.js");
    const content = fs.readFileSync(jsPath, "utf-8");
    expect(content).toContain("MANOR_HOOK_PORT");
    expect(content).toContain("MANOR_AGENT_KIND");
    expect(content).toContain("hook_event_name");
  });
});
