import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as http from "node:http";
import { AgentHookServer } from "../agent-hooks";
import { parseAgentHookEvent } from "../agent-hook-events";
import { ClaudeConnector } from "../agent-connectors";
import type { AgentHookEvent } from "../agent-hook-events";

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

describe("parseAgentHookEvent — eventType → status mapping", () => {
  function build(eventType: string, extra: Record<string, string> = {}) {
    const params = new URLSearchParams({
      paneId: "p1",
      eventType,
      kind: "claude",
      ...extra,
    });
    return parseAgentHookEvent(params);
  }

  function statusFor(eventType: string) {
    const r = build(eventType);
    if (!r.ok) throw new Error(`expected ok for ${eventType}, got ${r.reason}`);
    return r.event.status;
  }

  it("maps UserPromptSubmit to thinking", () => {
    expect(statusFor("UserPromptSubmit")).toBe("thinking");
  });
  it("maps PostToolUse to thinking", () => {
    expect(statusFor("PostToolUse")).toBe("thinking");
  });
  it("maps PostToolUseFailure to thinking", () => {
    expect(statusFor("PostToolUseFailure")).toBe("thinking");
  });
  it("maps PreToolUse to working", () => {
    expect(statusFor("PreToolUse")).toBe("working");
  });
  it("maps Stop to responded", () => {
    expect(statusFor("Stop")).toBe("responded");
  });
  it("maps PermissionRequest to requires_input", () => {
    expect(statusFor("PermissionRequest")).toBe("requires_input");
  });
  it("maps Notification to requires_input", () => {
    expect(statusFor("Notification")).toBe("requires_input");
  });
  it("maps StopFailure to error", () => {
    expect(statusFor("StopFailure")).toBe("error");
  });
  it("maps SubagentStart to working", () => {
    expect(statusFor("SubagentStart")).toBe("working");
  });
  it("maps SubagentStop to thinking", () => {
    expect(statusFor("SubagentStop")).toBe("thinking");
  });
  it("maps SessionEnd to idle", () => {
    expect(statusFor("SessionEnd")).toBe("idle");
  });

  it("drops unknown eventType (action=drop)", () => {
    const r = build("SomeRandomEvent");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.action).toBe("drop");
  });
  it("rejects empty eventType (action=reject)", () => {
    const r = build("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.action).toBe("reject");
  });
  it("is case sensitive", () => {
    expect(build("userpromptsubmit").ok).toBe(false);
    expect(build("stop").ok).toBe(false);
    expect(build("STOP").ok).toBe(false);
    expect(build("permissionrequest").ok).toBe(false);
  });
});

