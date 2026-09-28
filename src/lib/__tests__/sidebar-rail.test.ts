import { describe, expect, it } from "vitest";
import type {
  ProjectGroupInfo,
  ProjectInfo,
  WorkspaceInfo,
} from "../../store/project-store";
import { buildTopLevelEntries } from "../../utils/sidebar-items";
import {
  railTileLabel,
  railWorkspaceRows,
  workspaceDisplayName,
} from "../sidebar-rail";

function ws(path: string, extra: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { path, branch: path, isMain: false, name: null, ...extra };
}

function project(id: string, extra: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id,
    name: id,
    path: `/${id}`,
    defaultBranch: "main",
    workspaces: [],
    selectedWorkspaceIndex: 0,
    defaultRunCommand: null,
    worktreePath: null,
    worktreeStartScript: null,
    worktreeTeardownScript: null,
    linearAssociations: [],
    color: null,
    agentCommand: null,
    commands: [],
    themeName: null,
    setupComplete: true,
    portlessEnabled: true,
    hostId: "local",
    folders: [],
    sidebarOrder: [],
    ...extra,
  } as ProjectInfo;
}

function rowsFor(p: ProjectInfo) {
  return railWorkspaceRows(buildTopLevelEntries([p])[0]).map((r) =>
    r.kind === "workspace"
      ? `ws:${r.ws.path}`
      : r.kind === "folder"
        ? `folder:${r.key}@${r.depth}`
        : `host:${r.hostId}`,
  );
}

describe("railTileLabel", () => {
  it("uppercases the first letter", () => {
    expect(railTileLabel("manor")).toBe("M");
    expect(railTileLabel("Alpha")).toBe("A");
  });
  it("returns a leading emoji", () => {
    expect(railTileLabel("🚀 launch")).toBe("🚀");
  });
  it("ignores leading whitespace", () => {
    expect(railTileLabel("   beta")).toBe("B");
  });
  it("returns ? for empty", () => {
    expect(railTileLabel("")).toBe("?");
    expect(railTileLabel("   ")).toBe("?");
  });
});

describe("workspaceDisplayName", () => {
  it("names main for its remote target or local", () => {
    expect(workspaceDisplayName(ws("a", { isMain: true }), "box")).toBe("box");
    expect(workspaceDisplayName(ws("a", { isMain: true }), null)).toBe("local");
  });
  it("prefers name, then branch", () => {
    expect(workspaceDisplayName(ws("a", { name: "N", branch: "b" }), null)).toBe("N");
    expect(workspaceDisplayName(ws("a", { branch: "b" }), null)).toBe("b");
  });
});

describe("railWorkspaceRows", () => {
  it("flattens a flat project", () => {
    const p = project("p", {
      workspaces: [ws("/a"), ws("/b")],
      sidebarOrder: ["/a", "/b"],
    });
    expect(rowsFor(p)).toEqual(["ws:/a", "ws:/b"]);
  });

  it("emits nested folders with depth", () => {
    const p = project("p", {
      workspaces: [ws("/a"), ws("/b"), ws("/c")],
      folders: [
        { id: "f1", name: "F1", parentId: null },
        { id: "f2", name: "F2", parentId: "f1" },
      ],
      sidebarOrder: ["f1", "/a", "f2", "/b", "/c"],
    });
    const p2 = {
      ...p,
      workspaces: [
        ws("/a", { folderId: "f1" }),
        ws("/b", { folderId: "f2" }),
        ws("/c"),
      ],
    };
    expect(rowsFor(p2)).toEqual([
      "folder:f1@0",
      "ws:/a",
      "folder:f2@1",
      "ws:/b",
      "ws:/c",
    ]);
  });

  it("skips hidden workspaces and folders left empty", () => {
    const p = project("p", {
      workspaces: [
        ws("/a", { hidden: true, folderId: "f1" }),
        ws("/b"),
      ],
      folders: [
        { id: "f1", name: "F1", parentId: null },
        { id: "f2", name: "Empty", parentId: null },
      ],
      sidebarOrder: ["f1", "/a", "f2", "/b"],
    });
    expect(rowsFor(p)).toEqual(["ws:/b"]);
  });

  it("emits a host row per section of a linked group", () => {
    const group: ProjectGroupInfo = {
      id: "g",
      name: "G",
      memberIds: ["p1", "p2"],
      lastUsedHostId: null,
    };
    const p1 = project("p1", {
      hostId: "local",
      group,
      workspaces: [ws("/a")],
      sidebarOrder: ["/a"],
    });
    const p2 = project("p2", {
      hostId: "ssh:box",
      group,
      workspaces: [ws("/b")],
      sidebarOrder: ["/b"],
    });
    const entry = buildTopLevelEntries([p1, p2])[0];
    const rows = railWorkspaceRows(entry).map((r) =>
      r.kind === "host" ? `host:${r.hostId}` : r.kind === "workspace" ? `ws:${r.ws.path}` : r.kind,
    );
    expect(rows).toEqual(["host:local", "ws:/a", "host:ssh:box", "ws:/b"]);
  });
});
