/**
 * ADR-136 §"Change 3" — main is the source of truth for unseen flags.
 *
 * No `ipcMain` here any more: `agents` crossed to the handler table in
 * ADR-180 ticket 9, so these are plain functions over `HostDeps` — the same
 * functions the table calls, and a paired `full` device now reaches them the
 * same way the desktop does (ADR-180's watch-for: a browser marking an agent
 * seen must produce the same `agents.updated` broadcast a desktop window
 * does).
 *
 * Verifies:
 *   - `agentsGetUnseen` returns the unseen Sets in deps (renderer uses this
 *     to prime its cache on boot).
 *   - `agentsMarkSeen` mutates the unseen Sets AND re-broadcasts the agent,
 *     so the renderer cache stays in sync.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../notifications", () => ({
  updateDockBadge: vi.fn(),
  markAgentNotificationsRead: vi.fn(),
  sendAgentUpdate: vi.fn(),
}));

vi.mock("../ipc-validate", () => ({
  assertString: vi.fn(),
}));

import * as notifications from "../notifications";
import { agentsMarkSeen } from "../bridge/handlers/agents";
import { agentsGetUnseen } from "../bridge/handlers/agents-read";
import { localCtx } from "../bridge/method";

const sendAgentUpdate = vi.mocked(notifications.sendAgentUpdate);
const updateDockBadge = vi.mocked(notifications.updateDockBadge);
const markAgentNotificationsRead = vi.mocked(
  notifications.markAgentNotificationsRead,
);

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    agentManager: {
      getAllAgents: vi.fn().mockReturnValue([]),
      getActiveAgents: vi.fn().mockReturnValue([]),
      getLastPruneCount: vi.fn().mockReturnValue(0),
      updateAgent: vi.fn(),
      getAgentById: vi.fn().mockReturnValue(null),
      getAgentByPaneId: vi.fn().mockReturnValue(null),
      deleteAgent: vi.fn(),
    },
    backend: {
      pty: { listSessions: vi.fn().mockResolvedValue([]) },
    },
    mainWindow: null,
    preferencesManager: { get: vi.fn().mockReturnValue(false), set: vi.fn() },
    paneContextMap: new Map(),
    unseenRespondedAgents: new Set<string>(),
    unseenInputAgents: new Set<string>(),
    ...overrides,
  };
}

describe("agents.getUnseen (ADR-136)", () => {
  // Main's Sets, read from deps: the same Sets the driver and `markSeen`
  // write, whichever table (desktop or host server) answers.
  it("returns the unseen Sets' contents", () => {
    const deps = makeDeps({
      unseenRespondedAgents: new Set(["t1", "t2"]),
      unseenInputAgents: new Set(["t3"]),
    });
    expect(agentsGetUnseen(localCtx(deps as never))).toEqual({
      responded: ["t1", "t2"],
      requires_input: ["t3"],
    });
  });
});

describe("agents.markSeen re-broadcast (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    sendAgentUpdate.mockClear();
    updateDockBadge.mockClear();
    markAgentNotificationsRead.mockClear();
    deps = makeDeps({
      unseenRespondedAgents: new Set<string>(["t1"]),
      unseenInputAgents: new Set<string>(["t1"]),
    });
  });

  it("clears both Sets and re-broadcasts the agent with fresh flags", () => {
    const agent = { id: "t1", lastAgentStatus: "responded" };
    deps.agentManager.getAgentById.mockReturnValue(agent);

    agentsMarkSeen(localCtx(deps as never), "t1");

    expect(deps.unseenRespondedAgents.has("t1")).toBe(false);
    expect(deps.unseenInputAgents.has("t1")).toBe(false);
    expect(sendAgentUpdate).toHaveBeenCalledTimes(1);
    expect(sendAgentUpdate).toHaveBeenCalledWith(
      agent,
      deps.preferencesManager,
    );
  });

  it("reads the log entries about an agent the user is now looking at", () => {
    deps.agentManager.getAgentById.mockReturnValue({
      id: "t1",
      lastAgentStatus: "responded",
    });

    agentsMarkSeen(localCtx(deps as never), "t1");

    expect(markAgentNotificationsRead).toHaveBeenCalledWith("t1");
  });

  it("falls back to dock-badge refresh when the agent no longer exists", () => {
    deps.agentManager.getAgentById.mockReturnValue(null);

    agentsMarkSeen(localCtx(deps as never), "t1");

    expect(deps.unseenRespondedAgents.has("t1")).toBe(false);
    expect(sendAgentUpdate).not.toHaveBeenCalled();
    expect(updateDockBadge).toHaveBeenCalled();
  });
});
