import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../project-store";
import {
  buildSidebarItems,
  placeAfterFolder,
  placeInFolder,
} from "../../utils/sidebar-items";
import type { ProjectInfo } from "../project-store";

const PROJECT_ID = "proj-1";

// `deleteWorkspaceFolder` forgets the folder's collapsed flag, which is
// localStorage-backed; this suite runs without a DOM.
beforeAll(() => {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
  });
});

const projects = {
  setWorkspaceFolder: vi.fn().mockResolvedValue(undefined),
  setFolderParent: vi.fn().mockResolvedValue(true),
  reorderWorkspaces: vi.fn().mockResolvedValue(undefined),
  deleteWorkspaceFolder: vi.fn().mockResolvedValue(undefined),
};

function ws(path: string, folderId: string | null = null) {
  return {
    path,
    branch: path,
    isMain: false,
    name: null,
    folderId,
  };
}

function seed(overrides: Partial<ProjectInfo> = {}): void {
  useProjectStore.setState({
    projects: [
      {
        id: PROJECT_ID,
        name: "app",
        path: "/tmp/repo",
        workspaces: [ws("/a"), ws("/m1", "f1"), ws("/x", "f2")],
        folders: [
          { id: "f1", name: "epic", parentId: null },
          { id: "f2", name: "api", parentId: null },
        ],
        sidebarOrder: ["/a", "f1", "/m1", "f2", "/x"],
        ...overrides,
      } as unknown as ProjectInfo,
    ],
  });
}

function currentProject(): ProjectInfo {
  return useProjectStore.getState().projects[0];
}

describe("applySidebarChange — folder nesting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error test double for the preload bridge
    window.electronAPI = { projects };
    seed();
  });

  it("persists a new folder parent and patches the folder optimistically", async () => {
    const next = placeInFolder(buildSidebarItems(currentProject()), "f2", "f1");
    await useProjectStore.getState().applySidebarChange(PROJECT_ID, next);

    expect(projects.setFolderParent).toHaveBeenCalledWith(
      PROJECT_ID,
      "f2",
      "f1",
    );
    expect(currentProject().folders).toEqual([
      { id: "f1", name: "epic", parentId: null },
      { id: "f2", name: "api", parentId: "f1" },
    ]);
    expect(currentProject().sidebarOrder).toEqual([
      "/a",
      "f1",
      "/m1",
      "f2",
      "/x",
    ]);
  });

  it("leaves unchanged parents alone", async () => {
    const items = buildSidebarItems(currentProject());
    await useProjectStore.getState().applySidebarChange(PROJECT_ID, items);
    expect(projects.setFolderParent).not.toHaveBeenCalled();
  });

  it("applies parents before their children so main never sees a cycle", async () => {
    seed({
      folders: [
        { id: "f1", name: "epic", parentId: null },
        { id: "f2", name: "api", parentId: "f1" },
      ],
      sidebarOrder: ["/a", "f1", "/m1", "f2", "/x"],
    });
    // Swap the two: f2 out to the top level, f1 inside it. Sending f1 → f2
    // first would be a cycle for as long as f2 still points at f1.
    const items = buildSidebarItems(currentProject());
    const next = placeInFolder(placeAfterFolder(items, "f2", "f1"), "f1", "f2");
    await useProjectStore.getState().applySidebarChange(PROJECT_ID, next);

    expect(projects.setFolderParent.mock.calls).toEqual([
      [PROJECT_ID, "f2", null],
      [PROJECT_ID, "f1", "f2"],
    ]);
  });
});

describe("deleteWorkspaceFolder — promotion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error test double for the preload bridge
    window.electronAPI = { projects };
    seed({
      workspaces: [ws("/a"), ws("/m1", "f1"), ws("/deep", "f2")],
      folders: [
        { id: "f1", name: "epic", parentId: null },
        { id: "f2", name: "api", parentId: "f1" },
        { id: "f3", name: "ui", parentId: "f2" },
      ],
      sidebarOrder: ["/a", "f1", "/m1", "f2", "/deep", "f3"],
    });
  });

  it("hands members and child folders to the grandparent, in the folder's slot", async () => {
    await useProjectStore.getState().deleteWorkspaceFolder(PROJECT_ID, "f2");

    const project = currentProject();
    expect(project.folders).toEqual([
      { id: "f1", name: "epic", parentId: null },
      { id: "f3", name: "ui", parentId: "f1" },
    ]);
    expect(project.workspaces.find((w) => w.path === "/deep")?.folderId).toBe(
      "f1",
    );
    expect(project.sidebarOrder).toEqual(["/a", "f1", "/m1", "/deep", "f3"]);
    expect(projects.deleteWorkspaceFolder).toHaveBeenCalledWith(
      PROJECT_ID,
      "f2",
    );
  });

  it("drops a top-level folder's members to the top level", async () => {
    await useProjectStore.getState().deleteWorkspaceFolder(PROJECT_ID, "f1");

    const project = currentProject();
    expect(project.workspaces.find((w) => w.path === "/m1")?.folderId).toBe(
      null,
    );
    expect(project.folders.find((f) => f.id === "f2")?.parentId).toBe(null);
    expect(project.sidebarOrder).toEqual(["/a", "/m1", "f2", "/deep", "f3"]);
  });
});
