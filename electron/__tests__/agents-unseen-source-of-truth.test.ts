/**
 * ADR-136 §"Change 3" — main is the source of truth for unseen flags.
 *
 * Verifies:
 *   - `agents:getUnseen` returns the snapshot helper's output verbatim
 *     (renderer uses this to prime its cache on boot).
 *   - `agents:markSeen` mutates the unseen Sets AND re-broadcasts the agent,
 *     so the renderer cache stays in sync.
 */

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

// ── Mock notifications ─────────────────────────────────────────────────────────
// vi.mock is hoisted; we declare the mocked module inline and grab the fns
// via the imported module reference below.
vi.mock("../notifications", () => ({
  updateDockBadge: vi.fn(),
  markAgentNotificationsRead: vi.fn(),
  sendAgentUpdate: vi.fn(),
  getUnseenSnapshot: vi.fn(() => ({
    responded: ["t1", "t2"],
    requires_input: ["t3"],
  })),
}));

vi.mock("../ipc-validate", () => ({
  assertString: vi.fn(),
}));

import * as notifications from "../notifications";
import { register } from "../ipc/agents";

const sendAgentUpdate = vi.mocked(notifications.sendAgentUpdate);
const updateDockBadge = vi.mocked(notifications.updateDockBadge);
const getUnseenSnapshot = vi.mocked(notifications.getUnseenSnapshot);
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
      // `agents:markSeen` looks the agent up by id (ADR-138 swapped the old
      // `getAllAgents().find(…)` scan for the id index). Default to "gone".
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

describe("agents:getUnseen (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    sendAgentUpdate.mockClear();
    updateDockBadge.mockClear();
    deps = makeDeps();
    register(deps as never);
  });

  it("returns the snapshot helper's output verbatim", async () => {
    const handler = handlers.get("agents:getUnseen")!;
    expect(handler).toBeDefined();
    const result = await handler({} as never);
    expect(result).toEqual({
      responded: ["t1", "t2"],
      requires_input: ["t3"],
    });
    expect(getUnseenSnapshot).toHaveBeenCalled();
  });
});

describe("agents:markSeen re-broadcast (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    sendAgentUpdate.mockClear();
    updateDockBadge.mockClear();
    markAgentNotificationsRead.mockClear();
    deps = makeDeps({
      unseenRespondedAgents: new Set<string>(["t1"]),
      unseenInputAgents: new Set<string>(["t1"]),
    });
    register(deps as never);
  });

  it("clears both Sets and re-broadcasts the agent with fresh flags", async () => {
    const agent = { id: "t1", lastAgentStatus: "responded" };
    deps.agentManager.getAgentById.mockReturnValue(agent);

    const handler = handlers.get("agents:markSeen")!;
    await handler({} as never, "t1");

    expect(deps.unseenRespondedAgents.has("t1")).toBe(false);
    expect(deps.unseenInputAgents.has("t1")).toBe(false);
    expect(sendAgentUpdate).toHaveBeenCalledTimes(1);
    expect(sendAgentUpdate).toHaveBeenCalledWith(
      deps.mainWindow,
      agent,
      deps.preferencesManager,
    );
  });

  it("reads the log entries about an agent the user is now looking at", async () => {
    deps.agentManager.getAgentById.mockReturnValue({
      id: "t1",
      lastAgentStatus: "responded",
    });

    const handler = handlers.get("agents:markSeen")!;
    await handler({} as never, "t1");

    expect(markAgentNotificationsRead).toHaveBeenCalledWith(
      "t1",
      deps.mainWindow,
    );
  });

  it("falls back to dock-badge refresh when the agent no longer exists", async () => {
    deps.agentManager.getAgentById.mockReturnValue(null);

    const handler = handlers.get("agents:markSeen")!;
    await handler({} as never, "t1");

    expect(deps.unseenRespondedAgents.has("t1")).toBe(false);
    expect(sendAgentUpdate).not.toHaveBeenCalled();
    expect(updateDockBadge).toHaveBeenCalled();
  });
});
