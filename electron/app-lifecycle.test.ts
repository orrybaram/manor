import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { handleStreamEvent } from "./app-lifecycle";
import { AgentManager } from "./agent-persistence";
import { PreferencesManager } from "./preferences";
import type { AgentInfo } from "./agent-persistence";
import type { StreamEvent } from "./terminal-host/types";
import {
  addRendererBroadcastSink,
  type RendererBroadcast,
} from "./renderer-broadcast";

describe("handleStreamEvent", () => {
  let tmpDir: string;
  let agentManager: AgentManager;
  let preferencesManager: PreferencesManager;
  let frames: RendererBroadcast[];
  let stopSink: () => void;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    agentManager = new AgentManager(tmpDir);
    preferencesManager = new PreferencesManager(tmpDir);
    // `sendAgentUpdate` only publishes to the bridge now (ADR-180 ticket 9),
    // which reaches every window and every browser alike — there is no
    // `webContents.send` left to inspect, so `handleStreamEvent` is called
    // with a `null` window and the broadcast sink is what these tests watch.
    frames = [];
    stopSink = addRendererBroadcastSink((frame) => frames.push(frame));
  });

  afterEach(() => {
    stopSink();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function agentUpdatedFrames(): RendererBroadcast[] {
    return frames.filter((f) => f.ns === "agents" && f.event === "updated");
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

      handleStreamEvent(event, null, agentManager, preferencesManager);

      // Verify agent was updated in agentManager
      const updated = agentManager.getAgentByPaneId(paneId);
      expect(updated).not.toBeNull();
      expect(updated!.cwd).toBe("/project/main/src");

      // Verify an agents.updated broadcast was sent
      const calls = agentUpdatedFrames();
      expect(calls.length).toBe(1);
      expect((calls[0].args[0] as AgentInfo).cwd).toBe("/project/main/src");
    });

    it("does not update agent when cwd matches existing agent cwd", () => {
      const agent = createAgent({ cwd: "/project/main", status: "active" });
      const paneId = agent.paneId!;

      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main",
      };

      handleStreamEvent(event, null, agentManager, preferencesManager);

      // Verify an agents.updated broadcast was NOT sent (no change)
      expect(agentUpdatedFrames().length).toBe(0);
    });

    it("does not update a completed agent", () => {
      const agent = createAgent({ cwd: "/project/main", status: "completed" });
      const paneId = agent.paneId!;

      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main/src",
      };

      handleStreamEvent(event, null, agentManager, preferencesManager);

      // Verify agent was NOT updated
      const updated = agentManager.getAgentByPaneId(paneId);
      expect(updated!.cwd).toBe("/project/main");

      // Verify an agents.updated broadcast was NOT sent
      expect(agentUpdatedFrames().length).toBe(0);
    });

    it("does not update agent when there is no agent for the paneId", () => {
      const nonExistentPaneId = `pane-${crypto.randomUUID()}`;

      const event: StreamEvent = {
        type: "cwd",
        sessionId: nonExistentPaneId,
        cwd: "/project/main/src",
      };

      handleStreamEvent(event, null, agentManager, preferencesManager);

      // Verify an agents.updated broadcast was NOT sent
      expect(agentUpdatedFrames().length).toBe(0);
    });

    /**
     * ADR-180 ticket 5. Output, exit, resize, cwd, agent status and error
     * used to leave here on `pty-${kind}-${paneId}` channels, one send per
     * live window whether or not it had the pane. They are bridge event
     * frames now — `BridgeServer.handleStreamEvent` publishes them keyed by
     * paneId, to windows and devices alike — and a channel left behind here
     * would be a second, unfiltered copy of the hottest path in the app.
     */
    it("sends nothing per-pane: the bridge is the only producer", () => {
      const paneId = `pane-${crypto.randomUUID()}`;
      const events: StreamEvent[] = [
        { type: "data", sessionId: paneId, data: "hello", seq: 7 },
        { type: "exit", sessionId: paneId, exitCode: 0 },
        { type: "resized", sessionId: paneId, cols: 100, rows: 30 },
        { type: "error", sessionId: paneId, message: "test error" },
      ];

      for (const event of events) {
        handleStreamEvent(event, null, agentManager, preferencesManager);
      }

      expect(frames.length).toBe(0);
    });
  });

  describe("error handling", () => {
    it("logs non-disposed errors", () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // From the bookkeeping rather than from a send: what is left in here is
      // the agent lookup, so that is what is made to fail.
      vi.spyOn(agentManager, "getAgentByPaneId").mockImplementation(() => {
        throw new Error("Some other error");
      });

      const paneId = `pane-${crypto.randomUUID()}`;
      const event: StreamEvent = {
        type: "cwd",
        sessionId: paneId,
        cwd: "/project/main/src",
      };

      handleStreamEvent(event, null, agentManager, preferencesManager);

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

      handleStreamEvent(event, null, agentManager, preferencesManager);

      // Wait for debounced save
      await new Promise((r) => setTimeout(r, 600));

      // Create fresh manager and verify persistence
      const freshManager = new AgentManager(tmpDir);
      const loaded = freshManager.getAgentByPaneId(paneId);
      expect(loaded).not.toBeNull();
      expect(loaded!.cwd).toBe("/project/main/nested/dir");
    });
  });
});
