import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as http from "node:http";
import { AgentHookServer, mapEventToStatus } from "../agent-hooks";

// ── Helpers ──

function makeMockWindow(overrides: {
  isDestroyed?: boolean;
  webContentsIsDestroyed?: boolean;
} = {}) {
  return {
    isDestroyed: () => overrides.isDestroyed ?? false,
    webContents: {
      isDestroyed: () => overrides.webContentsIsDestroyed ?? false,
      send: vi.fn(),
    },
  } as unknown as import("electron").BrowserWindow;
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
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
  it("maps UserPromptSubmit to running", () => {
    expect(mapEventToStatus("UserPromptSubmit")).toBe("running");
  });

  it("maps PostToolUse to running", () => {
    expect(mapEventToStatus("PostToolUse")).toBe("running");
  });

  it("maps PostToolUseFailure to running", () => {
    expect(mapEventToStatus("PostToolUseFailure")).toBe("running");
  });

  it("maps Stop to waiting", () => {
    expect(mapEventToStatus("Stop")).toBe("waiting");
  });

  it("maps PermissionRequest to waiting", () => {
    expect(mapEventToStatus("PermissionRequest")).toBe("waiting");
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
  let mockWindow: ReturnType<typeof makeMockWindow>;

  beforeEach(async () => {
    server = new AgentHookServer();
    mockWindow = makeMockWindow();
    await server.start(mockWindow);
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

      await expect(httpGet(port, "/hook/event?paneId=a&eventType=Stop")).rejects.toThrow();
    });

    it("supports multiple start/stop cycles", async () => {
      server.stop();

      const win = makeMockWindow();
      await server.start(win);
      expect(server.hookPort).toBeGreaterThan(0);

      server.stop();

      await server.start(win);
      expect(server.hookPort).toBeGreaterThan(0);
    });
  });

  describe("HTTP request handling", () => {
    it("returns 200 for valid request", async () => {
      const res = await httpGet(server.hookPort, "/hook/event?paneId=abc&eventType=UserPromptSubmit");
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

    it("returns 200 for valid request with unknown eventType (accepted but no IPC)", async () => {
      const res = await httpGet(server.hookPort, "/hook/event?paneId=abc&eventType=UnknownThing");
      expect(res.status).toBe(200);
      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe("IPC delivery to renderer", () => {
    it("sends correct message shape for a valid event", async () => {
      const before = Date.now();
      await httpGet(server.hookPort, "/hook/event?paneId=abc&eventType=Stop");

      expect(mockWindow.webContents.send).toHaveBeenCalledTimes(1);
      const [channel, payload] = mockWindow.webContents.send.mock.calls[0];
      expect(channel).toBe("pty-agent-status-abc");
      expect(payload).toMatchObject({
        kind: "claude",
        status: "waiting",
        processName: "claude",
      });
      expect(payload.since).toBeGreaterThanOrEqual(before);
      expect(payload.since).toBeLessThanOrEqual(Date.now());
    });

    it("sends to the correct channel per paneId", async () => {
      await httpGet(server.hookPort, "/hook/event?paneId=pane-1&eventType=Stop");
      await httpGet(server.hookPort, "/hook/event?paneId=pane-2&eventType=UserPromptSubmit");

      expect(mockWindow.webContents.send).toHaveBeenCalledTimes(2);
      expect(mockWindow.webContents.send.mock.calls[0][0]).toBe("pty-agent-status-pane-1");
      expect(mockWindow.webContents.send.mock.calls[1][0]).toBe("pty-agent-status-pane-2");
    });

    it("paneId isolation: event for pane-1 does not send to pane-2", async () => {
      await httpGet(server.hookPort, "/hook/event?paneId=pane-1&eventType=Stop");

      expect(mockWindow.webContents.send).toHaveBeenCalledTimes(1);
      const channel = mockWindow.webContents.send.mock.calls[0][0];
      expect(channel).toBe("pty-agent-status-pane-1");
      expect(channel).not.toContain("pane-2");
    });

    it("does not throw when mainWindow is null", async () => {
      server.stop();

      const nullServer = new AgentHookServer();
      // Start with a real window then set it to null by stopping and restarting differently
      // Actually, we test this by creating a server where the window gets destroyed
      const win = makeMockWindow({ isDestroyed: true });
      await nullServer.start(win);

      const res = await httpGet(nullServer.hookPort, "/hook/event?paneId=abc&eventType=Stop");
      expect(res.status).toBe(200);
      expect(win.webContents.send).not.toHaveBeenCalled();

      nullServer.stop();
    });

    it("does not throw when mainWindow.isDestroyed() returns true", async () => {
      server.stop();

      const destroyedWin = makeMockWindow({ isDestroyed: true });
      const s = new AgentHookServer();
      await s.start(destroyedWin);

      const res = await httpGet(s.hookPort, "/hook/event?paneId=abc&eventType=UserPromptSubmit");
      expect(res.status).toBe(200);
      expect(destroyedWin.webContents.send).not.toHaveBeenCalled();

      s.stop();
    });

    it("does not throw when webContents.isDestroyed() returns true", async () => {
      server.stop();

      const destroyedWC = makeMockWindow({ webContentsIsDestroyed: true });
      const s = new AgentHookServer();
      await s.start(destroyedWC);

      const res = await httpGet(s.hookPort, "/hook/event?paneId=abc&eventType=UserPromptSubmit");
      expect(res.status).toBe(200);
      expect(destroyedWC.webContents.send).not.toHaveBeenCalled();

      s.stop();
    });
  });
});

describe("registerClaudeHooks", () => {
  let tmpDir: string;
  let settingsPath: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-hooks-test-${crypto.randomUUID()}`);
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    settingsPath = path.join(tmpDir, ".claude", "settings.json");
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Re-import to pick up the changed HOME env
  async function freshImport() {
    // Clear module cache to pick up new HOME
    const mod = await import(`../agent-hooks?t=${Date.now()}-${crypto.randomUUID()}`);
    return mod;
  }

  it("creates hooks when settings file does not exist", async () => {
    const { registerClaudeHooks } = await freshImport();
    registerClaudeHooks();

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
    expect(Object.keys(settings.hooks)).toHaveLength(5);
  });

  it("creates hooks when file exists but has no hooks key", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ someKey: "value" }));
    const { registerClaudeHooks } = await freshImport();
    registerClaudeHooks();

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
    expect(settings.someKey).toBe("value");
  });

  it("adds missing hooks when some already registered", async () => {
    const hookScriptPath = path.join(tmpDir, ".manor", "hooks", "notify.sh");
    const partial = {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: hookScriptPath }] }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(partial));
    const { registerClaudeHooks } = await freshImport();
    registerClaudeHooks();

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(Object.keys(settings.hooks)).toHaveLength(5);
    // Stop should still have exactly 1 entry (not duplicated)
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("does NOT duplicate hooks already present (idempotent)", async () => {
    const { registerClaudeHooks } = await freshImport();
    registerClaudeHooks();
    registerClaudeHooks();

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    for (const key of Object.keys(settings.hooks)) {
      expect(settings.hooks[key]).toHaveLength(1);
    }
  });

  it("preserves unrelated settings keys", async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark", foo: 42 }));
    const { registerClaudeHooks } = await freshImport();
    registerClaudeHooks();

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.theme).toBe("dark");
    expect(settings.foo).toBe(42);
  });

  it("handles invalid JSON gracefully (overwrites)", async () => {
    fs.writeFileSync(settingsPath, "not valid json {{{");
    const { registerClaudeHooks } = await freshImport();
    registerClaudeHooks();

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
  });

  it("registers all 5 event types", async () => {
    const { registerClaudeHooks } = await freshImport();
    registerClaudeHooks();

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const expectedEvents = ["UserPromptSubmit", "Stop", "PostToolUse", "PostToolUseFailure", "PermissionRequest"];
    for (const event of expectedEvents) {
      expect(settings.hooks[event]).toBeDefined();
      expect(settings.hooks[event]).toHaveLength(1);
    }
  });

  it("each hook entry points to HOOK_SCRIPT_PATH", async () => {
    const { registerClaudeHooks } = await freshImport();
    registerClaudeHooks();

    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const hookScriptPath = path.join(tmpDir, ".manor", "hooks", "notify.sh");
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
    tmpDir = path.join(os.tmpdir(), `manor-hookscript-test-${crypto.randomUUID()}`);
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function freshImport() {
    const mod = await import(`../agent-hooks?t=${Date.now()}-${crypto.randomUUID()}`);
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

  it("script contains curl command to MANOR_HOOK_PORT", async () => {
    const { ensureHookScript } = await freshImport();
    ensureHookScript();

    const scriptPath = path.join(tmpDir, ".manor", "hooks", "notify.sh");
    const content = fs.readFileSync(scriptPath, "utf-8");
    expect(content).toContain("curl");
    expect(content).toContain("MANOR_HOOK_PORT");
    expect(content).toContain("#!/bin/bash");
  });
});
