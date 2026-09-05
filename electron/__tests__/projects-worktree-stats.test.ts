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

import { register } from "../ipc/projects";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    projectManager: {
      createWorktree: vi.fn(),
      removeWorktree: vi.fn(),
      quickMergeWorktree: vi.fn(),
    },
    statsStore: {
      record: vi.fn(),
    },
    mainWindow: null,
    ...overrides,
  };
}

function makeEvent() {
  return { sender: { send: vi.fn() } };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("projects worktree stats", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    handlers.clear();
    deps = makeDeps();
    register(deps as never);
  });

  describe("projects:createWorktree", () => {
    it("records worktreesCreated when the manager resolves", async () => {
      const info = { id: "p1" };
      deps.projectManager.createWorktree.mockResolvedValue(info);

      const handler = handlers.get("projects:createWorktree")!;
      const result = await handler({} as never, "p1", "feature");

      expect(result).toBe(info);
      expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
      expect(deps.statsStore.record).toHaveBeenCalledWith("worktreesCreated");
    });

    it("rethrows and records nothing when the manager throws", async () => {
      deps.projectManager.createWorktree.mockRejectedValue(new Error("boom"));

      const handler = handlers.get("projects:createWorktree")!;
      await expect(handler({} as never, "p1", "feature")).rejects.toThrow("boom");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });
  });

  describe("projects:removeWorktree", () => {
    it("records worktreesRemoved when the manager resolves", async () => {
      deps.projectManager.removeWorktree.mockResolvedValue(undefined);

      const handler = handlers.get("projects:removeWorktree")!;
      await handler(makeEvent() as never, "p1", "/path/to/wt", false);

      expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
      expect(deps.statsStore.record).toHaveBeenCalledWith("worktreesRemoved");
    });

    it("rethrows and records nothing when the manager throws", async () => {
      deps.projectManager.removeWorktree.mockRejectedValue(new Error("boom"));

      const handler = handlers.get("projects:removeWorktree")!;
      await expect(
        handler(makeEvent() as never, "p1", "/path/to/wt", false),
      ).rejects.toThrow("boom");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });
  });

  describe("projects:quickMergeWorktree", () => {
    it("records worktreesMerged when the manager resolves", async () => {
      deps.projectManager.quickMergeWorktree.mockResolvedValue(undefined);

      const handler = handlers.get("projects:quickMergeWorktree")!;
      await handler({} as never, "p1", "/path/to/wt");

      expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
      expect(deps.statsStore.record).toHaveBeenCalledWith("worktreesMerged");
    });

    it("rethrows and records nothing when the manager throws", async () => {
      deps.projectManager.quickMergeWorktree.mockRejectedValue(new Error("cannot merge"));

      const handler = handlers.get("projects:quickMergeWorktree")!;
      await expect(handler({} as never, "p1", "/path/to/wt")).rejects.toThrow(
        "cannot merge",
      );

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });
  });
});
