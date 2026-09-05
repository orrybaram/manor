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
vi.mock("../notifications", () => ({
  updateDockBadge: vi.fn(),
  markAgentNotificationsRead: vi.fn(),
  sendAgentUpdate: vi.fn(),
  getUnseenSnapshot: vi.fn(() => ({ responded: [], requires_input: [] })),
}));

// ── Mock ipc-validate ──────────────────────────────────────────────────────────
vi.mock("../ipc-validate", () => ({
  assertString: vi.fn(),
}));

import { register } from "../ipc/agents";

// ── Helpers ────────────────────────────────────────────────────────────────────

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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("agents:getActive (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  it("returns getActiveAgents() output verbatim", async () => {
    const active = [
      { id: "t1", status: "active" },
      { id: "t2", status: "active" },
    ];
    deps.agentManager.getActiveAgents.mockReturnValue(active);

    const handler = handlers.get("agents:getActive")!;
    expect(handler).toBeDefined();

    const result = await handler({} as never);
    expect(result).toBe(active);
    expect(deps.agentManager.getActiveAgents).toHaveBeenCalledTimes(1);
  });

  it("never invokes the sort/slice path of getAllAgents", async () => {
    const handler = handlers.get("agents:getActive")!;
    await handler({} as never);

    expect(deps.agentManager.getAllAgents).not.toHaveBeenCalled();
  });

  it("does not require any arguments", () => {
    const handler = handlers.get("agents:getActive")!;
    // Calling with only the implicit IpcMainInvokeEvent argument.
    const result = handler({} as never);
    expect(result).toBeDefined();
  });
});

describe("agents:getRecent (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  it("calls getAllAgents with the requested limit", async () => {
    const handler = handlers.get("agents:getRecent")!;
    expect(handler).toBeDefined();

    await handler({} as never, { limit: 25 });
    expect(deps.agentManager.getAllAgents).toHaveBeenCalledWith({ limit: 25 });
  });

  it("defaults to a limit of 50 when none is provided", async () => {
    const handler = handlers.get("agents:getRecent")!;
    await handler({} as never);
    expect(deps.agentManager.getAllAgents).toHaveBeenCalledWith({ limit: 50 });
  });
});

describe("agents:consumePruneNotice (ADR-136)", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  it("returns 0 when nothing was pruned", async () => {
    deps.agentManager.getLastPruneCount.mockReturnValue(0);

    const handler = handlers.get("agents:consumePruneNotice")!;
    const result = await handler({} as never);
    expect(result).toBe(0);
    expect(deps.preferencesManager.set).not.toHaveBeenCalled();
  });

  it("returns the count and sets the shown flag on first call", async () => {
    deps.agentManager.getLastPruneCount.mockReturnValue(5);
    deps.preferencesManager.get.mockReturnValue(false);

    const handler = handlers.get("agents:consumePruneNotice")!;
    const result = await handler({} as never);
    expect(result).toBe(5);
    expect(deps.preferencesManager.set).toHaveBeenCalledWith(
      "agentPruneNoticeShown",
      true,
    );
  });

  it("returns 0 when the shown flag is already set, even if count > 0", async () => {
    deps.agentManager.getLastPruneCount.mockReturnValue(5);
    deps.preferencesManager.get.mockReturnValue(true);

    const handler = handlers.get("agents:consumePruneNotice")!;
    const result = await handler({} as never);
    expect(result).toBe(0);
    expect(deps.preferencesManager.set).not.toHaveBeenCalled();
  });
});
