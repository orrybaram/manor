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
      updateAgent: vi.fn((id: string, updates: Record<string, unknown>) => ({
        id,
        ...updates,
      })),
      getAgentByPaneId: vi.fn().mockReturnValue(null),
      deleteAgent: vi.fn(),
    },
    backend: {
      pty: {
        listSessions: vi.fn().mockResolvedValue([]),
      },
    },
    mainWindow: null,
    preferencesManager: {},
    paneContextMap: new Map(),
    unseenRespondedAgents: new Set(),
    unseenInputAgents: new Set(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("agents:update allowlist", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  it("accepts { name: 'x' } and forwards to agentManager.updateAgent", async () => {
    const handler = handlers.get("agents:update")!;
    const result = await handler({} as never, "agent-1", { name: "x" });

    expect(deps.agentManager.updateAgent).toHaveBeenCalledWith("agent-1", { name: "x" });
    expect(result).toMatchObject({ id: "agent-1", name: "x" });
  });

  it("accepts { name: null } and forwards to agentManager.updateAgent", async () => {
    const handler = handlers.get("agents:update")!;
    await handler({} as never, "agent-1", { name: null });

    expect(deps.agentManager.updateAgent).toHaveBeenCalledWith("agent-1", { name: null });
  });

  it("throws when updates contains status field", () => {
    const handler = handlers.get("agents:update")!;

    expect(() => handler({} as never, "agent-1", { status: "abandoned" })).toThrow(
      'agents:update: field "status" is not writable from renderer',
    );

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("throws when updates contains both name and a forbidden field", () => {
    const handler = handlers.get("agents:update")!;

    expect(() => handler({} as never, "agent-1", { name: "x", status: "active" })).toThrow(
      'agents:update: field "status" is not writable from renderer',
    );

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("throws when updates is not an object (string)", () => {
    const handler = handlers.get("agents:update")!;

    expect(() => handler({} as never, "agent-1", "not-an-object")).toThrow(
      "agents:update: updates must be an object",
    );

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("throws when updates is null", () => {
    const handler = handlers.get("agents:update")!;

    expect(() => handler({} as never, "agent-1", null)).toThrow(
      "agents:update: updates must be an object",
    );

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("throws when updates contains agentSessionId", () => {
    const handler = handlers.get("agents:update")!;

    expect(() => handler({} as never, "agent-1", { agentSessionId: "some-id" })).toThrow(
      'agents:update: field "agentSessionId" is not writable from renderer',
    );
  });

  it("throws when updates contains paneId", () => {
    const handler = handlers.get("agents:update")!;

    expect(() => handler({} as never, "agent-1", { paneId: "pane-1" })).toThrow(
      'agents:update: field "paneId" is not writable from renderer',
    );
  });
});
