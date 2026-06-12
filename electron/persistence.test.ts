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
