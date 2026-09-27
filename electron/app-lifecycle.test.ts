import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  dispatchStreamEvent,
  handleAgentStreamEvent,
  handleStreamEvent,
} from "./app-lifecycle";
import { createAgentStatusDriver } from "./agent-status/driver";
import type { PaneStatusUpdate } from "./agent-status/effects";
import { AgentManager } from "./agent-persistence";
import type { AgentInfo } from "./agent-persistence";
import type { PaneFacts, StreamEvent } from "./terminal-host/types";

// Mock BrowserWindow
const createMockBrowserWindow = () => {
  return {
    webContents: {
      send: vi.fn(),
      isDestroyed: () => false,
      mainFrame: true,
    },
    isDestroyed: () => false,
  } as any;
};

describe("handleStreamEvent", () => {
  let tmpDir: string;
  let agentManager: AgentManager;
  let mockWindow: any;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    agentManager = new AgentManager(tmpDir);
    mockWindow = createMockBrowserWindow();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const broadcastAgent = vi.fn();
  const agentStatus = { signal: vi.fn(), forgetPane: vi.fn() };

  /**
   * What main does with one stream event: the agent side once, then the
   * per-window forwarding (ADR-184).
   */
  function runEvent(event: StreamEvent): void {
    handleAgentStreamEvent(event, {
      agentManager,
      agentStatus: agentStatus as never,
      broadcastAgent,
    });
    handleStreamEvent(event, mockWindow);
  }

  function createAgent(
    overrides: Partial<Omit<AgentInfo, "id" | "createdAt" | "updatedAt" | "activatedAt">> = {},
  ): AgentInfo {
    return agentManager.createAgent({
      agentSessionId: `session-${crypto.randomUUID()}`,
      name: "Test agent",
      status: "active",
      completedAt: null,
      projectId: null,
      projectName: null,
      workspacePath: "/project/main",
      cwd: "/project/main",
      agentKind: "claude",
      agentCommand: "claude",
      paneId: `pane-${crypto.randomUUID()}`,
      lastAgentStatus: null,
      resumedAt: null,
      ...overrides,
    });
  }

  describe("cwd event handling", () => {
    it("updates agent cwd when active agent cwd differs from event cwd", () => {
      const agent = createAgent({ cwd: "/project/main", status: "active" });
      const paneId = agent.paneId!;

      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main/src",
      };

      runEvent(event);

      // Verify webContents.send was called with the cwd event
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-cwd-${paneId}`,
        "/project/main/src",
      );

      // Verify agent was updated in agentManager
      const updated = agentManager.getAgentByPaneId(paneId);
      expect(updated).not.toBeNull();
      expect(updated!.cwd).toBe("/project/main/src");

      // Verify the agent update was broadcast (once, not per window)
      expect(broadcastAgent).toHaveBeenCalledTimes(1);
      expect(broadcastAgent.mock.calls[0][0].cwd).toBe("/project/main/src");
    });

    it("does not update agent when cwd matches existing agent cwd", () => {
      const agent = createAgent({ cwd: "/project/main", status: "active" });
      const paneId = agent.paneId!;

      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main",
      };

      runEvent(event);

      // Verify webContents.send was called with the cwd event
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-cwd-${paneId}`,
        "/project/main",
      );

      // Verify agent-updated broadcast was NOT sent (no change)
      expect(broadcastAgent).not.toHaveBeenCalled();
    });

    it("does not update a completed agent", () => {
      const agent = createAgent({ cwd: "/project/main", status: "completed" });
      const paneId = agent.paneId!;

      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main/src",
      };

      runEvent(event);

      // Verify webContents.send was called with the cwd event to renderer
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-cwd-${paneId}`,
        "/project/main/src",
      );

      // Verify agent was NOT updated
      const updated = agentManager.getAgentByPaneId(paneId);
      expect(updated!.cwd).toBe("/project/main");

      // Verify agent-updated broadcast was NOT sent
      expect(broadcastAgent).not.toHaveBeenCalled();
    });

    it("does not update agent when there is no agent for the paneId", () => {
      const nonExistentPaneId = `pane-${crypto.randomUUID()}`;

      const event: StreamEvent = {
        type: "cwd",
        sessionId: nonExistentPaneId,
        cwd: "/project/main/src",
      };

      runEvent(event);

      // Verify webContents.send was called with the cwd event to renderer
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-cwd-${nonExistentPaneId}`,
        "/project/main/src",
      );

      // Verify agent-updated broadcast was NOT sent
      expect(broadcastAgent).not.toHaveBeenCalled();
    });

    it("forwards data events to renderer", () => {
      const paneId = `pane-${crypto.randomUUID()}`;

      const event: StreamEvent = {
        type: "data",
        sessionId: paneId,
        data: "hello",
        seq: 7,
      };

      runEvent(event);

      // The seq rides along so the renderer can drop output a warm-restore
      // snapshot already covers (ADR-159).
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-output-${paneId}`,
        "hello",
        7,
      );
    });

    it("forwards data from a daemon that sends no seq", () => {
      const paneId = `pane-${crypto.randomUUID()}`;

      // An older daemon predates ADR-159 and omits the field entirely.
      const event: StreamEvent = {
        type: "data",
        sessionId: paneId,
        data: "hello",
      };

      runEvent(event);

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-output-${paneId}`,
        "hello",
        undefined,
      );
    });

    it("forwards exit events to renderer", () => {
      const paneId = `pane-${crypto.randomUUID()}`;

      const event: StreamEvent = {
        type: "exit",
        sessionId: paneId,
        exitCode: 0,
      };

      runEvent(event);

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-exit-${paneId}`,
      );
    });

    it("forwards error events to renderer", () => {
      const paneId = `pane-${crypto.randomUUID()}`;

      const event: StreamEvent = {
        type: "error",
        sessionId: paneId,
        message: "test error",
      };

      runEvent(event);

      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        `pty-error-${paneId}`,
        "test error",
      );
    });
  });

  describe("error handling", () => {
    it("handles errors from webContents.send gracefully", () => {
      const agent = createAgent({ cwd: "/project/main", status: "active" });
      const paneId = agent.paneId!;

      let callCount = 0;
      mockWindow.webContents.send = vi.fn(() => {
        callCount++;
        // Throw on the pty-cwd forward: the agent side already ran
        if (callCount === 1) {
          throw new Error("Render frame was disposed");
        }
      });

      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main/src",
      };

      // Should not throw
      expect(() => {
        runEvent(event);
      }).not.toThrow();

      // Agent should still be updated
      const updated = agentManager.getAgentByPaneId(paneId);
      expect(updated!.cwd).toBe("/project/main/src");
    });

    it("logs non-disposed errors", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockWindow.webContents.send = vi.fn(() => {
        throw new Error("Some other error");
      });

      const paneId = `pane-${crypto.randomUUID()}`;
      const event: StreamEvent = {
        type: "data",
        sessionId: paneId,
        data: "test",
      };

      runEvent(event);

      expect(errorSpy).toHaveBeenCalledWith(
        "Error in stream event handler:",
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });
  });

  describe("integration with agentManager updates", () => {
    it("persists cwd change across save/load cycles", async () => {
      const agent = createAgent({ cwd: "/project/main", status: "active" });
      const paneId = agent.paneId!;

      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main/nested/dir",
      };

      runEvent(event);

      // Wait for debounced save
      await new Promise((r) => setTimeout(r, 600));

      // Create fresh manager and verify persistence
      const freshManager = new AgentManager(tmpDir);
      const loaded = freshManager.getAgentByPaneId(paneId);
      expect(loaded).not.toBeNull();
      expect(loaded!.cwd).toBe("/project/main/nested/dir");
    });
  });

  describe("agent side effects (ADR-184)", () => {
    const facts = (title: string | null): PaneFacts => ({
      foreground: { name: "claude", kind: "claude" },
      title,
      outputHint: null,
    });

    it("feeds paneFacts to the reconciler once and does not forward them", () => {
      const paneId = `pane-${crypto.randomUUID()}`;
      const event: StreamEvent = { type: "paneFacts", sessionId: paneId, facts: facts(null) };

      runEvent(event);

      expect(agentStatus.signal).toHaveBeenCalledTimes(1);
      expect(agentStatus.signal).toHaveBeenCalledWith(paneId, {
        type: "paneFacts",
        facts: event.facts,
      });
      expect(mockWindow.webContents.send).not.toHaveBeenCalled();
    });

    it("renames the pane's agent from the facts' title", () => {
      const agent = createAgent({ name: null });
      runEvent({ type: "paneFacts", sessionId: agent.paneId!, facts: facts("⠋ Fix the bug") });

      expect(agentManager.getAgentByPaneId(agent.paneId!)!.name).toBe("Fix the bug");
      expect(broadcastAgent).toHaveBeenCalledTimes(1);
    });

    it("does not rename an agent whose name the user pinned", () => {
      const agent = createAgent({ name: "Mine", namePinned: true });
      runEvent({ type: "paneFacts", sessionId: agent.paneId!, facts: facts("Other title") });

      expect(agentManager.getAgentByPaneId(agent.paneId!)!.name).toBe("Mine");
      expect(broadcastAgent).not.toHaveBeenCalled();
    });

    it("drops the pane's reconciler state when its pty exits", () => {
      const paneId = `pane-${crypto.randomUUID()}`;
      runEvent({ type: "exit", sessionId: paneId, exitCode: 0 });
      expect(agentStatus.forgetPane).toHaveBeenCalledWith(paneId);
    });
  });

  describe("dispatchStreamEvent with two windows (ADR-184)", () => {
    it("applies one signal's effects once, however many windows are open", () => {
      const agent = createAgent({ status: "active", lastAgentStatus: "working" });
      const paneId = agent.paneId!;
      const published: PaneStatusUpdate[] = [];
      const notify = vi.fn();
      const driver = createAgentStatusDriver({
        agentManager,
        getPaneContext: () => undefined,
        unseenRespondedAgents: new Set(),
        unseenInputAgents: new Set(),
        broadcastAgent,
        maybeSendNotification: notify,
        publishPaneStatus: (update) => published.push(update),
        log: () => {},
      });
      // The pane's root is mid-turn (a hook claimed it).
      driver.hook({
        type: "PreToolUse",
        status: "working",
        paneId,
        sessionId: agent.agentSessionId,
        agentKind: "claude",
        agentId: null,
      });
      published.length = 0;
      broadcastAgent.mockClear();
      notify.mockClear();

      const windows = [createMockBrowserWindow(), createMockBrowserWindow()];
      const deps = { agentManager, agentStatus: driver, broadcastAgent };
      // The agent process exits: facts say so.
      dispatchStreamEvent(
        {
          type: "paneFacts",
          sessionId: paneId,
          facts: { foreground: null, title: null, outputHint: null },
        },
        windows,
        deps,
      );

      expect(published).toEqual([
        { paneId, status: "idle", reason: "agent process exited", kind: null },
      ]);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(broadcastAgent).toHaveBeenCalledTimes(1);
      expect(agentManager.getAgentByPaneId(paneId)!.lastAgentStatus).toBe("responded");
      for (const win of windows) expect(win.webContents.send).not.toHaveBeenCalled();

      // Pane channels still go to every window.
      dispatchStreamEvent({ type: "cwd", sessionId: paneId, cwd: "/elsewhere" }, windows, deps);
      for (const win of windows) {
        expect(win.webContents.send).toHaveBeenCalledWith(`pty-cwd-${paneId}`, "/elsewhere");
      }
      expect(broadcastAgent).toHaveBeenCalledTimes(2); // the cwd update, once
    });
  });
});
