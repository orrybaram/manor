/**
 * `agentsUpdate` — the renderer's write allowlist.
 *
 * No `ipcMain` here any more: `agents` crossed to the handler table in
 * ADR-180 ticket 9, so this is a plain function over `HostDeps` — the same
 * function the table calls, and a paired `full` device now reaches it the
 * same way the desktop does.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock notifications ───────────────────────────────────────────────────────
vi.mock("../notifications", () => ({
  updateDockBadge: vi.fn(),
  markAgentNotificationsRead: vi.fn(),
  sendAgentUpdate: vi.fn(),
  getUnseenSnapshot: vi.fn(() => ({ responded: [], requires_input: [] })),
}));

// ── Mock ipc-validate ────────────────────────────────────────────────────────
vi.mock("../ipc-validate", () => ({
  assertString: vi.fn(),
}));

import { agentsUpdate } from "../bridge/handlers/agents";
import { localCtx } from "../bridge/method";

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

describe("agents.update allowlist", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it("accepts { name: 'x' } and forwards to agentManager.updateAgent", async () => {
    const result = await agentsUpdate(localCtx(deps as never), "agent-1", { name: "x" });

    expect(deps.agentManager.updateAgent).toHaveBeenCalledWith("agent-1", { name: "x" });
    expect(result).toMatchObject({ id: "agent-1", name: "x" });
  });

  it("accepts { name: null } and forwards to agentManager.updateAgent", async () => {
    await agentsUpdate(localCtx(deps as never), "agent-1", { name: null });

    expect(deps.agentManager.updateAgent).toHaveBeenCalledWith("agent-1", { name: null });
  });

  it("accepts { name, namePinned: true } for a user rename and broadcasts", async () => {
    await agentsUpdate(localCtx(deps as never), "agent-1", { name: "Fix login", namePinned: true });

    expect(deps.agentManager.updateAgent).toHaveBeenCalledWith("agent-1", {
      name: "Fix login",
      namePinned: true,
    });
    const { sendAgentUpdate } = await import("../notifications");
    expect(sendAgentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1", name: "Fix login", namePinned: true }),
      deps.preferencesManager,
    );
  });

  it("throws when namePinned is not a boolean", () => {
    expect(() => agentsUpdate(localCtx(deps as never), "agent-1", { namePinned: "yes" } as never)).toThrow(
      "agents:update: namePinned must be a boolean",
    );
    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("throws when name is not a string or null", () => {
    expect(() => agentsUpdate(localCtx(deps as never), "agent-1", { name: 42 } as never)).toThrow(
      "agents:update: name must be a string or null",
    );
    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("throws when updates contains status field", () => {
    expect(() => agentsUpdate(localCtx(deps as never), "agent-1", { status: "abandoned" } as never)).toThrow(
      'agents:update: field "status" is not writable from renderer',
    );

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("throws when updates contains both name and a forbidden field", () => {
    expect(() => agentsUpdate(localCtx(deps as never), "agent-1", { name: "x", status: "active" } as never)).toThrow(
      'agents:update: field "status" is not writable from renderer',
    );

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("throws when updates is not an object (string)", () => {
    expect(() => agentsUpdate(localCtx(deps as never), "agent-1", "not-an-object" as never)).toThrow(
      "agents:update: updates must be an object",
    );

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("throws when updates is null", () => {
    expect(() => agentsUpdate(localCtx(deps as never), "agent-1", null as never)).toThrow(
      "agents:update: updates must be an object",
    );

    expect(deps.agentManager.updateAgent).not.toHaveBeenCalled();
  });

  it("throws when updates contains agentSessionId", () => {
    expect(() => agentsUpdate(localCtx(deps as never), "agent-1", { agentSessionId: "some-id" } as never)).toThrow(
      'agents:update: field "agentSessionId" is not writable from renderer',
    );
  });

  it("throws when updates contains paneId", () => {
    expect(() => agentsUpdate(localCtx(deps as never), "agent-1", { paneId: "pane-1" } as never)).toThrow(
      'agents:update: field "paneId" is not writable from renderer',
    );
  });
});
