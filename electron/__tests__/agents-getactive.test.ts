/**
 * `agentsGetActive`, `agentsGetRecent`, `agentsConsumePruneNotice`.
 *
 * No `ipcMain` here any more: `agents` crossed to the handler table in
 * ADR-180 ticket 9, so these are plain functions over `IpcDeps` — the same
 * functions the table calls, and a paired `full` device now reaches them the
 * same way the desktop does.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../notifications", () => ({
  updateDockBadge: vi.fn(),
  markAgentNotificationsRead: vi.fn(),
  sendAgentUpdate: vi.fn(),
  getUnseenSnapshot: vi.fn(() => ({ responded: [], requires_input: [] })),
}));

vi.mock("../ipc-validate", () => ({
  assertString: vi.fn(),
}));

import {
  agentsGetActive,
  agentsGetRecent,
  agentsConsumePruneNotice,
} from "../bridge/handlers/agents";

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    agentManager: {
      getAllAgents: vi.fn().mockReturnValue([]),
      getActiveAgents: vi.fn().mockReturnValue([]),
      getLastPruneCount: vi.fn().mockReturnValue(0),
      updateAgent: vi.fn(),
      getAgentByPaneId: vi.fn().mockReturnValue(null),
      deleteAgent: vi.fn(),
    },
    backend: {
      pty: {
        listSessions: vi.fn().mockResolvedValue([]),
      },
    },
    mainWindow: null,
    preferencesManager: {
      get: vi.fn().mockReturnValue(false),
      set: vi.fn(),
    },
    paneContextMap: new Map(),
    unseenRespondedAgents: new Set(),
    unseenInputAgents: new Set(),
    ...overrides,
  };
}

describe("agents.getActive (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("returns getActiveAgents() output verbatim", () => {
    const active = [
      { id: "t1", status: "active" },
      { id: "t2", status: "active" },
    ];
    deps.agentManager.getActiveAgents.mockReturnValue(active);

    const result = agentsGetActive(deps as never);
    expect(result).toBe(active);
    expect(deps.agentManager.getActiveAgents).toHaveBeenCalledTimes(1);
  });

  it("never invokes the sort/slice path of getAllAgents", () => {
    agentsGetActive(deps as never);

    expect(deps.agentManager.getAllAgents).not.toHaveBeenCalled();
  });

  it("does not require any arguments", () => {
    const result = agentsGetActive(deps as never);
    expect(result).toBeDefined();
  });
});

describe("agents.getRecent (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("calls getAllAgents with the requested limit", () => {
    agentsGetRecent(deps as never, { limit: 25 });
    expect(deps.agentManager.getAllAgents).toHaveBeenCalledWith({ limit: 25 });
  });

  it("defaults to a limit of 50 when none is provided", () => {
    agentsGetRecent(deps as never);
    expect(deps.agentManager.getAllAgents).toHaveBeenCalledWith({ limit: 50 });
  });
});

describe("agents.consumePruneNotice (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("returns 0 when nothing was pruned", () => {
    deps.agentManager.getLastPruneCount.mockReturnValue(0);

    const result = agentsConsumePruneNotice(deps as never);
    expect(result).toBe(0);
    expect(deps.preferencesManager.set).not.toHaveBeenCalled();
  });

  it("returns the count and sets the shown flag on first call", () => {
    deps.agentManager.getLastPruneCount.mockReturnValue(5);
    deps.preferencesManager.get.mockReturnValue(false);

    const result = agentsConsumePruneNotice(deps as never);
    expect(result).toBe(5);
    expect(deps.preferencesManager.set).toHaveBeenCalledWith(
      "agentPruneNoticeShown",
      true,
    );
  });

  it("returns 0 when the shown flag is already set, even if count > 0", () => {
    deps.agentManager.getLastPruneCount.mockReturnValue(5);
    deps.preferencesManager.get.mockReturnValue(true);

    const result = agentsConsumePruneNotice(deps as never);
    expect(result).toBe(0);
    expect(deps.preferencesManager.set).not.toHaveBeenCalled();
  });
});
