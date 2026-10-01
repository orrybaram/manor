import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createWorkspaceOps } from "./workspace-ops";
import type {
  ProjectInfo,
  ProjectGroupInfo,
  WorkspaceFromIssue,
  WorkspaceInfo,
} from "./persistence";

// ── Fakes ─────────────────────────────────────────────────────────────────────

function makeDeps() {
  return {
    projectManager: {
      createWorktree: vi.fn<(...args: unknown[]) => Promise<ProjectInfo | null>>(),
      createWorkspacesFromIssues:
        vi.fn<(...args: unknown[]) => Promise<WorkspaceFromIssue[]>>(),
      removeWorktree: vi.fn<(...args: unknown[]) => Promise<void>>(),
      quickMergeWorktree: vi.fn<(...args: unknown[]) => Promise<void>>(),
      setGroupLastUsedHost: vi.fn<(groupId: string, hostId: string) => void>(),
    },
    statsStore: { record: vi.fn() },
    notifyProjectsChanged: vi.fn(),
    runSetupScript: vi.fn(),
  };
}

type Deps = ReturnType<typeof makeDeps>;

const GROUP: ProjectGroupInfo = {
  id: "g1",
  name: "Group",
  memberIds: ["p1"],
  lastUsedHostId: null,
};

function ws(overrides: Partial<WorkspaceInfo>): WorkspaceInfo {
  return { path: "/repo", branch: "main", isMain: true, name: null, ...overrides };
}

function project(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "p1",
    hostId: "remote-1",
    workspaces: [ws({})],
    worktreeStartScript: null,
    group: null,
    ...overrides,
  } as ProjectInfo;
}

function issueResult(overrides: Partial<WorkspaceFromIssue>): WorkspaceFromIssue {
  return { number: 1, title: "t", body: null, url: "u", ...overrides };
}

let deps: Deps;
let ops: ReturnType<typeof createWorkspaceOps>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  deps = makeDeps();
  ops = createWorkspaceOps(deps);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

// ── create ────────────────────────────────────────────────────────────────────

