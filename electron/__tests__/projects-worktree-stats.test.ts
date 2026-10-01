/**
 * The three worktree calls, and where their progress goes.
 *
 * These are handler-table functions, so the test calls them the way dispatch
 * does — with a `ctx` naming the caller, which is where their progress goes
 * (ADR-180 D5). The stats counters and the `projects.changed` broadcast are
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
function ctxOf(deps: ReturnType<typeof makeDeps>) {
  return { deps, caller: { id: "7", callerClass: "local" } } as never;
}

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

      const result = await projectsCreateWorktree(ctxOf(deps), "p1", "feature");

      expect(result).toBe(info);
      expect(deps.workspaceOps.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "p1", name: "feature" }),
        { runSetupScript: false },
      );
    });

    it("passes the caller's connection id as the setup-progress origin", async () => {
      deps.workspaceOps.create.mockResolvedValue({ project: null, workspacePath: null });

      await projectsCreateWorktree(ctxOf(deps), "p1", "feature");

      expect(deps.workspaceOps.create.mock.calls[0][0].origin).toBe("7");
    });

    it("takes the origin from the transport, never from the frame", async () => {
      deps.workspaceOps.create.mockResolvedValue({ project: null, workspacePath: null });

      await projectsCreateWorktree(ctxOf(deps), "p1", "feature", {
        branch: "feat",
        origin: "someone-else",
      } as never);

      expect(deps.workspaceOps.create.mock.calls[0][0]).toMatchObject({
        branch: "feat",
        origin: "7",
      });
    });

    it("rethrows when the create throws", async () => {
      deps.workspaceOps.create.mockRejectedValue(new Error("boom"));

      await expect(
        projectsCreateWorktree(ctxOf(deps), "p1", "feature"),
      ).rejects.toThrow("boom");
    });
  });

  describe("removeWorktree", () => {
    it("removes through workspaceOps", async () => {
      deps.workspaceOps.remove.mockResolvedValue(undefined);

      await projectsRemoveWorktree(ctxOf(deps), "p1", "/path/to/wt", false);

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

    it("rethrows when the remove throws", async () => {
      deps.workspaceOps.remove.mockRejectedValue(new Error("boom"));

      await expect(
        projectsRemoveWorktree(ctxOf(deps), "p1", "/path/to/wt", false),
      ).rejects.toThrow("boom");
    });
  });

  describe("quickMergeWorktree", () => {
    it("merges through workspaceOps", async () => {
      deps.workspaceOps.quickMerge.mockResolvedValue(undefined);

      await projectsQuickMergeWorktree(ctxOf(deps), "p1", "/path/to/wt");

      expect(deps.workspaceOps.quickMerge).toHaveBeenCalledWith("p1", "/path/to/wt");
    });

    it("rethrows when the merge throws", async () => {
      deps.workspaceOps.quickMerge.mockRejectedValue(new Error("cannot merge"));

      await expect(
        projectsQuickMergeWorktree(ctxOf(deps), "p1", "/path/to/wt"),
      ).rejects.toThrow("cannot merge");
    });
  });
});