describe("AgentHookServer", () => {
  let server: AgentHookServer;
  let relayFn: (event: AgentHookEvent) => void;

  beforeEach(async () => {
    server = new AgentHookServer();
    relayFn = vi.fn() as (event: AgentHookEvent) => void;
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

    it("writes port file atomically and parses to valid port number", () => {
      const portFilePath = path.join(process.env.HOME || os.homedir(), ".manor", "hook-port");
      expect(fs.existsSync(portFilePath)).toBe(true);

      const content = fs.readFileSync(portFilePath, "utf-8");
      const parsedPort = parseInt(content, 10);
      expect(parsedPort).toBeGreaterThan(0);
      expect(parsedPort).toBe(server.hookPort);
    });

    it("does not leave .tmp file after atomic write", () => {
      const portFilePath = path.join(process.env.HOME || os.homedir(), ".manor", "hook-port");
      const tmpPath = `${portFilePath}.tmp`;
      expect(fs.existsSync(tmpPath)).toBe(false);
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
    it("returns 200 for valid request with known kind", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=abc&eventType=UserPromptSubmit&kind=claude",
      );
      expect(res.status).toBe(200);
    });

    it("returns 400 when paneId is missing", async () => {
      const res = await httpGet(server.hookPort, "/hook/event?eventType=Stop&kind=claude");
      expect(res.status).toBe(400);
    });

    it("returns 400 when eventType is missing", async () => {
      const res = await httpGet(server.hookPort, "/hook/event?paneId=abc&kind=claude");
      expect(res.status).toBe(400);
    });

    it("returns 400 when kind is missing (no default)", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=abc&eventType=Stop",
      );
      expect(res.status).toBe(400);
      expect(relayFn).not.toHaveBeenCalled();
    });

    it("returns 400 when kind is unknown (e.g. banana)", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=abc&eventType=Stop&kind=banana",
      );
      expect(res.status).toBe(400);
      expect(relayFn).not.toHaveBeenCalled();
    });

    it("returns 404 for unknown path", async () => {
      const res = await httpGet(server.hookPort, "/foo");
      expect(res.status).toBe(404);
    });

    it("returns 200 for valid request with unknown eventType (accepted but relay not called)", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=abc&eventType=UnknownThing&kind=claude",
      );
      expect(res.status).toBe(200);
      expect(relayFn).not.toHaveBeenCalled();
    });

    it("returns 200 for kind=codex with valid event", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=abc&eventType=Stop&kind=codex",
      );
      expect(res.status).toBe(200);
    });
  });

  describe("relay callback invocation", () => {
    it("calls relay with correct paneId and status for a valid event", async () => {
      await httpGet(server.hookPort, "/hook/event?paneId=abc&eventType=Stop&kind=claude");

      expect(relayFn).toHaveBeenCalledTimes(1);
      expect(relayFn).toHaveBeenCalledWith({
        type: "Stop",
        status: "responded",
        paneId: "abc",
        sessionId: null,
        agentKind: "claude",
      });
    });

    it("returns 400 and does not invoke relay when kind is missing", async () => {
      const res = await httpGet(server.hookPort, "/hook/event?paneId=abc&eventType=Stop");
      expect(res.status).toBe(400);
      expect(relayFn).not.toHaveBeenCalled();
    });

    it("returns 400 and does not invoke relay when kind is unknown", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=abc&eventType=Stop&kind=banana",
      );
      expect(res.status).toBe(400);
      expect(relayFn).not.toHaveBeenCalled();
    });

    it("invokes relay with kind=codex when kind=codex", async () => {
      await httpGet(
        server.hookPort,
        "/hook/event?paneId=abc&eventType=Stop&kind=codex",
      );
      expect(relayFn).toHaveBeenCalledWith({
        type: "Stop",
        status: "responded",
        paneId: "abc",
        sessionId: null,
        agentKind: "codex",
      });
    });

    it("calls relay with correct paneId for each request", async () => {
      await httpGet(
        server.hookPort,
        "/hook/event?paneId=pane-1&eventType=Stop&kind=claude",
      );
      await httpGet(
        server.hookPort,
        "/hook/event?paneId=pane-2&eventType=UserPromptSubmit&kind=claude",
      );

      expect(relayFn).toHaveBeenCalledTimes(2);
      expect(relayFn).toHaveBeenNthCalledWith(1, {
        type: "Stop",
        status: "responded",
        paneId: "pane-1",
        sessionId: null,
        agentKind: "claude",
      });
      expect(relayFn).toHaveBeenNthCalledWith(2, {
        type: "UserPromptSubmit",
        status: "thinking",
        paneId: "pane-2",
        sessionId: null,
        agentKind: "claude",
      });
    });

    it("paneId isolation: event for pane-1 does not relay to pane-2", async () => {
      await httpGet(
        server.hookPort,
        "/hook/event?paneId=pane-1&eventType=Stop&kind=claude",
      );

      expect(relayFn).toHaveBeenCalledTimes(1);
      const mockRelay = relayFn as unknown as ReturnType<typeof vi.fn>;
      const [event] = mockRelay.mock.calls[0] as [AgentHookEvent];
      expect(event.paneId).toBe("pane-1");
    });

    it("does not call relay for unknown eventType", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=abc&eventType=SomeUnknown&kind=claude",
      );
      expect(res.status).toBe(200);
      expect(relayFn).not.toHaveBeenCalled();
    });
  });

  describe("toolUseId forwarding", () => {
    it("passes toolUseId on subagent variants when present in query", async () => {
      await httpGet(
        server.hookPort,
        "/hook/event?paneId=p1&eventType=SubagentStart&toolUseId=abc123&kind=claude",
      );
      expect(relayFn).toHaveBeenCalledWith({
        type: "SubagentStart",
        status: "working",
        paneId: "p1",
        sessionId: null,
        agentKind: "claude",
        toolUseId: "abc123",
      });
    });

    it("Stop variant has no toolUseId field", async () => {
      await httpGet(
        server.hookPort,
        "/hook/event?paneId=p1&eventType=Stop&kind=claude",
      );
      const mockRelay = relayFn as unknown as ReturnType<typeof vi.fn>;
      const [event] = mockRelay.mock.calls[0] as [AgentHookEvent];
      expect(event).not.toHaveProperty("toolUseId");
    });
  });

  describe("Notification event — notificationKind gating", () => {
    it("relays Notification with requires_input when notificationKind=permission_prompt", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=p1&eventType=Notification&kind=claude&notificationKind=permission_prompt",
      );
      expect(res.status).toBe(200);
      expect(relayFn).toHaveBeenCalledWith({
        type: "Notification",
        status: "requires_input",
        paneId: "p1",
        sessionId: null,
        agentKind: "claude",
      });
    });

    it("returns 200 but does NOT relay for non-permission notificationKind (e.g. auto_compact)", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=p1&eventType=Notification&kind=claude&notificationKind=auto_compact",
      );
      expect(res.status).toBe(200);
      expect(relayFn).not.toHaveBeenCalled();
    });

    it("returns 200 but does NOT relay for any unknown notificationKind", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=p1&eventType=Notification&kind=claude&notificationKind=some_future_type",
      );
      expect(res.status).toBe(200);
      expect(relayFn).not.toHaveBeenCalled();
    });

    it("relays Notification when notificationKind is absent (legacy — preserve backwards compat)", async () => {
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=p1&eventType=Notification&kind=claude",
      );
      expect(res.status).toBe(200);
      expect(relayFn).toHaveBeenCalledWith({
        type: "Notification",
        status: "requires_input",
        paneId: "p1",
        sessionId: null,
        agentKind: "claude",
      });
    });

    it("does not affect non-Notification events with notificationKind present (safety)", async () => {
      // A hypothetical weird request that has notificationKind but eventType=Stop should
      // still be relayed normally — the gate is specific to Notification events.
      const res = await httpGet(
        server.hookPort,
        "/hook/event?paneId=p1&eventType=Stop&kind=claude&notificationKind=some_value",
      );
      expect(res.status).toBe(200);
      expect(relayFn).toHaveBeenCalledWith({
        type: "Stop",
        status: "responded",
        paneId: "p1",
        sessionId: null,
        agentKind: "claude",
      });
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

    await httpGet(server.hookPort, "/hook/event?paneId=p1&eventType=Stop&kind=claude");
    await httpGet(server.hookPort, "/hook/event?paneId=p2&eventType=UserPromptSubmit&kind=claude");
    await httpGet(server.hookPort, "/hook/event?paneId=p3&eventType=PreToolUse&kind=claude");

    // relay not yet wired — nothing delivered
    expect(relay).not.toHaveBeenCalled();

    server.setRelay(relay);

    // All three events replayed in order
    expect(relay).toHaveBeenCalledTimes(3);
    const calls = relay.mock.calls.map((c) => (c[0] as AgentHookEvent).type);
    expect(calls).toEqual(["Stop", "UserPromptSubmit", "PreToolUse"]);
  });

  it("delivers post-setRelay events directly without queueing", async () => {
    const relay = vi.fn();
    server.setRelay(relay);

    await httpGet(server.hookPort, "/hook/event?paneId=p1&eventType=Stop&kind=claude");
    await httpGet(server.hookPort, "/hook/event?paneId=p2&eventType=UserPromptSubmit&kind=claude");

    expect(relay).toHaveBeenCalledTimes(2);
    const types = relay.mock.calls.map((c) => (c[0] as AgentHookEvent).type);
    expect(types).toEqual(["Stop", "UserPromptSubmit"]);
  });

  it("replays buffered events then immediately delivers subsequent events", async () => {
    const relay = vi.fn();

    // Queue one event before relay is set
    await httpGet(server.hookPort, "/hook/event?paneId=before&eventType=Stop&kind=claude");

    server.setRelay(relay);

    // Replayed immediately on setRelay
    expect(relay).toHaveBeenCalledTimes(1);
    expect((relay.mock.calls[0][0] as AgentHookEvent).paneId).toBe("before");

    // Post-setRelay event goes straight through
    await httpGet(server.hookPort, "/hook/event?paneId=after&eventType=PreToolUse&kind=claude");
    expect(relay).toHaveBeenCalledTimes(2);
    expect((relay.mock.calls[1][0] as AgentHookEvent).paneId).toBe("after");
  });

  it("caps the queue at MAX_PENDING and drops newest overflow events", async () => {
    const max = AgentHookServer.MAX_PENDING;

    // Fill the queue to the cap. Requests run in parallel for speed — we only
    // care about the final count, not the arrival order within the fill batch.
    const fills: Promise<unknown>[] = [];
    for (let i = 0; i < max; i++) {
      fills.push(httpGet(server.hookPort, `/hook/event?paneId=fill-${i}&eventType=Stop&kind=claude`));
    }
    await Promise.all(fills);

    // Send overflow events sequentially AFTER the queue is known to be full.
    // These must be dropped because the queue is already at capacity.
    await httpGet(server.hookPort, "/hook/event?paneId=overflow-1&eventType=Stop&kind=claude");
    await httpGet(server.hookPort, "/hook/event?paneId=overflow-2&eventType=Stop&kind=claude");

    const relay = vi.fn();
    server.setRelay(relay);

    // Exactly MAX_PENDING calls — the two overflow events were dropped
    expect(relay).toHaveBeenCalledTimes(max);

    // None of the relayed calls should have an overflow paneId
    const paneIds = relay.mock.calls.map((c) => (c[0] as AgentHookEvent).paneId);
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
    expect(Object.keys(settings.hooks)).toHaveLength(12);
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
    expect(Object.keys(settings.hooks)).toHaveLength(12);
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

  it("registers all 12 event types", () => {
    freshConnector().registerHooks(hookScriptPath);

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const expectedEvents = [
      "SessionStart",
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
