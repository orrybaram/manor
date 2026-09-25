import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  ProjectManager,
  isFolderDescendant,
  normalizeSidebarOrder,
  spliceFolderOut,
} from "./persistence";
import type { GitBackend, ShellBackend } from "./backend/types";
import { worktreesDir } from "./paths";
import { toDirSlug } from "./branch-name";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

const stubGit = {} as GitBackend;

describe("ProjectManager", () => {
  let tmpDir: string;
  let manager: ProjectManager;

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `manor-persistence-test-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    manager = new ProjectManager(stubGit, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("addProject", () => {
    it("adds a project and persists it", async () => {
      const project = await manager.addProject(
        "My Project",
        "/tmp/fake-project",
      );

      expect(project.name).toBe("My Project");
      expect(project.path).toBe("/tmp/fake-project");
      expect(project.defaultRunCommand).toBeNull();

      const projects = await manager.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe(project.id);
    });

    it("sets selectedProjectIndex to the new project", async () => {
      await manager.addProject("First", "/tmp/first");
      await manager.addProject("Second", "/tmp/second");

      expect(manager.getSelectedProjectIndex()).toBe(1);
    });
  });

  describe("removeProject", () => {
    it("removes a project by id", async () => {
      const p1 = await manager.addProject("One", "/tmp/one");
      await manager.addProject("Two", "/tmp/two");

      manager.removeProject(p1.id);

      const projects = await manager.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("Two");
    });

    it("adjusts selectedProjectIndex when removing", async () => {
      await manager.addProject("One", "/tmp/one");
      const p2 = await manager.addProject("Two", "/tmp/two");

      // selectedProjectIndex is 1 (Two)
      manager.removeProject(p2.id);

      expect(manager.getSelectedProjectIndex()).toBe(0);
    });
  });

  describe("selectProject", () => {
    it("changes the selected project index", async () => {
      await manager.addProject("One", "/tmp/one");
      await manager.addProject("Two", "/tmp/two");

      manager.selectProject(0);
      expect(manager.getSelectedProjectIndex()).toBe(0);

      manager.selectProject(1);
      expect(manager.getSelectedProjectIndex()).toBe(1);
    });

    it("persists across reloads", async () => {
      await manager.addProject("One", "/tmp/one");
      await manager.addProject("Two", "/tmp/two");
      manager.selectProject(0);

      const reloaded = new ProjectManager(stubGit, tmpDir);
      expect(reloaded.getSelectedProjectIndex()).toBe(0);
    });
  });

  describe("updateProject", () => {
    it("updates the project name", async () => {
      const project = await manager.addProject("Old Name", "/tmp/proj");

      const updated = await manager.updateProject(project.id, {
        name: "New Name",
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("New Name");
      expect((await manager.getProjects())[0].name).toBe("New Name");
    });

    it("updates defaultRunCommand", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");

      await manager.updateProject(project.id, {
        defaultRunCommand: "npm run dev",
      });

      expect((await manager.getProjects())[0].defaultRunCommand).toBe(
        "npm run dev",
      );
    });

    it("updates multiple fields at once", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");

      await manager.updateProject(project.id, {
        name: "Renamed",
        defaultRunCommand: "make run",
      });

      const p = (await manager.getProjects())[0];
      expect(p.name).toBe("Renamed");
      expect(p.defaultRunCommand).toBe("make run");
    });

    it("can set a field to null", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");
      await manager.updateProject(project.id, { defaultRunCommand: "initial" });
      expect((await manager.getProjects())[0].defaultRunCommand).toBe(
        "initial",
      );

      await manager.updateProject(project.id, { defaultRunCommand: null });
      expect((await manager.getProjects())[0].defaultRunCommand).toBeNull();
    });

    it("returns null for unknown project id", async () => {
      const result = await manager.updateProject("nonexistent-id", {
        name: "X",
      });
      expect(result).toBeNull();
    });

    it("does not affect other projects", async () => {
      const p1 = await manager.addProject("One", "/tmp/one");
      const p2 = await manager.addProject("Two", "/tmp/two");

      await manager.updateProject(p1.id, { name: "One Updated" });

      const projects = await manager.getProjects();
      expect(projects.find((p) => p.id === p1.id)!.name).toBe("One Updated");
      expect(projects.find((p) => p.id === p2.id)!.name).toBe("Two");
    });

    it("persists updates across reloads", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");
      await manager.updateProject(project.id, {
        name: "Persisted",
        defaultRunCommand: "echo hello",
      });

      const reloaded = new ProjectManager(stubGit, tmpDir);
      const p = (await reloaded.getProjects())[0];
      expect(p.name).toBe("Persisted");
      expect(p.defaultRunCommand).toBe("echo hello");
    });
  });

  describe("portlessEnabled", () => {
    it("defaults to true for a new project", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");
      expect(project.portlessEnabled).toBe(true);
    });

    it("round-trips false across a reload", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");
      await manager.updateProject(project.id, { portlessEnabled: false });

      const reloaded = new ProjectManager(stubGit, tmpDir);
      expect((await reloaded.getProjects())[0].portlessEnabled).toBe(false);
    });

    /**
     * Projects persisted before the flag existed must keep their named preview
     * URLs — absence means "on", not "off".
     */
    it("migrates a project persisted without the field to true", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");
      const file = path.join(tmpDir, "projects.json");
      const state = JSON.parse(fs.readFileSync(file, "utf-8"));
      const persisted = Array.isArray(state) ? state : state.projects;
      const entry = persisted.find((p: { id: string }) => p.id === project.id);
      expect(entry).toHaveProperty("portlessEnabled"); // guard: shape assumption
      delete entry.portlessEnabled;
      fs.writeFileSync(file, JSON.stringify(state));

      const reloaded = new ProjectManager(stubGit, tmpDir);
      expect((await reloaded.getProjects())[0].portlessEnabled).toBe(true);
    });
  });

  describe("selectWorkspace", () => {
    it("updates the selected workspace index", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");

      manager.selectWorkspace(project.id, 2);

      const p = (await manager.getProjects())[0];
      expect(p.selectedWorkspaceIndex).toBe(2);
    });

    it("no-ops for unknown project id", async () => {
      await manager.addProject("Proj", "/tmp/proj");
      manager.selectWorkspace("nonexistent", 5);

      expect((await manager.getProjects())[0].selectedWorkspaceIndex).toBe(0);
    });
  });

  describe("updateProject – tilde expansion", () => {
    it("expands ~ in worktreePath to the home directory", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");

      await manager.updateProject(project.id, {
        worktreePath: "~/.manor/worktrees/proj",
      });

      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"),
      );
      expect(state.projects[0].worktreePath).toBe(
        path.join(os.homedir(), ".manor/worktrees/proj"),
      );
    });

    it("leaves absolute worktreePath unchanged", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");

      await manager.updateProject(project.id, {
        worktreePath: "/custom/worktree/path",
      });

      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"),
      );
      expect(state.projects[0].worktreePath).toBe("/custom/worktree/path");
    });
  });

  describe("renameWorkspace", () => {
    it("sets a workspace name", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");

      manager.renameWorkspace(project.id, "/tmp/proj", "My Workspace");

      // Persists across reload
      const _reloaded = new ProjectManager(tmpDir);
      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"),
      );
      expect(state.projects[0].workspaceNames["/tmp/proj"]).toBe(
        "My Workspace",
      );
    });

    it("removes name when set to empty string", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");

      manager.renameWorkspace(project.id, "/tmp/proj", "Named");
      manager.renameWorkspace(project.id, "/tmp/proj", "");

      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"),
      );
      expect(state.projects[0].workspaceNames["/tmp/proj"]).toBeUndefined();
    });
  });

  describe("workspace folders", () => {
    function readState() {
      return JSON.parse(
        fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"),
      );
    }

    describe("createWorkspaceFolder", () => {
      it("creates a folder and persists it with a trimmed name", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");

        const folder = manager.createWorkspaceFolder(project.id, "  Backend  ");

        expect(folder).not.toBeNull();
        expect(folder!.id).toBeTruthy();
        expect(folder!.name).toBe("Backend");

        const state = readState();
        expect(state.projects[0].workspaceFolders).toEqual([
          { id: folder!.id, name: "Backend", parentId: null },
        ]);
      });

      it("returns null and persists nothing for an empty or whitespace name", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");

        expect(manager.createWorkspaceFolder(project.id, "")).toBeNull();
        expect(manager.createWorkspaceFolder(project.id, "   ")).toBeNull();

        const state = readState();
        expect(state.projects[0].workspaceFolders ?? []).toHaveLength(0);
      });

      it("returns null for an unknown project id", () => {
        expect(manager.createWorkspaceFolder("nonexistent", "Backend")).toBeNull();
      });

      it("nests the new folder under an existing parent", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const parent = manager.createWorkspaceFolder(project.id, "Epic")!;

        const child = manager.createWorkspaceFolder(
          project.id,
          "API",
          parent.id,
        )!;

        expect(child.parentId).toBe(parent.id);
        const state = readState();
        expect(state.projects[0].workspaceFolders[1].parentId).toBe(parent.id);
      });

      it("stores an unknown parent id as null instead of rejecting it", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");

        const folder = manager.createWorkspaceFolder(
          project.id,
          "API",
          "nonexistent",
        )!;

        expect(folder.parentId).toBeNull();
      });
    });

    describe("setFolderParent", () => {
      it("nests a folder under another and persists it", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const parent = manager.createWorkspaceFolder(project.id, "Epic")!;
        const child = manager.createWorkspaceFolder(project.id, "API")!;

        expect(manager.setFolderParent(project.id, child.id, parent.id)).toBe(
          true,
        );

        const state = readState();
        expect(state.projects[0].workspaceFolders[1].parentId).toBe(parent.id);
      });

      it("moves a nested folder back to the top level", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const parent = manager.createWorkspaceFolder(project.id, "Epic")!;
        const child = manager.createWorkspaceFolder(
          project.id,
          "API",
          parent.id,
        )!;

        expect(manager.setFolderParent(project.id, child.id, null)).toBe(true);

        const state = readState();
        expect(state.projects[0].workspaceFolders[1].parentId).toBeNull();
      });

      it("refuses to make a folder its own parent", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const folder = manager.createWorkspaceFolder(project.id, "Epic")!;

        expect(manager.setFolderParent(project.id, folder.id, folder.id)).toBe(
          false,
        );

        const state = readState();
        expect(state.projects[0].workspaceFolders[0].parentId).toBeNull();
      });

      it("refuses a parent that is one of the folder's descendants", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const top = manager.createWorkspaceFolder(project.id, "Epic")!;
        const mid = manager.createWorkspaceFolder(project.id, "API", top.id)!;
        const leaf = manager.createWorkspaceFolder(project.id, "v2", mid.id)!;

        expect(manager.setFolderParent(project.id, top.id, leaf.id)).toBe(
          false,
        );

        const state = readState();
        expect(state.projects[0].workspaceFolders[0].parentId).toBeNull();
      });

      it("returns false for an unknown folder id", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        expect(manager.setFolderParent(project.id, "nonexistent", null)).toBe(
          false,
        );
      });

      it("treats an unknown parent id as the top level", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const parent = manager.createWorkspaceFolder(project.id, "Epic")!;
        const child = manager.createWorkspaceFolder(
          project.id,
          "API",
          parent.id,
        )!;

        expect(
          manager.setFolderParent(project.id, child.id, "nonexistent"),
        ).toBe(true);

        const state = readState();
        expect(state.projects[0].workspaceFolders[1].parentId).toBeNull();
      });
    });

    describe("renameWorkspaceFolder", () => {
      it("updates the folder name", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const folder = manager.createWorkspaceFolder(project.id, "Backend")!;

        manager.renameWorkspaceFolder(project.id, folder.id, "  Backend v2  ");

        const state = readState();
        expect(state.projects[0].workspaceFolders[0].name).toBe("Backend v2");
      });

      it("is a no-op when the new name is empty", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const folder = manager.createWorkspaceFolder(project.id, "Backend")!;

        manager.renameWorkspaceFolder(project.id, folder.id, "   ");

        const state = readState();
        expect(state.projects[0].workspaceFolders[0].name).toBe("Backend");
      });

      it("is a no-op for an unknown folder id", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        manager.createWorkspaceFolder(project.id, "Backend");

        manager.renameWorkspaceFolder(project.id, "nonexistent", "New Name");

        const state = readState();
        expect(state.projects[0].workspaceFolders[0].name).toBe("Backend");
      });
    });

    describe("setWorkspaceFolder", () => {
      it("sets the membership for a workspace path", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const folder = manager.createWorkspaceFolder(project.id, "Backend")!;

        manager.setWorkspaceFolder(project.id, "/tmp/proj", folder.id);

        const state = readState();
        expect(state.projects[0].workspaceFolderIds["/tmp/proj"]).toBe(
          folder.id,
        );
      });

      it("removes the membership when set to null", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const folder = manager.createWorkspaceFolder(project.id, "Backend")!;
        manager.setWorkspaceFolder(project.id, "/tmp/proj", folder.id);

        manager.setWorkspaceFolder(project.id, "/tmp/proj", null);

        const state = readState();
        expect(
          state.projects[0].workspaceFolderIds["/tmp/proj"],
        ).toBeUndefined();
      });

      it("removes the membership when given an unknown folder id", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const folder = manager.createWorkspaceFolder(project.id, "Backend")!;
        manager.setWorkspaceFolder(project.id, "/tmp/proj", folder.id);

        manager.setWorkspaceFolder(project.id, "/tmp/proj", "nonexistent");

        const state = readState();
        expect(
          state.projects[0].workspaceFolderIds["/tmp/proj"],
        ).toBeUndefined();
      });
    });

    describe("deleteWorkspaceFolder", () => {
      it("removes the folder and every membership pointing at it", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const folder = manager.createWorkspaceFolder(project.id, "Backend")!;
        manager.setWorkspaceFolder(project.id, "/tmp/proj", folder.id);

        manager.deleteWorkspaceFolder(project.id, folder.id);

        const state = readState();
        expect(state.projects[0].workspaceFolders).toEqual([]);
        expect(
          state.projects[0].workspaceFolderIds["/tmp/proj"],
        ).toBeUndefined();
      });

      it("promotes child folders and member workspaces to the grandparent", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const top = manager.createWorkspaceFolder(project.id, "Epic")!;
        const mid = manager.createWorkspaceFolder(project.id, "API", top.id)!;
        const leaf = manager.createWorkspaceFolder(project.id, "v2", mid.id)!;
        manager.setWorkspaceFolder(project.id, "/tmp/proj", mid.id);

        manager.deleteWorkspaceFolder(project.id, mid.id);

        const state = readState();
        const folders = state.projects[0].workspaceFolders;
        expect(folders.map((f: { id: string }) => f.id)).toEqual([
          top.id,
          leaf.id,
        ]);
        expect(
          folders.find((f: { id: string }) => f.id === leaf.id).parentId,
        ).toBe(top.id);
        expect(state.projects[0].workspaceFolderIds["/tmp/proj"]).toBe(top.id);
      });

      it("unfiles members when the deleted folder was at the top level", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const top = manager.createWorkspaceFolder(project.id, "Epic")!;
        const child = manager.createWorkspaceFolder(project.id, "API", top.id)!;
        manager.setWorkspaceFolder(project.id, "/tmp/proj", top.id);

        manager.deleteWorkspaceFolder(project.id, top.id);

        const state = readState();
        expect(
          state.projects[0].workspaceFolders.find(
            (f: { id: string }) => f.id === child.id,
          ).parentId,
        ).toBeNull();
        expect(
          state.projects[0].workspaceFolderIds["/tmp/proj"],
        ).toBeUndefined();
      });
    });

    describe("buildProjectInfo folder resolution", () => {
      let gitMock: GitBackend;

      beforeEach(() => {
        gitMock = {
          exec: vi.fn().mockResolvedValue(""),
          worktreeAdd: vi.fn().mockResolvedValue(undefined),
          worktreeList: vi.fn().mockResolvedValue([
            { path: "/tmp/proj", branch: "main", isMain: true },
            { path: "/tmp/proj-2", branch: "feature", isMain: false },
          ]),
          stage: vi.fn(),
          unstage: vi.fn(),
          discard: vi.fn(),
          commit: vi.fn(),
          stash: vi.fn(),
          getFullDiff: vi.fn(),
          getLocalDiff: vi.fn(),
          getStagedFiles: vi.fn(),
          worktreeRemove: vi.fn(),
        } as unknown as GitBackend;
        manager = new ProjectManager(gitMock, tmpDir);
      });

      it("resolves folderId for workspaces mapped to an existing folder", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const folder = manager.createWorkspaceFolder(project.id, "Backend")!;
        manager.setWorkspaceFolder(project.id, "/tmp/proj-2", folder.id);

        const [info] = await manager.getProjects();
        expect(info.folders).toEqual([folder]);
        const ws2 = info.workspaces.find((w) => w.path === "/tmp/proj-2")!;
        expect(ws2.folderId).toBe(folder.id);
        const ws1 = info.workspaces.find((w) => w.path === "/tmp/proj")!;
        expect(ws1.folderId).toBeNull();
      });

      it("reads back a nested folder's parentId", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const parent = manager.createWorkspaceFolder(project.id, "Epic")!;
        const child = manager.createWorkspaceFolder(
          project.id,
          "API",
          parent.id,
        )!;

        const [info] = await manager.getProjects();
        expect(info.folders).toEqual([
          { id: parent.id, name: "Epic", parentId: null },
          { id: child.id, name: "API", parentId: parent.id },
        ]);
      });

      it("loads a project persisted before parentId with every folder at the top level", async () => {
        await manager.addProject("Proj", "/tmp/proj");
        const state = readState();
        state.projects[0].workspaceFolders = [
          { id: "f1", name: "Epic" },
          { id: "f2", name: "API" },
        ];
        fs.writeFileSync(
          path.join(tmpDir, "projects.json"),
          JSON.stringify(state),
        );

        const reloaded = new ProjectManager(gitMock, tmpDir);
        const [info] = await reloaded.getProjects();
        expect(info.folders).toEqual([
          { id: "f1", name: "Epic", parentId: null },
          { id: "f2", name: "API", parentId: null },
        ]);
      });

      it("resolves a dangling or self-referential parentId to null", async () => {
        await manager.addProject("Proj", "/tmp/proj");
        const state = readState();
        state.projects[0].workspaceFolders = [
          { id: "f1", name: "Epic", parentId: "gone" },
          { id: "f2", name: "API", parentId: "f2" },
        ];
        fs.writeFileSync(
          path.join(tmpDir, "projects.json"),
          JSON.stringify(state),
        );

        const reloaded = new ProjectManager(gitMock, tmpDir);
        const [info] = await reloaded.getProjects();
        expect(info.folders.map((f) => f.parentId)).toEqual([null, null]);
      });

      it("resolves a stale folder id to null", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const state = readState();
        state.projects[0].workspaceFolderIds = { "/tmp/proj-2": "stale-id" };
        fs.writeFileSync(
          path.join(tmpDir, "projects.json"),
          JSON.stringify(state),
        );

        const reloaded = new ProjectManager(gitMock, tmpDir);
        const [info] = await reloaded.getProjects();
        const ws2 = info.workspaces.find((w) => w.path === "/tmp/proj-2")!;
        expect(ws2.folderId).toBeNull();
        void project;
      });
    });
  });

  describe("sidebar order", () => {
    describe("normalizeSidebarOrder", () => {
      it("keeps known entries in order", () => {
        const result = normalizeSidebarOrder(
          ["folder-a", "/tmp/b", "/tmp/a"],
          ["/tmp/a", "/tmp/b"],
          ["folder-a"],
        );
        expect(result).toEqual(["folder-a", "/tmp/b", "/tmp/a"]);
      });

      it("drops unknown ids and stale paths", () => {
        const result = normalizeSidebarOrder(
          ["/tmp/gone", "folder-gone", "/tmp/a"],
          ["/tmp/a"],
          [],
        );
        expect(result).toEqual(["/tmp/a"]);
      });

      it("appends missing paths then missing folder ids", () => {
        const result = normalizeSidebarOrder(
          ["/tmp/a"],
          ["/tmp/a", "/tmp/b"],
          ["folder-a"],
        );
        expect(result).toEqual(["/tmp/a", "/tmp/b", "folder-a"]);
      });

      it("undefined input yields paths then folder ids", () => {
        const result = normalizeSidebarOrder(
          undefined,
          ["/tmp/a", "/tmp/b"],
          ["folder-a"],
        );
        expect(result).toEqual(["/tmp/a", "/tmp/b", "folder-a"]);
      });

      it("never duplicates an entry even if it appears twice in the input", () => {
        const result = normalizeSidebarOrder(
          ["/tmp/a", "/tmp/a"],
          ["/tmp/a", "/tmp/b"],
          [],
        );
        expect(result).toEqual(["/tmp/a", "/tmp/b"]);
      });
    });

    describe("spliceFolderOut", () => {
      it("gathers scattered members into the folder's slot", () => {
        const result = spliceFolderOut(
          ["/tmp/loose-1", "/tmp/a", "folder-a", "/tmp/loose-2", "/tmp/b"],
          "folder-a",
          ["/tmp/a", "/tmp/b"],
        );
        expect(result).toEqual([
          "/tmp/loose-1",
          "/tmp/a",
          "/tmp/b",
          "/tmp/loose-2",
        ]);
      });

      it("appends members when the folder id is absent", () => {
        const result = spliceFolderOut(
          ["/tmp/loose-1", "/tmp/loose-2"],
          "folder-missing",
          ["/tmp/a", "/tmp/b"],
        );
        expect(result).toEqual([
          "/tmp/loose-1",
          "/tmp/loose-2",
          "/tmp/a",
          "/tmp/b",
        ]);
      });

      it("never duplicates a path", () => {
        const result = spliceFolderOut(
          ["folder-a", "/tmp/a", "/tmp/b"],
          "folder-a",
          ["/tmp/a", "/tmp/b"],
        );
        expect(result).toEqual(["/tmp/a", "/tmp/b"]);
        expect(result.filter((e) => e === "/tmp/a")).toHaveLength(1);
      });
    });

    describe("isFolderDescendant", () => {
      const folders = [
        { id: "top", name: "Epic", parentId: null },
        { id: "mid", name: "API", parentId: "top" },
        { id: "leaf", name: "v2", parentId: "mid" },
        { id: "other", name: "Bugs", parentId: null },
      ];

      it("counts the folder itself", () => {
        expect(isFolderDescendant(folders, "top", "top")).toBe(true);
      });

      it("finds a direct child and an indirect one", () => {
        expect(isFolderDescendant(folders, "top", "mid")).toBe(true);
        expect(isFolderDescendant(folders, "top", "leaf")).toBe(true);
      });

      it("is false for an unrelated folder, an ancestor, null and unknown ids", () => {
        expect(isFolderDescendant(folders, "top", "other")).toBe(false);
        expect(isFolderDescendant(folders, "leaf", "top")).toBe(false);
        expect(isFolderDescendant(folders, "top", null)).toBe(false);
        expect(isFolderDescendant(folders, "top", "nonexistent")).toBe(false);
      });

      it("terminates on a cyclic parent chain", () => {
        const cyclic = [
          { id: "a", name: "A", parentId: "b" },
          { id: "b", name: "B", parentId: "a" },
        ];
        expect(isFolderDescendant(cyclic, "c", "a")).toBe(false);
        expect(isFolderDescendant(cyclic, "b", "a")).toBe(true);
      });
    });

    describe("createWorkspaceFolder appends to workspaceOrder", () => {
      function readState() {
        return JSON.parse(
          fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"),
        );
      }

      it("appends the new id to an existing workspaceOrder", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        manager.reorderWorkspaces(project.id, ["/tmp/proj"]);

        const folder = manager.createWorkspaceFolder(project.id, "Backend")!;

        const state = readState();
        expect(state.projects[0].workspaceOrder).toEqual([
          "/tmp/proj",
          folder.id,
        ]);
      });

      it("leaves an unset workspaceOrder unset", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");

        manager.createWorkspaceFolder(project.id, "Backend");

        const state = readState();
        expect(state.projects[0].workspaceOrder).toBeUndefined();
      });
    });

    describe("deleteWorkspaceFolder rewrites workspaceOrder", () => {
      function readState() {
        return JSON.parse(
          fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"),
        );
      }

      it("puts members where the folder was", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const folder = manager.createWorkspaceFolder(project.id, "Backend")!;
        manager.setWorkspaceFolder(project.id, "/tmp/a", folder.id);
        manager.setWorkspaceFolder(project.id, "/tmp/b", folder.id);
        manager.reorderWorkspaces(project.id, [
          "/tmp/loose-1",
          folder.id,
          "/tmp/loose-2",
        ]);

        manager.deleteWorkspaceFolder(project.id, folder.id);

        const state = readState();
        expect(state.projects[0].workspaceOrder).toEqual([
          "/tmp/loose-1",
          "/tmp/a",
          "/tmp/b",
          "/tmp/loose-2",
        ]);
      });

      it("puts promoted child folders where the folder was, in order", async () => {
        const project = await manager.addProject("Proj", "/tmp/proj");
        const parent = manager.createWorkspaceFolder(project.id, "Epic")!;
        const childA = manager.createWorkspaceFolder(
          project.id,
          "API",
          parent.id,
        )!;
        const childB = manager.createWorkspaceFolder(
          project.id,
          "UI",
          parent.id,
        )!;
        manager.setWorkspaceFolder(project.id, "/tmp/a", parent.id);
        manager.reorderWorkspaces(project.id, [
          "/tmp/loose-1",
          parent.id,
          childA.id,
          "/tmp/a",
          childB.id,
          "/tmp/loose-2",
        ]);

        manager.deleteWorkspaceFolder(project.id, parent.id);

        const state = readState();
        expect(state.projects[0].workspaceOrder).toEqual([
          "/tmp/loose-1",
          childA.id,
          "/tmp/a",
          childB.id,
          "/tmp/loose-2",
        ]);
      });
    });

    describe("buildProjectInfo", () => {
      it("returns sidebarOrder with a folder id and two paths in persisted order", async () => {
        const gitMock = {
          exec: vi.fn().mockResolvedValue(""),
          worktreeAdd: vi.fn().mockResolvedValue(undefined),
          worktreeList: vi.fn().mockResolvedValue([
            { path: "/tmp/proj", branch: "main", isMain: true },
            { path: "/tmp/proj-2", branch: "feature", isMain: false },
          ]),
          stage: vi.fn(),
          unstage: vi.fn(),
          discard: vi.fn(),
          commit: vi.fn(),
          stash: vi.fn(),
          getFullDiff: vi.fn(),
          getLocalDiff: vi.fn(),
          getStagedFiles: vi.fn(),
          worktreeRemove: vi.fn(),
        } as unknown as GitBackend;
        manager = new ProjectManager(gitMock, tmpDir);

        const project = await manager.addProject("Proj", "/tmp/proj");
        const folder = manager.createWorkspaceFolder(project.id, "Backend")!;
        manager.reorderWorkspaces(project.id, [
          folder.id,
          "/tmp/proj",
          "/tmp/proj-2",
        ]);

        const [info] = await manager.getProjects();
        expect(info.sidebarOrder).toEqual([
          folder.id,
          "/tmp/proj",
          "/tmp/proj-2",
        ]);
      });
    });
  });

  describe("createWorktree", () => {
    let gitMock: GitBackend;

    beforeEach(() => {
      gitMock = {
        exec: vi.fn().mockResolvedValue(""),
        worktreeAdd: vi.fn().mockResolvedValue(undefined),
        worktreeList: vi.fn().mockResolvedValue([
          { path: "/tmp/proj", branch: "main", isMain: true },
        ]),
        stage: vi.fn(),
        unstage: vi.fn(),
        discard: vi.fn(),
        commit: vi.fn(),
        stash: vi.fn(),
        getFullDiff: vi.fn(),
        getLocalDiff: vi.fn(),
        getStagedFiles: vi.fn(),
        worktreeRemove: vi.fn(),
      } as unknown as GitBackend;
      manager = new ProjectManager(gitMock, tmpDir);
    });

    it("useExistingBranch: true — checks out local branch without createBranch", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");

      await manager.createWorktree(
        project.id,
        "my-workspace",
        "feature/existing",
        undefined,
        undefined,
        true,
      );

      const worktreeAdd = vi.mocked(gitMock.worktreeAdd);
      expect(worktreeAdd).toHaveBeenCalledWith(
        "/tmp/proj",
        expect.stringContaining("my-workspace"),
        "feature/existing",
      );
      // Must NOT have been called with createBranch: true on the first attempt
      const firstCall = worktreeAdd.mock.calls[0];
      expect(firstCall[3]).toBeUndefined();
    });

    it("useExistingBranch: true — falls back to remote tracking branch when local is missing", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");
      vi.mocked(gitMock.worktreeAdd).mockRejectedValueOnce(
        new Error("fatal: no such branch"),
      );

      await manager.createWorktree(
        project.id,
        "my-workspace",
        "feature/existing",
        undefined,
        undefined,
        true,
      );

      const worktreeAdd = vi.mocked(gitMock.worktreeAdd);
      expect(worktreeAdd).toHaveBeenCalledTimes(2);
      expect(worktreeAdd).toHaveBeenLastCalledWith(
        "/tmp/proj",
        expect.stringContaining("my-workspace"),
        "feature/existing",
        { createBranch: true, startPoint: "origin/feature/existing" },
      );
    });

    it("useExistingBranch: false — creates new branch from default ref", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");

      await manager.createWorktree(project.id, "my-workspace", "new-feature");

      expect(vi.mocked(gitMock.worktreeAdd)).toHaveBeenCalledWith(
        "/tmp/proj",
        expect.any(String),
        "new-feature",
        { createBranch: true, startPoint: "origin/main" },
      );
    });

    it("useExistingBranch: false — respects explicit baseBranch as startPoint", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");

      await manager.createWorktree(
        project.id,
        "my-workspace",
        "new-feature",
        undefined,
        "origin/develop",
      );

      expect(vi.mocked(gitMock.worktreeAdd)).toHaveBeenCalledWith(
        "/tmp/proj",
        expect.any(String),
        "new-feature",
        { createBranch: true, startPoint: "origin/develop" },
      );
    });
  });

  describe("createWorkspacesFromIssues", () => {
    let gitMock: GitBackend;

    beforeEach(() => {
      gitMock = {
        exec: vi.fn().mockResolvedValue(""),
        worktreeAdd: vi.fn().mockResolvedValue(undefined),
        worktreeList: vi.fn().mockResolvedValue([
          { path: "/tmp/proj", branch: "main", isMain: true },
        ]),
        stage: vi.fn(),
        unstage: vi.fn(),
        discard: vi.fn(),
        commit: vi.fn(),
        stash: vi.fn(),
        getFullDiff: vi.fn(),
        getLocalDiff: vi.fn(),
        getStagedFiles: vi.fn(),
        worktreeRemove: vi.fn(),
      } as unknown as GitBackend;
      manager = new ProjectManager(gitMock, tmpDir);
    });

    it("creates one worktree per issue, each linked, and returns its path", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");

      const results = await manager.createWorkspacesFromIssues(project.id, [
        { number: 10, title: "Fix login", url: "https://x/10", body: "b10" },
        { number: 20, title: "Add search", url: "https://x/20", body: null },
      ]);

      expect(vi.mocked(gitMock.worktreeAdd)).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ number: 10, worktreePath: expect.stringContaining("fix-login") });
      expect(results[1]).toMatchObject({ number: 20, worktreePath: expect.stringContaining("add-search") });
      expect(results[0].error).toBeUndefined();

      // The issue is linked to the created worktree.
      const linked = manager.getWorkspaceIssues(project.id, results[0].worktreePath!);
      expect(linked).toEqual([
        { id: "10", identifier: "#10", title: "Fix login", url: "https://x/10" },
      ]);
    });

    it("falls back to issue-<number> when the title has no slug", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");

      const results = await manager.createWorkspacesFromIssues(project.id, [
        { number: 7, title: "!!!", url: "https://x/7" },
      ]);

      expect(results[0].worktreePath).toContain("issue-7");
    });

    it("isolates per-issue failures without aborting the batch", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");
      // Stub the dependency directly: first issue's worktree creation fails,
      // the second succeeds. Tests the orchestration's error isolation without
      // coupling to createWorktree's internal git retry logic.
      vi.spyOn(manager, "createWorktree")
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(null);

      const results = await manager.createWorkspacesFromIssues(project.id, [
        { number: 10, title: "First", url: "https://x/10" },
        { number: 20, title: "Second", url: "https://x/20" },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ number: 10, error: expect.any(String) });
      expect(results[0].worktreePath).toBeUndefined();
      expect(results[1]).toMatchObject({ number: 20, worktreePath: expect.any(String) });
    });

    it("returns a per-issue error when the project is missing", async () => {
      const results = await manager.createWorkspacesFromIssues("nope", [
        { number: 1, title: "X", url: "https://x/1" },
      ]);
      expect(results[0].error).toBe("Project not found");
    });
  });

  describe("default branch detection and resync", () => {
    function makeGit(
      symbolicRefResult: string | Error,
    ): GitBackend {
      return {
        exec: vi.fn(async (_cwd: string, args: string[]) => {
          if (args[0] === "symbolic-ref") {
            if (symbolicRefResult instanceof Error) throw symbolicRefResult;
            return symbolicRefResult;
          }
          // All other git calls (set-head, worktree list, etc.): reject
          // so graceful fallbacks kick in. listGitWorkspaces tolerates this.
          throw new Error(`unstubbed git: ${args.join(" ")}`);
        }),
        worktreeAdd: vi.fn(),
        worktreeList: vi.fn().mockResolvedValue([
          { path: "/tmp/fake-project", branch: "main", isMain: true },
        ]),
        stage: vi.fn(),
        unstage: vi.fn(),
        discard: vi.fn(),
        commit: vi.fn(),
        stash: vi.fn(),
        getFullDiff: vi.fn(),
        getLocalDiff: vi.fn(),
        getStagedFiles: vi.fn(),
        worktreeRemove: vi.fn(),
      } as unknown as GitBackend;
    }

    it("Detect on creation — non-main default", async () => {
      const git = makeGit("origin/master\n");
      const mgr = new ProjectManager(git, tmpDir);

      const project = await mgr.addProject("Test", "/tmp/fake-project");

      expect(project.defaultBranch).toBe("master");

      // Reload and verify it persists
      const reloaded = new ProjectManager(
        makeGit("origin/master\n"),
        tmpDir,
      );
      const projects = await reloaded.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].defaultBranch).toBe("master");
    });

    it("Detect on creation — fallback to main", async () => {
      const git = makeGit(new Error("symbolic-ref failed"));
      const mgr = new ProjectManager(git, tmpDir);

      const project = await mgr.addProject("Test", "/tmp/fake-project");

      expect(project.defaultBranch).toBe("main");
    });

    it("Startup resync corrects drift", async () => {
      // Step 1: Create a project with "main" (symbolic-ref throws)
      const gitThrows = makeGit(new Error("symbolic-ref failed"));
      const mgr1 = new ProjectManager(gitThrows, tmpDir);
      const created = await mgr1.addProject("Test", "/tmp/fake-project");
      expect(created.defaultBranch).toBe("main");

      // Step 2: Reload with a git that returns "develop"
      const gitDevelop = makeGit("origin/develop\n");
      const mgr2 = new ProjectManager(gitDevelop, tmpDir);
      const projects = await mgr2.getProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0].defaultBranch).toBe("develop");

      // Step 3: Reload again and verify it persisted
      const mgr3 = new ProjectManager(gitDevelop, tmpDir);
      const projectsAgain = await mgr3.getProjects();
      expect(projectsAgain[0].defaultBranch).toBe("develop");
    });

    it("Resync does not clobber on detection failure", async () => {
      // Step 1: Create a project with "trunk"
      const gitTrunk = makeGit("origin/trunk\n");
      const mgr1 = new ProjectManager(gitTrunk, tmpDir);
      const created = await mgr1.addProject("Test", "/tmp/fake-project");
      expect(created.defaultBranch).toBe("trunk");

      // Step 2: Reload with a git that throws on symbolic-ref
      const gitThrows = makeGit(new Error("symbolic-ref failed"));
      const mgr2 = new ProjectManager(gitThrows, tmpDir);
      const projects = await mgr2.getProjects();

      // Should still be "trunk"
      expect(projects).toHaveLength(1);
      expect(projects[0].defaultBranch).toBe("trunk");
    });

    it("Resync runs once", async () => {
      const git = makeGit("origin/develop\n");
      const mgr = new ProjectManager(git, tmpDir);
      await mgr.addProject("Test", "/tmp/fake-project");

      // Count symbolic-ref calls before first getProjects
      const execMock = vi.mocked(git.exec);

      // First getProjects should call resync
      await mgr.getProjects();
      const callsAfterFirst = execMock.mock.calls.filter(
        (call) => call[1][0] === "symbolic-ref",
      ).length;
      expect(callsAfterFirst).toBeGreaterThan(0);

      // Second getProjects should NOT call symbolic-ref again
      await mgr.getProjects();
      const callsAfterSecond = execMock.mock.calls.filter(
        (call) => call[1][0] === "symbolic-ref",
      ).length;
      expect(callsAfterSecond).toBe(callsAfterFirst);
    });
  });
});

describe("ProjectManager hosts (ADR-160)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-hosts-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function gitNamed(name: string): GitBackend {
    return {
      exec: vi.fn(async () => {
        throw new Error("no origin");
      }),
      worktreeList: vi.fn(async (cwd: string) => [
        { path: cwd, branch: name, isMain: true },
      ]),
    } as unknown as GitBackend;
  }

  it("reads a project persisted without hostId as local, with no migration", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "projects.json"),
      JSON.stringify({
        projects: [
          {
            id: "p1",
            name: "Old",
            path: "/tmp/old",
            selectedWorkspaceIndex: 0,
            workspaces: [],
            defaultBranch: "main",
            defaultRunCommand: null,
            worktreePath: null,
          },
        ],
        selectedProjectIndex: 0,
      }),
    );
    const resolver = vi.fn((hostId: string) => gitNamed(hostId));
    const mgr = new ProjectManager(resolver, tmpDir);

    const [project] = await mgr.getProjects();
    expect(project.hostId).toBe("local");
    expect(project.backendType).toBe("local");
    expect(mgr.getProjectHostId("p1")).toBe("local");
    expect(mgr.getHosts()).toEqual([]);
    expect(new Set(resolver.mock.calls.map(([id]) => id))).toEqual(new Set(["local"]));
  });

  it("does not write hostId for a local project", async () => {
    const mgr = new ProjectManager(gitNamed("local"), tmpDir);
    await mgr.addProject("Local", "/tmp/local");
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"));
    expect(saved.projects[0]).not.toHaveProperty("hostId");
    expect(saved).not.toHaveProperty("hosts");
  });

  it("routes a remote project's git through its host and persists the host", async () => {
    const gits = new Map<string, GitBackend>();
    const resolver = (hostId: string) => {
      if (!gits.has(hostId)) gits.set(hostId, gitNamed(hostId));
      return gits.get(hostId)!;
    };
    const mgr = new ProjectManager(resolver, tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote", "/home/me/app", "box");

    expect(project.hostId).toBe("box");
    expect(project.workspaces[0].branch).toBe("box");
    expect(gits.get("box")!.worktreeList).toHaveBeenCalledWith("/home/me/app");
    expect(gits.has("local")).toBe(false);

    const reloaded = new ProjectManager(resolver, tmpDir);
    expect(reloaded.getHosts()).toEqual([
      { hostId: "box", spec: { kind: "ssh", target: "me@box" } },
    ]);
    const [info] = await reloaded.getProjects();
    expect(info.hostId).toBe("box");
    expect(info.backendType).toBe("remote");
    expect(reloaded.remoteHostIdsInUse()).toEqual(["box"]);
  });

  it("keeps extra per-host fields when a host's spec is replaced", () => {
    fs.writeFileSync(
      path.join(tmpDir, "projects.json"),
      JSON.stringify({
        projects: [],
        selectedProjectIndex: 0,
        hosts: { box: { spec: { kind: "ssh", target: "old" }, lastHookSeq: 42 } },
      }),
    );
    const mgr = new ProjectManager(gitNamed("local"), tmpDir);
    mgr.saveHost("box", { kind: "ssh", target: "new" });
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"));
    expect(saved.hosts.box).toEqual({ spec: { kind: "ssh", target: "new" }, lastHookSeq: 42 });
    expect(() => mgr.saveHost("local", { kind: "ssh", target: "x" })).toThrow();
  });

  it("does not route a local project's worktrees to a same-named remote project", () => {
    const project = (id: string, extra: Record<string, unknown>) => ({
      id,
      name: "App",
      selectedWorkspaceIndex: 0,
      workspaces: [],
      defaultBranch: "main",
      defaultRunCommand: null,
      worktreePath: null,
      ...extra,
    });
    fs.writeFileSync(
      path.join(tmpDir, "projects.json"),
      JSON.stringify({
        // The remote project comes first, so a tie would have gone to it.
        projects: [
          project("r1", { path: "/home/me/app", hostId: "box" }),
          project("l1", { path: "/Users/me/app" }),
          project("r2", {
            name: "Other",
            path: "/home/me/other",
            hostId: "box",
            worktreePath: "/home/me/other-trees",
          }),
          project("r3", { name: "Shared", path: "/srv/shared", hostId: "box" }),
          project("l3", { name: "Shared", path: "/srv/shared" }),
        ],
        selectedProjectIndex: 0,
        hosts: { box: { spec: { kind: "ssh", target: "me@box" } } },
      }),
    );
    const mgr = new ProjectManager((hostId) => gitNamed(hostId), tmpDir);

    // The default worktree root is this machine's; it belongs to local only.
    expect(mgr.hostIdForPath(path.join(worktreesDir(), toDirSlug("App"), "feature"))).toBe("local");
    // An explicit worktree root on a remote project still counts.
    expect(mgr.hostIdForPath("/home/me/other-trees/feature")).toBe("box");
    // Equally close local and remote roots: local wins.
    expect(mgr.hostIdForPath("/srv/shared/src")).toBe("local");
    expect(mgr.hostIdForPath("/home/me/app/src")).toBe("box");
  });

  it("resolves a path to the host of the project containing it", async () => {
    const mgr = new ProjectManager((hostId) => gitNamed(hostId), tmpDir);
    await mgr.addProject("Local", "/Users/me/app");
    // No remote project yet: everything is local.
    expect(mgr.hostIdForPath("/home/me/app/src")).toBe("local");

    await mgr.addProject("Remote", "/home/me/app", "box");
    expect(mgr.hostIdForPath("/home/me/app")).toBe("box");
    expect(mgr.hostIdForPath("/home/me/app/src")).toBe("box");
    expect(mgr.hostIdForPath("/home/me/app2")).toBe("local");
    expect(mgr.hostIdForPath("/Users/me/app/src")).toBe("local");
    expect(mgr.hostIdForPath("/somewhere/else")).toBe("local");
  });
});

describe("ProjectManager host-relative paths (ADR-178)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-host-paths-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fullGit(): GitBackend {
    return {
      exec: vi.fn(async () => ""),
      worktreeList: vi.fn(async () => []),
      worktreeAdd: vi.fn(async () => {}),
      worktreeRemove: vi.fn(async () => {}),
    } as unknown as GitBackend;
  }

  /** A fake remote `ShellBackend`: `home` for `homeDir`, `files` for `cat`/`test -e`. */
  function fakeShell(
    home: string,
    opts: { files?: Record<string, string> } = {},
  ): ShellBackend & { execCalls: Array<[string, string[], unknown]> } {
    const files = opts.files ?? {};
    const execCalls: Array<[string, string[], unknown]> = [];
    return {
      execCalls,
      which: vi.fn(async () => null),
      homeDir: vi.fn(async () => home),
      exec: vi.fn(async (cmd: string, args: string[], execOpts?: unknown) => {
        execCalls.push([cmd, args, execOpts]);
        if (cmd === "cat") {
          const filePath = args[0];
          if (filePath in files) return files[filePath];
          throw new Error(`no such file: ${filePath}`);
        }
        if (cmd === "test" && args[0] === "-e") {
          const filePath = args[1];
          if (filePath in files) return "";
          throw new Error(`missing: ${filePath}`);
        }
        if (cmd === "sh" && args[0] === "-c") {
          return "";
        }
        throw new Error(`fakeShell: unexpected exec ${cmd} ${args.join(" ")}`);
      }),
    } as unknown as ShellBackend & { execCalls: Array<[string, string[], unknown]> };
  }

  it("resolves a remote project's default worktree root against the host's home", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(() => git, tmpDir, () => shell);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");

    const results = await mgr.createWorkspacesFromIssues(project.id, [
      { number: 1, title: "feature", url: "https://example.com/1" },
    ]);

    expect(shell.homeDir).toHaveBeenCalled();
    expect(results[0].worktreePath).toBe(
      "/home/remoteuser/.manor/worktrees/remote-app/feature",
    );
  });

  it("expands a leading ~ in project.worktreePath against the remote host's home", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(() => git, tmpDir, () => shell);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");
    await mgr.updateProject(project.id, { worktreePath: "~/custom-trees" });

    const results = await mgr.createWorkspacesFromIssues(project.id, [
      { number: 1, title: "feature", url: "https://example.com/1" },
    ]);

    expect(results[0].worktreePath).toBe("/home/remoteuser/custom-trees/feature");
  });

  it("does not call the remote host for a local project's home", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(() => git, tmpDir, () => shell);
    const project = await mgr.addProject("Local App", "/tmp/local-app");

    const results = await mgr.createWorkspacesFromIssues(project.id, [
      { number: 1, title: "feature", url: "https://example.com/1" },
    ]);

    expect(results[0].worktreePath).toBe(
      path.join(worktreesDir(), toDirSlug("Local App"), "feature"),
    );
    expect(shell.homeDir).not.toHaveBeenCalled();
  });

  it("runs the teardown script through the host's shell, not local execAsync", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(() => git, tmpDir, () => shell);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");
    await mgr.updateProject(project.id, {
      worktreeTeardownScript: "docker compose down",
    });

    await mgr.removeWorktree(project.id, "/home/remoteuser/.manor/worktrees/remote-app/feature");

    expect(shell.execCalls).toContainEqual([
      "sh",
      ["-c", "docker compose down"],
      { cwd: "/home/remoteuser/.manor/worktrees/remote-app/feature", timeout: 10 * 60 * 1000 },
    ]);
  });

  it("reads package.json and lockfile presence through the host's shell for a remote project", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser", {
      files: {
        "/srv/app/package.json": JSON.stringify({
          scripts: { build: "tsc", test: "vitest" },
        }),
        "/srv/app/pnpm-lock.yaml": "",
      },
    });
    const mgr = new ProjectManager(() => git, tmpDir, () => shell);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });

    const project = await mgr.addProject("Remote App", "/srv/app", "box");

    expect(project.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "build", command: "pnpm run build" }),
        expect.objectContaining({ name: "test", command: "pnpm run test" }),
      ]),
    );
  });

  it("includes a remote project's default worktree root in hostIdForPath once its home is known", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(() => git, tmpDir, () => shell);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    await mgr.addProject("Remote App", "/srv/app", "box");

    // Home is not known synchronously yet — the default root is skipped.
    expect(mgr.hostIdForPath("/home/remoteuser/.manor/worktrees/remote-app/feature")).toBe(
      "local",
    );

    // getProjects() warms every remote host's home in the background.
    await mgr.getProjects();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mgr.hostIdForPath("/home/remoteuser/.manor/worktrees/remote-app/feature")).toBe(
      "box",
    );
  });

  it("keeps local worktree resolution byte-identical with no shell resolver supplied", async () => {
    const git = fullGit();
    const mgr = new ProjectManager(() => git, tmpDir);
    const project = await mgr.addProject("Local App", "/tmp/local-app-2");

    const results = await mgr.createWorkspacesFromIssues(project.id, [
      { number: 1, title: "feature", url: "https://example.com/1" },
    ]);

    expect(results[0].worktreePath).toBe(
      path.join(worktreesDir(), toDirSlug("Local App"), "feature"),
    );
  });

  it("keeps the local teardown script's original 30s timeout, not the remote's 10min one", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/someone");
    const mgr = new ProjectManager(() => git, tmpDir, () => shell);
    const project = await mgr.addProject("Local App", "/tmp/local-app-3");
    await mgr.updateProject(project.id, { worktreeTeardownScript: "rm -rf tmp" });

    await mgr.removeWorktree(project.id, "/tmp/local-app-3-worktree");

    expect(shell.execCalls).toContainEqual([
      "sh",
      ["-c", "rm -rf tmp"],
      { cwd: "/tmp/local-app-3-worktree", timeout: 30000 },
    ]);
  });

  it("rejects an empty or root remote home and does not cache the failure", async () => {
    const git = fullGit();
    let home = "";
    const shell = fakeShell("");
    shell.homeDir = vi.fn(async () => home);
    const mgr = new ProjectManager(() => git, tmpDir, () => shell);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");

    await expect(
      mgr.updateProject(project.id, { worktreePath: "~/custom-trees" }),
    ).rejects.toThrow(/absolute path/);

    home = "/";
    await expect(
      mgr.updateProject(project.id, { worktreePath: "~/custom-trees" }),
    ).rejects.toThrow(/absolute path/);

    // A valid home on a later call is not blocked by an earlier failure.
    home = "/home/remoteuser";
    const updated = await mgr.updateProject(project.id, { worktreePath: "~/custom-trees" });
    expect(updated?.worktreePath).toBe("/home/remoteuser/custom-trees");
  });

  it("saves an absolute worktreePath without asking an unreachable host for its home", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    shell.homeDir = vi.fn(async () => {
      throw new Error("host unreachable");
    });
    const mgr = new ProjectManager(() => git, tmpDir, () => shell);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");

    const updated = await mgr.updateProject(project.id, {
      worktreePath: "/srv/custom-trees",
    });

    expect(updated?.worktreePath).toBe("/srv/custom-trees");
    expect(shell.homeDir).not.toHaveBeenCalled();
  });

  it("clears the cached home directory when a host's spec is replaced with saveHost", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(() => git, tmpDir, () => shell);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    await mgr.addProject("Remote App", "/srv/app", "box");

    await mgr.getProjects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mgr.hostIdForPath("/home/remoteuser/.manor/worktrees/remote-app/feature")).toBe(
      "box",
    );

    // The host moved to a different machine with a different home. Replacing
    // its spec must drop the stale cached home, so routing does not keep
    // using the old machine's path until it is re-resolved.
    mgr.saveHost("box", { kind: "ssh", target: "me@new-box" });
    expect(mgr.hostIdForPath("/home/remoteuser/.manor/worktrees/remote-app/feature")).toBe(
      "local",
    );
  });

  it("never drops the leading slash when joining an absolute worktree root (remoteJoin)", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(() => git, tmpDir, () => shell);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    const project = await mgr.addProject("Remote App", "/srv/app", "box");
    await mgr.updateProject(project.id, { worktreePath: "/" });

    const results = await mgr.createWorkspacesFromIssues(project.id, [
      { number: 1, title: "feature", url: "https://example.com/1" },
    ]);

    expect(results[0].worktreePath).toBe("/feature");
  });

  it("clears the cached home directory when a host is removed", async () => {
    const git = fullGit();
    const shell = fakeShell("/home/remoteuser");
    const mgr = new ProjectManager(() => git, tmpDir, () => shell);
    mgr.saveHost("box", { kind: "ssh", target: "me@box" });
    await mgr.addProject("Remote App", "/srv/app", "box");

    await mgr.getProjects();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mgr.hostIdForPath("/home/remoteuser/.manor/worktrees/remote-app/feature")).toBe(
      "box",
    );

    mgr.removeHost("box");
    expect(mgr.hostIdForPath("/home/remoteuser/.manor/worktrees/remote-app/feature")).toBe(
      "local",
    );
  });
});
