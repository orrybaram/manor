import { describe, it, expect } from "vitest";
import {
  buildFolderQuestion,
  interpretFolderAnswer,
  NO_FOLDER,
} from "./folder-suggestion";
import type { ProjectInfo } from "./projects/types";

function project(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "p1",
    name: "P",
    folders: [
      { id: "f1", name: "Backend", parentId: null },
      { id: "f2", name: "Auth", parentId: "f1" },
      { id: "f3", name: "Empty", parentId: null },
    ],
    workspaces: [
      { path: "/a", branch: "a", isMain: false, name: "login", folderId: "f2" },
      { path: "/b", branch: "b-branch", isMain: false, name: null, folderId: "f2" },
      { path: "/c", branch: "c", isMain: false, name: "other", folderId: null },
    ],
    ...over,
  } as ProjectInfo;
}

describe("buildFolderQuestion", () => {
  it("describes folders with path and member names", () => {
    const q = buildFolderQuestion(project(), { name: "oauth" })!;
    expect(q.options.f2).toBe(
      'Folder "Backend / Auth". Contains workspaces: login, b-branch',
    );
    expect(q.options.f3).toBe('Folder "Empty".');
    expect(q.options[NO_FOLDER]).toBeDefined();
  });

  it("caps member names at 10", () => {
    const workspaces = Array.from({ length: 15 }, (_, i) => ({
      path: `/w${i}`,
      branch: `w${i}`,
      isMain: false,
      name: `w${i}`,
      folderId: "f1",
    }));
    const q = buildFolderQuestion(project({ workspaces }), { name: "x" })!;
    expect(q.options.f1.split(": ")[1].split(", ")).toHaveLength(10);
  });

  it("builds trimmed state and omits blanks", () => {
    const q = buildFolderQuestion(project(), {
      name: " n ",
      branchName: "  ",
      agentPrompt: "x".repeat(3000),
    })!;
    expect(q.state.workspaceName).toBe("n");
    expect(q.state).not.toHaveProperty("branchName");
    expect(q.state.agentPrompt).toHaveLength(2000);
  });

  it("returns null with no folders or an empty name", () => {
    expect(buildFolderQuestion(project({ folders: [] }), { name: "x" })).toBeNull();
    expect(buildFolderQuestion(project(), { name: "  " })).toBeNull();
  });
});

describe("interpretFolderAnswer", () => {
  it("returns the folder above the threshold", () => {
    expect(interpretFolderAnswer({ choice: "f1", confidence: 0.7 }, project())).toEqual({
      folderId: "f1",
      confidence: 0.7,
    });
  });

  it("returns null below the threshold", () => {
    expect(interpretFolderAnswer({ choice: "f1", confidence: 0.59 }, project())).toBeNull();
  });

  it("returns null for NO_FOLDER", () => {
    expect(interpretFolderAnswer({ choice: NO_FOLDER, confidence: 0.99 }, project())).toBeNull();
  });

  it("returns null for a stale folder id", () => {
    expect(interpretFolderAnswer({ choice: "gone", confidence: 0.99 }, project())).toBeNull();
  });
});