describe("create", () => {
  const created = ws({
    path: "/wt/feature",
    branch: "feature",
    isMain: false,
    name: "Feature",
  });

  it("passes every request field to the manager", async () => {
    deps.projectManager.createWorktree.mockResolvedValue(null);
    const linkedIssue = { id: "1" } as never;
    await ops.create(
      {
        projectId: "p1",
        name: "Feature",
        branch: "feature",
        linkedIssue,
        baseBranch: "dev",
        useExistingBranch: true,
        // The bridge connection that asked (ADR-180 D5).
        origin: "7",
      },
      { runSetupScript: false },
    );
    expect(deps.projectManager.createWorktree).toHaveBeenCalledWith(
      "p1",
      "Feature",
      {
        branch: "feature",
        linkedIssue,
        baseBranch: "dev",
        useExistingBranch: true,
        origin: "7",
      },
    );
  });

  it("broadcasts the setup progress of a request with no origin", async () => {
    deps.projectManager.createWorktree.mockResolvedValue(null);
    await ops.create({ projectId: "p1", name: "Feature" }, { runSetupScript: true });
    expect(
      (deps.projectManager.createWorktree.mock.calls[0][2] as { origin?: unknown })
        .origin,
    ).toBeNull();
  });

  it("records the stat, broadcasts and returns the project and created path", async () => {
    const updated = project({ workspaces: [ws({}), created] });
    deps.projectManager.createWorktree.mockResolvedValue(updated);

    const result = await ops.create(
      { projectId: "p1", name: "Feature", branch: "feature" },
      { runSetupScript: false },
    );

    expect(result).toEqual({ project: updated, workspacePath: "/wt/feature" });
    expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
    expect(deps.statsStore.record).toHaveBeenCalledWith("worktreesCreated");
    expect(deps.notifyProjectsChanged).toHaveBeenCalledTimes(1);
  });

  it("finds the created workspace by branch, case-insensitively, falling back to the name", async () => {
    const other = ws({ path: "/wt/x", branch: "My-Feature", isMain: false, name: null });
    deps.projectManager.createWorktree.mockResolvedValue(
      project({ workspaces: [ws({ branch: "my-feature" }), other] }),
    );

    const result = await ops.create(
      { projectId: "p1", name: "my-feature" },
      { runSetupScript: false },
    );

    // The main workspace also matches the branch but is skipped.
    expect(result.workspacePath).toBe("/wt/x");
  });

  it("returns a null path when no workspace matches", async () => {
    deps.projectManager.createWorktree.mockResolvedValue(project());
    const result = await ops.create(
      { projectId: "p1", name: "missing" },
      { runSetupScript: false },
    );
    expect(result.workspacePath).toBeNull();
  });

  it("records the grouped project's host as the group's last-used host", async () => {
    deps.projectManager.createWorktree.mockResolvedValue(
      project({ group: GROUP, workspaces: [created] }),
    );
    await ops.create({ projectId: "p1", name: "Feature" }, { runSetupScript: false });
    expect(deps.projectManager.setGroupLastUsedHost).toHaveBeenCalledWith("g1", "remote-1");
  });

  it("records no last-used host for an ungrouped project", async () => {
    deps.projectManager.createWorktree.mockResolvedValue(project({ workspaces: [created] }));
    await ops.create({ projectId: "p1", name: "Feature" }, { runSetupScript: false });
    expect(deps.projectManager.setGroupLastUsedHost).not.toHaveBeenCalled();
  });

  it("logs, rather than throws, when the last-used host write fails", async () => {
    const updated = project({ group: GROUP, workspaces: [created] });
    deps.projectManager.createWorktree.mockResolvedValue(updated);
    deps.projectManager.setGroupLastUsedHost.mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = await ops.create(
      { projectId: "p1", name: "Feature" },
      { runSetupScript: false },
    );

    expect(result.project).toBe(updated);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(deps.notifyProjectsChanged).toHaveBeenCalledTimes(1);
  });

  it("runs the setup script on the created workspace when asked", async () => {
    deps.projectManager.createWorktree.mockResolvedValue(
      project({ worktreeStartScript: "pnpm i", workspaces: [created] }),
    );
    await ops.create({ projectId: "p1", name: "Feature" }, { runSetupScript: true });
    expect(deps.runSetupScript).toHaveBeenCalledWith("/wt/feature", "pnpm i", "remote-1");
  });

  it("skips the setup script when the flag is false", async () => {
    deps.projectManager.createWorktree.mockResolvedValue(
      project({ worktreeStartScript: "pnpm i", workspaces: [created] }),
    );
    await ops.create({ projectId: "p1", name: "Feature" }, { runSetupScript: false });
    expect(deps.runSetupScript).not.toHaveBeenCalled();
  });

  it("skips the setup script when the project has none", async () => {
    deps.projectManager.createWorktree.mockResolvedValue(project({ workspaces: [created] }));
    await ops.create({ projectId: "p1", name: "Feature" }, { runSetupScript: true });
    expect(deps.runSetupScript).not.toHaveBeenCalled();
  });

  it("skips the setup script when the created workspace is not found", async () => {
    deps.projectManager.createWorktree.mockResolvedValue(
      project({ worktreeStartScript: "pnpm i" }),
    );
    await ops.create({ projectId: "p1", name: "missing" }, { runSetupScript: true });
    expect(deps.runSetupScript).not.toHaveBeenCalled();
  });

  it("records nothing but still broadcasts when the project is not found", async () => {
    deps.projectManager.createWorktree.mockResolvedValue(null);
    const result = await ops.create(
      { projectId: "nope", name: "Feature" },
      { runSetupScript: true },
    );
    expect(result).toEqual({ project: null, workspacePath: null });
    expect(deps.statsStore.record).not.toHaveBeenCalled();
    expect(deps.projectManager.setGroupLastUsedHost).not.toHaveBeenCalled();
    expect(deps.runSetupScript).not.toHaveBeenCalled();
    expect(deps.notifyProjectsChanged).toHaveBeenCalledTimes(1);
  });

  it("propagates a manager throw and records nothing", async () => {
    deps.projectManager.createWorktree.mockRejectedValue(new Error("git failed"));
    await expect(
      ops.create({ projectId: "p1", name: "Feature" }, { runSetupScript: true }),
    ).rejects.toThrow("git failed");
    expect(deps.statsStore.record).not.toHaveBeenCalled();
    expect(deps.projectManager.setGroupLastUsedHost).not.toHaveBeenCalled();
    expect(deps.notifyProjectsChanged).not.toHaveBeenCalled();
    expect(deps.runSetupScript).not.toHaveBeenCalled();
  });
});

// ── createFromIssues ──────────────────────────────────────────────────────────

