/**
 * The three worktree calls that record a stat, and where their progress goes.
 *
 * These are handler-table functions, so the test calls them the way dispatch
 * does — with a `ctx` naming the caller, which is where their progress goes
 * (ADR-180 D5).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  projectsCreateWorktree,
  projectsQuickMergeWorktree,
  projectsRemoveWorktree,
} from "../bridge/handlers/projects";
import {
  addRendererBroadcastSink,
  type RendererBroadcast,
} from "../renderer-broadcast";

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

/** The window that asked, as the bridge hands it to a handler. */
function ctxOf(deps: ReturnType<typeof makeDeps>) {
  return { deps, caller: { id: "7", callerClass: "local" } } as never;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("projects worktree stats", () => {
  let deps: ReturnType<typeof makeDeps>;
  let frames: RendererBroadcast[];
  let stopSink: () => void;

  beforeEach(() => {
    deps = makeDeps();
    frames = [];
    stopSink = addRendererBroadcastSink((frame) => frames.push(frame));
  });

  afterEach(() => {
    stopSink();
  });

  describe("createWorktree", () => {
    it("records worktreesCreated when the manager resolves", async () => {
      const info = { id: "p1" };
      deps.projectManager.createWorktree.mockResolvedValue(info);

      const result = await projectsCreateWorktree(
        ctxOf(deps),
        "p1",
        "feature",
      );

      expect(result).toBe(info);
      expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
      expect(deps.statsStore.record).toHaveBeenCalledWith("worktreesCreated");
    });

    it("passes the caller's connection id as the setup-progress origin", async () => {
      deps.projectManager.createWorktree.mockResolvedValue(null);

      await projectsCreateWorktree(ctxOf(deps), "p1", "feature");

      expect(deps.projectManager.createWorktree).toHaveBeenCalledWith(
        "p1",
        "feature",
        undefined,
        undefined,
        undefined,
        undefined,
        "7",
      );
    });

    it("rethrows and records nothing when the manager throws", async () => {
      deps.projectManager.createWorktree.mockRejectedValue(new Error("boom"));

      await expect(
        projectsCreateWorktree(ctxOf(deps), "p1", "feature"),
      ).rejects.toThrow("boom");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });
  });

  describe("removeWorktree", () => {
    it("records worktreesRemoved when the manager resolves", async () => {
      deps.projectManager.removeWorktree.mockResolvedValue(undefined);

      await projectsRemoveWorktree(ctxOf(deps), "p1", "/path/to/wt", false);

      expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
      expect(deps.statsStore.record).toHaveBeenCalledWith("worktreesRemoved");
    });

    it("addresses its progress to the caller that asked", async () => {
      deps.projectManager.removeWorktree.mockImplementation(
        async (
          _projectId: string,
          _worktreePath: string,
          _deleteBranch: boolean | undefined,
          onProgress: (step: string) => void,
        ) => {
          onProgress("Detecting branch…");
        },
      );

      await projectsRemoveWorktree(ctxOf(deps), "p1", "/path/to/wt", true);

      expect(frames).toEqual([
        {
          ns: "projects",
          event: "removeWorktreeProgress",
          args: ["Detecting branch…"],
          to: "7",
        },
      ]);
    });

    it("rethrows and records nothing when the manager throws", async () => {
      deps.projectManager.removeWorktree.mockRejectedValue(new Error("boom"));

      await expect(
        projectsRemoveWorktree(ctxOf(deps), "p1", "/path/to/wt", false),
      ).rejects.toThrow("boom");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });
  });

  describe("quickMergeWorktree", () => {
    it("records worktreesMerged when the manager resolves", async () => {
      deps.projectManager.quickMergeWorktree.mockResolvedValue(undefined);

      await projectsQuickMergeWorktree(ctxOf(deps), "p1", "/path/to/wt");

      expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
      expect(deps.statsStore.record).toHaveBeenCalledWith("worktreesMerged");
    });

    it("rethrows and records nothing when the manager throws", async () => {
      deps.projectManager.quickMergeWorktree.mockRejectedValue(
        new Error("cannot merge"),
      );

      await expect(
        projectsQuickMergeWorktree(ctxOf(deps), "p1", "/path/to/wt"),
      ).rejects.toThrow("cannot merge");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });
  });
});
