import { describe, it, expect } from "vitest";
import {
  buildFolderQuestion,
  interpretFolderAnswer,
  MAX_FOLDER_OPTIONS,
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

  it("caps folders at MAX_FOLDER_OPTIONS plus NO_FOLDER", () => {
    const folders = Array.from({ length: 80 }, (_, i) => ({
      id: `f${i}`,
      name: `F${i}`,
      parentId: null,
    }));
    const q = buildFolderQuestion(project({ folders }), { name: "x" })!;
    expect(Object.keys(q.options)).toHaveLength(MAX_FOLDER_OPTIONS + 1);
    expect(q.options).toHaveProperty("f62");
    expect(q.options).not.toHaveProperty("f63");
    expect(q.options[NO_FOLDER]).toBeDefined();
  });

  it("keeps descriptions within 400 chars by dropping members", () => {
    const workspaces = Array.from({ length: 10 }, (_, i) => ({
      path: `/w${i}`,
      branch: `w${i}`,
      isMain: false,
      name: `${i}`.repeat(60),
      folderId: "f1",
    }));
    const q = buildFolderQuestion(project({ workspaces }), { name: "x" })!;
    expect(q.options.f1.length).toBeLessThanOrEqual(400);
    expect(q.options.f1).toContain("0".repeat(60));
    expect(q.options.f1).not.toContain("9".repeat(60));
  });

  it("keeps the payload under the worker's 16 KiB body limit", () => {
    const folders = Array.from({ length: 63 }, (_, i) => ({
      id: crypto.randomUUID(),
      name: `${i}-`.repeat(60),
      parentId: null,
    }));
    const workspaces = folders.flatMap((f, i) =>
      Array.from({ length: 10 }, (_, j) => ({
        path: `/w${i}-${j}`,
        branch: `w${i}-${j}`,
        isMain: false,
        name: "n".repeat(30),
        folderId: f.id,
      })),
    );
    const q = buildFolderQuestion(project({ folders, workspaces }), {
      name: "x".repeat(200),
      agentPrompt: "p".repeat(2000),
    })!;
    expect(Buffer.byteLength(JSON.stringify(q))).toBeLessThanOrEqual(15 * 1024);
    expect(q.options[folders[0].id]).toBeDefined();
    expect(q.options[NO_FOLDER]).toBeDefined();
  });

  it("drops member lists before folders when the payload is too big", () => {
    const folders = Array.from({ length: 50 }, (_, i) => ({
      id: `f${i}`,
      name: `F${i}`,
      parentId: null,
    }));
    const workspaces = folders.flatMap((f, i) =>
      Array.from({ length: 10 }, (_, j) => ({
        path: `/w${i}-${j}`,
        branch: `w${i}-${j}`,
        isMain: false,
        name: "n".repeat(35),
        folderId: f.id,
      })),
    );
    const q = buildFolderQuestion(project({ folders, workspaces }), {
      name: "x",
    })!;
    expect(Object.keys(q.options)).toHaveLength(51);
    expect(q.options.f0).toBe('Folder "F0".');
  });

  it("does not send instructions", () => {
    const q = buildFolderQuestion(project(), { name: "x" })!;
    expect(q).not.toHaveProperty("instructions");
  });

  it("caps the workspace and branch names at 200 chars", () => {
    const q = buildFolderQuestion(project(), {
      name: "n".repeat(300),
      branchName: "b".repeat(300),
    })!;
    expect(q.state.workspaceName).toHaveLength(200);
    expect(q.state.branchName).toHaveLength(200);
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
