import { describe, it, expect } from "vitest";
import { groupWorkspaces, mergeSectionOrder } from "./workspace-folders";
import type { ProjectInfo, WorkspaceInfo } from "../store/project-store";

function ws(path: string, overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    path,
    branch: path,
    isMain: false,
    name: null,
    ...overrides,
  };
}

type MinimalProject = Pick<ProjectInfo, "workspaces" | "folders">;

describe("groupWorkspaces", () => {
  it("excludes hidden workspaces from both loose and folders", () => {
    const project: MinimalProject = {
      workspaces: [
        ws("/a"),
        ws("/b", { hidden: true }),
        ws("/c", { folderId: "f1" }),
        ws("/d", { folderId: "f1", hidden: true }),
      ],
      folders: [{ id: "f1", name: "Folder 1" }],
    };
    const grouped = groupWorkspaces(project);
    expect(grouped.loose.map((w) => w.path)).toEqual(["/a"]);
    expect(grouped.folders).toHaveLength(1);
    expect(grouped.folders[0].workspaces.map((w) => w.path)).toEqual(["/c"]);
  });

  it("puts workspaces with an unknown folderId into loose", () => {
    const project: MinimalProject = {
      workspaces: [ws("/a", { folderId: "unknown" }), ws("/b")],
      folders: [{ id: "f1", name: "Folder 1" }],
    };
    const grouped = groupWorkspaces(project);
    expect(grouped.loose.map((w) => w.path)).toEqual(["/a", "/b"]);
    expect(grouped.folders[0].workspaces).toEqual([]);
  });

  it("includes empty folders", () => {
    const project: MinimalProject = {
      workspaces: [ws("/a")],
      folders: [
        { id: "f1", name: "Empty" },
        { id: "f2", name: "Also empty" },
      ],
    };
    const grouped = groupWorkspaces(project);
    expect(grouped.folders.map((g) => g.folder.id)).toEqual(["f1", "f2"]);
    expect(grouped.folders.every((g) => g.workspaces.length === 0)).toBe(true);
  });

  it("preserves project.workspaces order within each section", () => {
    const project: MinimalProject = {
      workspaces: [
        ws("/c", { folderId: "f1" }),
        ws("/a"),
        ws("/d", { folderId: "f1" }),
        ws("/b"),
      ],
      folders: [{ id: "f1", name: "Folder 1" }],
    };
    const grouped = groupWorkspaces(project);
    expect(grouped.loose.map((w) => w.path)).toEqual(["/a", "/b"]);
    expect(grouped.folders[0].workspaces.map((w) => w.path)).toEqual([
      "/c",
      "/d",
    ]);
  });

  it("orders folders in project.folders order, independent of workspace order", () => {
    const project: MinimalProject = {
      workspaces: [ws("/a", { folderId: "f2" }), ws("/b", { folderId: "f1" })],
      folders: [
        { id: "f1", name: "First" },
        { id: "f2", name: "Second" },
      ],
    };
    const grouped = groupWorkspaces(project);
    expect(grouped.folders.map((g) => g.folder.id)).toEqual(["f1", "f2"]);
  });
});

describe("mergeSectionOrder", () => {
  it("reorders inside a middle section, leaving surrounding paths untouched", () => {
    const allPaths = ["/a", "/b", "/c", "/d", "/e"];
    // Section is [b, c, d]; reorder to [d, b, c].
    const sectionPaths = ["/d", "/b", "/c"];
    const result = mergeSectionOrder(allPaths, sectionPaths);
    expect(result).toEqual(["/a", "/d", "/b", "/c", "/e"]);
  });

  it("is identity when the section order is unchanged", () => {
    const allPaths = ["/a", "/b", "/c", "/d"];
    const sectionPaths = ["/b", "/c"];
    const result = mergeSectionOrder(allPaths, sectionPaths);
    expect(result).toEqual(allPaths);
  });

  it("appends section paths missing from allPaths", () => {
    const allPaths = ["/a", "/b"];
    const sectionPaths = ["/b", "/new"];
    const result = mergeSectionOrder(allPaths, sectionPaths);
    expect(result).toEqual(["/a", "/b", "/new"]);
  });

  it("result always has the length of the union of both inputs", () => {
    const allPaths = ["/a", "/b", "/c"];
    const sectionPaths = ["/c", "/b", "/new1", "/new2"];
    const result = mergeSectionOrder(allPaths, sectionPaths);
    const union = new Set([...allPaths, ...sectionPaths]);
    expect(result).toHaveLength(union.size);
  });
});
