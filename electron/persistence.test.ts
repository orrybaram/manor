import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { ProjectManager } from "./persistence";
import type { GitBackend } from "./backend/types";

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
          { id: folder!.id, name: "Backend" },
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