describe("createFromIssues", () => {
  const seeds = [
    { number: 1, title: "a", url: "u1" },
    { number: 2, title: "b", url: "u2" },
    { number: 3, title: "c", url: "u3" },
  ];

  it("passes the project id, seeds and base branch to the manager and returns its results", async () => {
    const results = [issueResult({ number: 1, worktreePath: "/wt/1" })];
    deps.projectManager.createWorkspacesFromIssues.mockResolvedValue(results);

    const out = await ops.createFromIssues(project(), seeds, "dev");

    expect(out).toBe(results);
    expect(deps.projectManager.createWorkspacesFromIssues).toHaveBeenCalledWith(
      "p1",
      seeds,
      "dev",
    );
  });

  it("counts only the workspaces actually created and broadcasts", async () => {
    deps.projectManager.createWorkspacesFromIssues.mockResolvedValue([
      issueResult({ number: 1, worktreePath: "/wt/1" }),
      issueResult({ number: 2, error: "exists" }),
      issueResult({ number: 3, worktreePath: "/wt/3" }),
      issueResult({ number: 4, worktreePath: "/wt/4", error: "partial" }),
    ]);

    await ops.createFromIssues(project({ group: GROUP }), seeds);

    expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
    expect(deps.statsStore.record).toHaveBeenCalledWith("worktreesCreated", 2);
    expect(deps.projectManager.setGroupLastUsedHost).toHaveBeenCalledWith("g1", "remote-1");
    expect(deps.notifyProjectsChanged).toHaveBeenCalledTimes(1);
    expect(deps.runSetupScript).not.toHaveBeenCalled();
  });

  it("records no stat or last-used host when nothing was created, but broadcasts", async () => {
    deps.projectManager.createWorkspacesFromIssues.mockResolvedValue([
      issueResult({ number: 1, error: "boom" }),
    ]);

    await ops.createFromIssues(project({ group: GROUP }), seeds);

    expect(deps.statsStore.record).not.toHaveBeenCalled();
    expect(deps.projectManager.setGroupLastUsedHost).not.toHaveBeenCalled();
    expect(deps.notifyProjectsChanged).toHaveBeenCalledTimes(1);
  });

  it("records no last-used host for an ungrouped project", async () => {
    deps.projectManager.createWorkspacesFromIssues.mockResolvedValue([
      issueResult({ number: 1, worktreePath: "/wt/1" }),
    ]);
    await ops.createFromIssues(project(), seeds);
    expect(deps.statsStore.record).toHaveBeenCalledWith("worktreesCreated", 1);
    expect(deps.projectManager.setGroupLastUsedHost).not.toHaveBeenCalled();
  });

  it("logs, rather than throws, when the last-used host write fails", async () => {
    deps.projectManager.createWorkspacesFromIssues.mockResolvedValue([
      issueResult({ number: 1, worktreePath: "/wt/1" }),
    ]);
    deps.projectManager.setGroupLastUsedHost.mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(
      ops.createFromIssues(project({ group: GROUP }), seeds),
    ).resolves.toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(deps.notifyProjectsChanged).toHaveBeenCalledTimes(1);
  });

  it("propagates a manager throw and records nothing", async () => {
    deps.projectManager.createWorkspacesFromIssues.mockRejectedValue(new Error("gone"));
    await expect(ops.createFromIssues(project({ group: GROUP }), seeds)).rejects.toThrow(
      "gone",
    );
    expect(deps.statsStore.record).not.toHaveBeenCalled();
    expect(deps.projectManager.setGroupLastUsedHost).not.toHaveBeenCalled();
    expect(deps.notifyProjectsChanged).not.toHaveBeenCalled();
  });
});

// ── remove ────────────────────────────────────────────────────────────────────

describe("remove", () => {
  it("passes every argument to the manager, records the stat and broadcasts", async () => {
    deps.projectManager.removeWorktree.mockResolvedValue(undefined);
    const onProgress = vi.fn();

    await ops.remove("p1", "/wt/feature", true, onProgress);

    expect(deps.projectManager.removeWorktree).toHaveBeenCalledWith(
      "p1",
      "/wt/feature",
      true,
      onProgress,
    );
    expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
    expect(deps.statsStore.record).toHaveBeenCalledWith("worktreesRemoved");
    expect(deps.notifyProjectsChanged).toHaveBeenCalledTimes(1);
    expect(deps.projectManager.setGroupLastUsedHost).not.toHaveBeenCalled();
  });

  it("propagates a manager throw and records nothing", async () => {
    deps.projectManager.removeWorktree.mockRejectedValue(new Error("dirty"));
    await expect(ops.remove("p1", "/wt/feature")).rejects.toThrow("dirty");
    expect(deps.statsStore.record).not.toHaveBeenCalled();
    expect(deps.notifyProjectsChanged).not.toHaveBeenCalled();
  });
});

// ── quickMerge ────────────────────────────────────────────────────────────────

describe("quickMerge", () => {
  it("calls the manager, records the stat and broadcasts", async () => {
    deps.projectManager.quickMergeWorktree.mockResolvedValue(undefined);

    await ops.quickMerge("p1", "/wt/feature");

    expect(deps.projectManager.quickMergeWorktree).toHaveBeenCalledWith("p1", "/wt/feature");
    expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
    expect(deps.statsStore.record).toHaveBeenCalledWith("worktreesMerged");
    expect(deps.notifyProjectsChanged).toHaveBeenCalledTimes(1);
  });

  it("propagates a manager throw and records nothing", async () => {
    deps.projectManager.quickMergeWorktree.mockRejectedValue(new Error("conflict"));
    await expect(ops.quickMerge("p1", "/wt/feature")).rejects.toThrow("conflict");
    expect(deps.statsStore.record).not.toHaveBeenCalled();
    expect(deps.notifyProjectsChanged).not.toHaveBeenCalled();
  });
});
