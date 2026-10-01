/**
 * The three worktree calls, and where their progress goes.
 *
 * No `ipcMain` here any more: `projects` crossed to the handler table in
 * ADR-180 ticket 6, so these are plain functions over `IpcDeps` and the test
 * calls them the same way the table's entries do — with the caller's
 * `LayoutOrigin` in the last slot, which is what the old `event.sender` has
 * become (D5). The stats counters and the `projects.changed` broadcast are
 * `workspaceOps`'s to owe (ADR-203) and are tested in `workspace-ops.test.ts`;
 * this file checks that the handlers go through it, and that the caller's
 * connection is what the progress is addressed to.
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
import type { LayoutOrigin } from "../layout/layout-store";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    workspaceOps: {
      create: vi.fn(),
      remove: vi.fn(),
      quickMerge: vi.fn(),
    },
    mainWindow: null,
    ...overrides,
  };
}

/** The window that asked, as the bridge hands it to a handler. */
const WINDOW: LayoutOrigin = { kind: "window", id: "7" };

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("projects worktree calls", () => {
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
    it("creates through workspaceOps without the setup script and returns the project", async () => {
      const info = { id: "p1" };
      deps.workspaceOps.create.mockResolvedValue({ project: info, workspacePath: "/wt" });

      const result = await projectsCreateWorktree(
        deps as never,
        "p1",
        "feature",
        undefined,
        undefined,
        undefined,
        undefined,
        WINDOW,
      );

      expect(result).toBe(info);
      expect(deps.workspaceOps.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "p1", name: "feature" }),
        { runSetupScript: false },
      );
    });

    it("passes the caller's connection id as the setup-progress origin", async () => {
      deps.workspaceOps.create.mockResolvedValue({ project: null, workspacePath: null });

      await projectsCreateWorktree(
        deps as never,
        "p1",
        "feature",
        undefined,
        undefined,
        undefined,
        undefined,
        WINDOW,
      );

      expect(deps.workspaceOps.create.mock.calls[0][0].origin).toBe("7");
    });

    it("broadcasts the progress of a call with no renderer behind it", async () => {
      deps.workspaceOps.create.mockResolvedValue({ project: null, workspacePath: null });

      await projectsCreateWorktree(deps as never, "p1", "feature");

      expect(deps.workspaceOps.create.mock.calls[0][0].origin).toBeNull();
    });

    it("rethrows when the create throws", async () => {
      deps.workspaceOps.create.mockRejectedValue(new Error("boom"));

      await expect(
        projectsCreateWorktree(deps as never, "p1", "feature"),
      ).rejects.toThrow("boom");
    });
  });

  describe("removeWorktree", () => {
    it("removes through workspaceOps", async () => {
      deps.workspaceOps.remove.mockResolvedValue(undefined);

      await projectsRemoveWorktree(deps as never, "p1", "/path/to/wt", false);

      expect(deps.workspaceOps.remove).toHaveBeenCalledWith(
        "p1",
        "/path/to/wt",
        false,
        expect.any(Function),
      );
    });

    it("addresses its progress to the caller that asked", async () => {
      deps.workspaceOps.remove.mockImplementation(
        async (
          _projectId: string,
          _worktreePath: string,
          _deleteBranch: boolean | undefined,
          onProgress: (step: string) => void,
        ) => {
          onProgress("Detecting branch…");
        },
      );

      await projectsRemoveWorktree(
        deps as never,
        "p1",
        "/path/to/wt",
        true,
        WINDOW,
      );

      expect(frames).toEqual([
        {
          ns: "projects",
          event: "removeWorktreeProgress",
          args: ["Detecting branch…"],
          to: "7",
        },
      ]);
    });

    it("broadcasts its progress when nobody asked for it over a connection", async () => {
      deps.workspaceOps.remove.mockImplementation(
        async (
          _projectId: string,
          _worktreePath: string,
          _deleteBranch: boolean | undefined,
          onProgress: (step: string) => void,
        ) => {
          onProgress("Removing worktree…");
        },
      );

      await projectsRemoveWorktree(deps as never, "p1", "/path/to/wt");

      expect(frames).toEqual([
        {
          ns: "projects",
          event: "removeWorktreeProgress",
          args: ["Removing worktree…"],
          to: null,
        },
      ]);
    });

    it("rethrows when the remove throws", async () => {
      deps.workspaceOps.remove.mockRejectedValue(new Error("boom"));

      await expect(
        projectsRemoveWorktree(deps as never, "p1", "/path/to/wt", false),
      ).rejects.toThrow("boom");
    });
  });

  describe("quickMergeWorktree", () => {
    it("merges through workspaceOps", async () => {
      deps.workspaceOps.quickMerge.mockResolvedValue(undefined);

      await projectsQuickMergeWorktree(deps as never, "p1", "/path/to/wt");

      expect(deps.workspaceOps.quickMerge).toHaveBeenCalledWith("p1", "/path/to/wt");
    });

    it("rethrows when the merge throws", async () => {
      deps.workspaceOps.quickMerge.mockRejectedValue(new Error("cannot merge"));

      await expect(
        projectsQuickMergeWorktree(deps as never, "p1", "/path/to/wt"),
      ).rejects.toThrow("cannot merge");
    });
  });
});
