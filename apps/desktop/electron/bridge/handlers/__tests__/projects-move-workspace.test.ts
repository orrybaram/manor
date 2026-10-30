/**
 * `projects.moveWorkspaceToHost` and its preflight: the bridge's side of a
 * workspace move. The move itself is `workspace-host-move.ts`'s (tested
 * there); this checks what the bridge adds — the move's progress to the
 * caller alone, each frame carrying the move's id, and one move per
 * workspace at a time.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMoveProgress } from "../../../projects/workspace-host-move";

const moveWorkspaceToHost = vi.fn();
const preflightWorkspaceMove = vi.fn();
const createDeps = vi.fn();
vi.mock("../../../projects/workspace-host-move", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../projects/workspace-host-move")>();
  return {
  ...actual,
  createWorkspaceHostMoveDeps: (server: Parameters<typeof actual.createWorkspaceHostMoveDeps>[0]) => {
    createDeps(server);
    return actual.createWorkspaceHostMoveDeps(server);
  },
  moveWorkspaceToHost: (...args: unknown[]) => moveWorkspaceToHost(...args),
  preflightWorkspaceMove: (...args: unknown[]) => preflightWorkspaceMove(...args),
  };
});

const publishToRenderer = vi.fn();
vi.mock("../../../renderer-broadcast", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  publishToRenderer: (...args: unknown[]) => publishToRenderer(...args),
}));

import { START_SCRIPT_MAX_WAIT_MS } from "../../../workspace-ops";
import { localCtx } from "../../method";
import { projectsMoveWorkspaceToHost, projectsMoveWorkspaceToHostPreflight } from "../projects";

const request = { projectId: "p1", path: "/Users/me/app-feature", targetHostId: "box" };

function makeDeps() {
  return {
    projectManager: {
      assertKnownHost: (hostId: string) => {
        if (hostId !== "local" && hostId !== "box") throw new Error(`Unknown host "${hostId}"`);
      },
    },
    workspaceOps: {},
    backendRegistry: {},
    layoutStore: {},
    agentManager: { getActiveAgents: () => [] },
    paneContextMap: new Map(),
  };
}

const ctx = (id = "window-1") => localCtx(makeDeps() as never, id);

const done = {
  ok: true,
  targetProjectId: "p2",
  targetPath: "/home/me/feature",
  targetWorkspaceKey: "box:/home/me/feature",
  reused: false,
  sourceRemoved: true,
};

describe("projects.moveWorkspaceToHost", () => {
  beforeEach(() => {
    moveWorkspaceToHost.mockReset();
    preflightWorkspaceMove.mockReset();
    publishToRenderer.mockReset();
  });

  it("sends the caller each progress event with the move id, and answers with it", async () => {
    moveWorkspaceToHost.mockImplementation(
      async (_deps: unknown, _req: unknown, onProgress: (e: WorkspaceMoveProgress) => void) => {
        onProgress({ type: "plan", steps: [{ id: "push" }, { id: "create" }] });
        onProgress({ type: "step", index: 0, step: "push", status: "running" });
        onProgress({ type: "step", index: 0, step: "push", status: "done" });
        return done;
      },
    );
    const result = await projectsMoveWorkspaceToHost(ctx("window-1"), {
      ...request,
      keepSource: true,
      moveId: "move-7",
    });

    expect(result).toEqual({ ...done, moveId: "move-7" });
    // The start script is waited for as long as any host allows one.
    expect(createDeps).toHaveBeenCalledWith(
      expect.objectContaining({ setupTimeoutMs: START_SCRIPT_MAX_WAIT_MS }),
    );
    expect(moveWorkspaceToHost).toHaveBeenCalledWith(
      expect.objectContaining({ recreator: expect.anything() }),
      { ...request, keepSource: true },
      expect.any(Function),
    );
    expect(publishToRenderer.mock.calls).toEqual([
      [
        "window-1",
        "projects",
        "moveWorkspaceToHostProgress",
        { type: "plan", steps: [{ id: "push" }, { id: "create" }], moveId: "move-7" },
      ],
      [
        "window-1",
        "projects",
        "moveWorkspaceToHostProgress",
        { type: "step", index: 0, step: "push", status: "running", moveId: "move-7" },
      ],
      [
        "window-1",
        "projects",
        "moveWorkspaceToHostProgress",
        { type: "step", index: 0, step: "push", status: "done", moveId: "move-7" },
      ],
    ]);
  });

  it("makes up a move id when the caller names none", async () => {
    moveWorkspaceToHost.mockImplementation(async (_d: unknown, _r: unknown, onProgress: (e: WorkspaceMoveProgress) => void) => {
      onProgress({ type: "plan", steps: [] });
      return done;
    });
    const result = await projectsMoveWorkspaceToHost(ctx(), request);
    expect(result.moveId).toMatch(/\S+/);
    expect(publishToRenderer.mock.calls[0][3]).toMatchObject({ moveId: result.moveId });
    expect(moveWorkspaceToHost.mock.calls[0][1]).toEqual({ ...request, keepSource: false });
  });

  it("refuses a second move of the same workspace while the first runs", async () => {
    let finish!: (v: unknown) => void;
    moveWorkspaceToHost.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const first = projectsMoveWorkspaceToHost(ctx(), request);
    await expect(projectsMoveWorkspaceToHost(ctx("window-2"), request)).rejects.toThrow(
      /already being moved/,
    );
    finish(done);
    await expect(first).resolves.toMatchObject({ ok: true });
    moveWorkspaceToHost.mockResolvedValueOnce(done);
    await expect(projectsMoveWorkspaceToHost(ctx(), request)).resolves.toMatchObject({ ok: true });
  });

  it("validates its input before moving anything", async () => {
    await expect(projectsMoveWorkspaceToHost(ctx(), { ...request, path: 3 } as never)).rejects.toThrow();
    await expect(
      projectsMoveWorkspaceToHost(ctx(), { ...request, keepSource: "yes" } as never),
    ).rejects.toThrow(/keepSource/);
    await expect(
      projectsMoveWorkspaceToHost(ctx(), { ...request, targetHostId: "nope" }),
    ).rejects.toThrow(/Unknown host/);
    expect(moveWorkspaceToHost).not.toHaveBeenCalled();
  });
});

describe("projects.moveWorkspaceToHostPreflight", () => {
  it("answers the preflight for the request", async () => {
    preflightWorkspaceMove.mockResolvedValue({ refusals: [] });
    await expect(projectsMoveWorkspaceToHostPreflight(ctx(), request)).resolves.toEqual({
      refusals: [],
    });
    expect(preflightWorkspaceMove).toHaveBeenCalledWith(expect.anything(), request);
  });
});
