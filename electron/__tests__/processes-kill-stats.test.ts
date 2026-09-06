import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock electron ──────────────────────────────────────────────────────────────
const handlers: Map<string, (...args: unknown[]) => unknown> = new Map();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

// ── Mock ipc-validate ──────────────────────────────────────────────────────────
vi.mock("../ipc-validate", () => ({
  assertString: vi.fn(),
}));

// ── Mock portless (imported for its side effect / proxy port) ───────────────────
vi.mock("../portless", () => ({
  portlessManager: { proxyPort: null, restart: vi.fn() },
}));

import { register } from "../ipc/processes";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    backend: {
      pty: {
        listSessions: vi.fn().mockResolvedValue([]),
        kill: vi.fn().mockResolvedValue(undefined),
      },
      ports: {
        kill: vi.fn().mockResolvedValue(undefined),
      },
    },
    portScanner: {
      scanNow: vi.fn().mockResolvedValue([]),
    },
    agentHookServer: { hookPort: null },
    webviewServer: { serverPort: null },
    agentManager: {
      getAgentByPaneId: vi.fn().mockReturnValue(null),
    },
    statsStore: {
      record: vi.fn(),
    },
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("processes:killSession / processes:killAll stats", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  describe("processes:killSession", () => {
    it("records a kill for an active agent last seen thinking/working/requires_input", async () => {
      deps.agentManager.getAgentByPaneId.mockReturnValue({
        id: "t1",
        status: "active",
        lastAgentStatus: "thinking",
      });

      const handler = handlers.get("processes:killSession")!;
      await handler({} as never, "session-1");

      expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
      expect(deps.statsStore.record).toHaveBeenCalledWith("agentsKilled");
      expect(deps.backend.pty.kill).toHaveBeenCalledWith("session-1");
    });

    it("does not record a kill when no agent is found for the pane", async () => {
      deps.agentManager.getAgentByPaneId.mockReturnValue(null);

      const handler = handlers.get("processes:killSession")!;
      await handler({} as never, "session-1");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });

    it("does not record a kill for an agent that already responded", async () => {
      deps.agentManager.getAgentByPaneId.mockReturnValue({
        id: "t1",
        status: "active",
        lastAgentStatus: "responded",
      });

      const handler = handlers.get("processes:killSession")!;
      await handler({} as never, "session-1");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });
  });

  describe("processes:killAll", () => {
    it("records once per active session being killed", async () => {
      deps.backend.pty.listSessions.mockResolvedValue([
        { sessionId: "s1" },
        { sessionId: "s2" },
        { sessionId: "s3" },
      ]);
      deps.agentManager.getAgentByPaneId.mockImplementation((paneId: string) => {
        if (paneId === "s1") return { id: "a1", status: "active", lastAgentStatus: "working" };
        if (paneId === "s2") return { id: "a2", status: "active", lastAgentStatus: "responded" };
        return null;
      });

      const handler = handlers.get("processes:killAll")!;
      await handler({} as never);

      expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
      expect(deps.statsStore.record).toHaveBeenCalledWith("agentsKilled");
      expect(deps.backend.pty.kill).toHaveBeenCalledTimes(3);
    });
  });
});
