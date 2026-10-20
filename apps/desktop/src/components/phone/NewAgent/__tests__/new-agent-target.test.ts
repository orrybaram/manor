import { describe, it, expect } from "vitest";
import type { HostStatusInfo } from "../../../../store/host-store";
import type { ProjectGroupInfo, ProjectInfo } from "../../../../store/project-store";
import { workspaceKey } from "../../../../lib/workspace-key";
import {
  baseBranchOf,
  projectChoices,
  resolveTarget,
  seedTarget,
  selectHost,
  selectProject,
  workspaceChoices,
} from "../new-agent-target";

const hosts: HostStatusInfo[] = [];

function group(lastUsedHostId: string | null = null): ProjectGroupInfo {
  return { id: "g1", name: "App", memberIds: ["local-app", "box-app"], lastUsedHostId };
}

function project(
  id: string,
  hostId: string,
  groupInfo: ProjectGroupInfo | null,
  extra: { path: string; branch?: string; hidden?: boolean; name?: string | null }[] = [],
  mainBranch = "main",
): ProjectInfo {
  return {
    id,
    name: id,
    path: `/code/${id}`,
    hostId,
    defaultBranch: "main",
    workspaces: [
      { path: `/code/${id}`, branch: mainBranch, isMain: true, name: null },
      ...extra.map((e) => ({
        path: e.path,
        branch: e.branch ?? e.path.split("/").pop()!,
        isMain: false,
        name: e.name ?? null,
        hidden: e.hidden,
      })),
    ],
    selectedWorkspaceIndex: 0,
    defaultRunCommand: null,
    worktreePath: null,
    worktreeStartScript: null,
    worktreeTeardownScript: null,
    linearAssociations: [],
    color: "#f00",
    agentCommand: null,
    commands: [],
    themeName: null,
    setupComplete: true,
    portlessEnabled: true,
    folders: [],
    sidebarOrder: [],
    group: groupInfo,
  };
}

const solo = project("solo", "local", null, [
  { path: "/wt/feat", name: "Feature" },
  { path: "/wt/hidden", hidden: true },
  { path: "/wt/other" },
]);
const other = project("other", "local", null);
const local = project("local-app", "local", group(), [{ path: "/wt/x", branch: "feat-x" }]);
const box = project("box-app", "box", group(), [{ path: "/box/x", branch: "Feat-X" }], "master");

describe("seedTarget", () => {
  it("starts on the active workspace", () => {
    const key = workspaceKey("local", "/wt/feat");
    expect(seedTarget([other, solo], key, hosts)).toEqual({
      projectId: "solo",
      workspacePath: "/wt/feat",
      newWorktree: false,
    });
  });

  it("falls back to the first project's main when Home is active", () => {
    expect(seedTarget([other, solo], null, hosts)).toEqual({
      projectId: "other",
      workspacePath: "/code/other",
      newWorktree: false,
    });
  });

  it("resolves a first-entry group through its starting member", () => {
    const target = seedTarget([local, box], null, hosts);
    expect(target?.projectId).toBe("local-app");
    expect(target?.workspacePath).toBe("/code/local-app");
  });

  it("is null with no projects", () => {
    expect(seedTarget([], null, hosts)).toBeNull();
  });
});

describe("projectChoices", () => {
  it("collapses a group to one entry", () => {
    expect(projectChoices([other, local, box])).toEqual([
      { id: "other", name: "other", color: "#f00", isGroup: false },
      { id: "g1", name: "App", color: "#f00", isGroup: true },
    ]);
  });
});

describe("workspaceChoices", () => {
  it("lists main first, once, skipping hidden", () => {
    const t = { projectId: "solo", workspacePath: "/code/solo", newWorktree: false };
    expect(workspaceChoices(t, [solo])).toEqual([
      { path: "/code/solo", label: "main", branch: "main", isMain: true },
      { path: "/wt/feat", label: "Feature", branch: "feat", isMain: false },
      { path: "/wt/other", label: "other", branch: "other", isMain: false },
    ]);
  });
});

describe("selection", () => {
  const t = { projectId: "solo", workspacePath: "/wt/feat", newWorktree: true };

  it("selectProject resets to main and keeps newWorktree", () => {
    expect(selectProject(t, "other", [solo, other], hosts)).toEqual({
      projectId: "other",
      workspacePath: "/code/other",
      newWorktree: true,
    });
  });

  it("selectProject on a group id picks a member", () => {
    expect(selectProject(t, "g1", [solo, local, box], hosts).projectId).toBe("local-app");
  });

  it("selectHost keeps the same-branch workspace", () => {
    const from = { projectId: "local-app", workspacePath: "/wt/x", newWorktree: false };
    expect(selectHost(from, "box-app", [local, box])).toEqual({
      projectId: "box-app",
      workspacePath: "/box/x",
      newWorktree: false,
    });
  });

  it("selectHost falls back to main without a matching branch", () => {
    const from = { projectId: "box-app", workspacePath: "/code/box-app", newWorktree: false };
    expect(selectHost(from, "local-app", [local, box]).workspacePath).toBe("/code/local-app");
  });
});

describe("resolveTarget", () => {
  it("resolves project, workspace and host", () => {
    const r = resolveTarget({ projectId: "box-app", workspacePath: "/box/x", newWorktree: false }, [local, box]);
    expect(r?.project.id).toBe("box-app");
    expect(r?.workspace.path).toBe("/box/x");
    expect(r?.hostId).toBe("box");
  });

  it("is null when the project or workspace is gone", () => {
    expect(resolveTarget({ projectId: "gone", workspacePath: "/x", newWorktree: false }, [solo])).toBeNull();
    expect(resolveTarget({ projectId: "solo", workspacePath: "/wt/gone", newWorktree: false }, [solo])).toBeNull();
  });
});

describe("baseBranchOf", () => {
  const detached = project("detached", "local", null, [{ path: "/wt/head", branch: "" }], "release");
  const at = (workspacePath: string) =>
    resolveTarget({ projectId: "detached", workspacePath, newWorktree: true }, [detached])!;

  it("bases main off the default branch, not whatever main has checked out", () => {
    expect(baseBranchOf(at("/code/detached"))).toBe("main");
  });

  it("bases another workspace off its own branch", () => {
    expect(baseBranchOf(resolveTarget({ projectId: "solo", workspacePath: "/wt/feat", newWorktree: true }, [solo])!)).toBe(
      "feat",
    );
  });

  it("leaves a workspace with no branch to the default", () => {
    expect(baseBranchOf(at("/wt/head"))).toBeUndefined();
  });
});
