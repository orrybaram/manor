import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { dispatchStreamEvent } from "./app-lifecycle";
import { createAgentStatusDriver } from "./agent-status/driver";
import type { PaneStatusUpdate } from "./agent-status/effects";
import { AgentManager } from "./agent-persistence";
import type { AgentInfo } from "./agent-persistence";
import type { PaneFacts, StreamEvent } from "./terminal-host/types";

describe("dispatchStreamEvent", () => {
  let tmpDir: string;
  let agentManager: AgentManager;
  /**
   * The bridge's `handleStreamEvent` (ADR-180 D5): the one consumer that
   * forwards a pane's events, to windows and devices alike. There is no
   * `webContents.send` left in main's stream path to inspect.
   */
  let forward: Mock<(event: StreamEvent) => void>;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    agentManager = new AgentManager(tmpDir);
    forward = vi.fn<(event: StreamEvent) => void>();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const broadcastAgent = vi.fn();
  const agentStatus = { signal: vi.fn(), forgetPane: vi.fn() };

  /**
   * What main does with one stream event: the agent side once, then the
   * bridge forward once (ADR-184, ADR-180 D5).
   */
  function runEvent(event: StreamEvent): void {
    dispatchStreamEvent(
      event,
      { agentManager, agentStatus: agentStatus as never, broadcastAgent },
      forward,
    );
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
      transcriptPath: null,
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

      // The pane's cwd event is forwarded to the bridge, once
      expect(forward).toHaveBeenCalledWith(event);

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

      // The pane's cwd event is forwarded to the bridge, once
      expect(forward).toHaveBeenCalledWith(event);

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

      // The pane's cwd event is forwarded to the bridge, once
      expect(forward).toHaveBeenCalledWith(event);

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

      // The pane's cwd event is forwarded to the bridge, once
      expect(forward).toHaveBeenCalledWith(event);

      // Verify agent-updated broadcast was NOT sent
      expect(broadcastAgent).not.toHaveBeenCalled();
    });

    /**
     * ADR-180 ticket 5. Output, exit, resize and error used to leave main on
     * `pty-${kind}-${paneId}` channels, one send per live window whether or
     * not it had the pane. They are bridge event frames now —
     * `BridgeServer.handleStreamEvent` publishes them keyed by paneId, to
     * windows and devices alike — so each event is handed to the bridge
     * exactly once, unchanged (the `seq` included, ADR-159).
     */
    it("forwards every pane event to the bridge once, unchanged", () => {
      const paneId = `pane-${crypto.randomUUID()}`;
      const events: StreamEvent[] = [
        { type: "data", sessionId: paneId, data: "hello", seq: 7 },
        // An older daemon predates ADR-159 and omits the seq entirely.
        { type: "data", sessionId: paneId, data: "hello" },
        { type: "exit", sessionId: paneId, exitCode: 0 },
        { type: "resized", sessionId: paneId, cols: 100, rows: 30 },
        { type: "error", sessionId: paneId, message: "test error" },
      ];

      for (const event of events) runEvent(event);

      expect(forward.mock.calls.map(([e]) => e)).toEqual(events);
    });
  });

  describe("error handling", () => {
    it("a failing forward does not undo the agent side", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const agent = createAgent({ cwd: "/project/main", status: "active" });
      const paneId = agent.paneId!;
      forward.mockImplementation(() => {
        throw new Error("Render frame was disposed");
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
      expect(errorSpy).toHaveBeenCalledWith(
        "Error forwarding stream event:",
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });

    it("logs errors from the agent side", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      vi.spyOn(agentManager, "getAgentByPaneId").mockImplementation(() => {
        throw new Error("Some other error");
      });

      const paneId = `pane-${crypto.randomUUID()}`;
      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main/src",
      };

      runEvent(event);

      expect(errorSpy).toHaveBeenCalledWith(
        "Error in agent stream event handler:",
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
      expect(forward).not.toHaveBeenCalled();
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

  describe("dispatchStreamEvent, once per event (ADR-184, ADR-180 D5)", () => {
    it("applies one signal's effects once and forwards pane events once", () => {
      const agent = createAgent({ status: "active", lastAgentStatus: "working" });
      const paneId = agent.paneId!;
      const published: PaneStatusUpdate[] = [];
      const notify = vi.fn();
      const driver = createAgentStatusDriver({
        agentManager,
        getPaneContext: () => undefined,
        getPaneHostId: () => undefined,
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
        transcriptPath: null,
      });
      published.length = 0;
      broadcastAgent.mockClear();
      notify.mockClear();

      const deps = { agentManager, agentStatus: driver, broadcastAgent };
      // The agent process exits: facts say so.
      dispatchStreamEvent(
        {
          type: "paneFacts",
          sessionId: paneId,
          facts: { foreground: null, title: null, outputHint: null },
        },
        deps,
        forward,
      );

      expect(published).toEqual([
        { paneId, status: "idle", reason: "agent process exited", kind: null },
      ]);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(broadcastAgent).toHaveBeenCalledTimes(1);
      expect(agentManager.getAgentByPaneId(paneId)!.lastAgentStatus).toBe("responded");
      expect(forward).not.toHaveBeenCalled();

      // Pane events still reach the bridge, which serves every renderer.
      const cwd: StreamEvent = { type: "cwd", sessionId: paneId, cwd: "/elsewhere" };
      dispatchStreamEvent(cwd, deps, forward);
      expect(forward).toHaveBeenCalledTimes(1);
      expect(forward).toHaveBeenCalledWith(cwd);
      expect(broadcastAgent).toHaveBeenCalledTimes(2); // the cwd update, once
    });
  });
});
