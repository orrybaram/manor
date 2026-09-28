import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { ProjectManager } from "./persistence";
import type { GitBackend } from "./backend/types";
import type { ProjectHost } from "./projects/types";

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

  describe("updateProject – worktree root", () => {
    it("stores a ~ worktreePath as written, to expand only when read (ADR-183)", async () => {
      const project = await manager.addProject("Proj", "/tmp/proj");

      const updated = await manager.updateProject(project.id, {
        worktreePath: "~/.manor/worktrees/proj",
      });

      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8"),
      );
      expect(state.projects[0].worktreePath).toBe("~/.manor/worktrees/proj");
      expect(updated?.worktreePath).toBe("~/.manor/worktrees/proj");
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
      const _reloaded = new ProjectManager(stubGit, tmpDir);
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

  describe("last known workspaces while a host is away (ADR-192 §5)", () => {
    function makeHosts() {
      const up = { box: true, local: true } as Record<string, boolean>;
      const listings: Record<string, Array<{ path: string; branch: string; isMain: boolean }>> = {
        box: [
          { path: "/home/me/app", branch: "main", isMain: true },
          { path: "/home/me/.wt/app-feat", branch: "feat", isMain: false },
        ],
        local: [
          { path: "/Users/me/app", branch: "main", isMain: true },
          { path: "/Users/me/.wt/app-feat", branch: "feat", isMain: false },
        ],
      };
      const gitFor = (hostId: string) =>
        ({
          exec: vi.fn().mockRejectedValue(new Error("no git here")),
          worktreeList: vi.fn(async () => {
            if (!up[hostId]) throw new Error(`${hostId} is not connected`);
            return listings[hostId];
          }),
        }) as unknown as GitBackend;
      const gits = { box: gitFor("box"), local: gitFor("local") } as Record<string, GitBackend>;
      const facts = { readFile: () => Promise.reject(new Error("none")), join: path.join };
      const resolver = (hostId: string) =>
        ({ git: gits[hostId], facts, shell: {} }) as unknown as ProjectHost;
      return { up, resolver };
    }

    it("keeps a remote project's workspaces when its host drops", async () => {
      const { up, resolver } = makeHosts();
      const mgr = new ProjectManager(resolver, tmpDir);
      await mgr.addProject("App", "/home/me/app", "box");
      expect((await mgr.getProjects())[0].workspaces).toHaveLength(2);

      up.box = false;
      const [offline] = await mgr.getProjects();
      expect(offline.workspaces.map((w) => w.path)).toEqual([
        "/home/me/app",
        "/home/me/.wt/app-feat",
      ]);
    });

    it("falls back to the main checkout for a host away since launch", async () => {
      const { up, resolver } = makeHosts();
      up.box = false;
      const mgr = new ProjectManager(resolver, tmpDir);
      await mgr.addProject("App", "/home/me/app", "box");
      const [offline] = await mgr.getProjects();
      expect(offline.workspaces.map((w) => w.path)).toEqual(["/home/me/app"]);
    });

    it("does not keep a local project's workspaces when git fails", async () => {
      const { up, resolver } = makeHosts();
      const mgr = new ProjectManager(resolver, tmpDir);
      await mgr.addProject("App", "/Users/me/app", "local");
      expect((await mgr.getProjects())[0].workspaces).toHaveLength(2);

      up.local = false;
      const [broken] = await mgr.getProjects();
      expect(broken.workspaces.map((w) => w.path)).toEqual(["/Users/me/app"]);
    });
  });
});
