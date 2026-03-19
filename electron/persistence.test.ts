import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { ProjectManager } from "./persistence";

describe("ProjectManager", () => {
  let tmpDir: string;
  let manager: ProjectManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-persistence-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    manager = new ProjectManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("addProject", () => {
    it("adds a project and persists it", () => {
      const project = manager.addProject("My Project", "/tmp/fake-project");

      expect(project.name).toBe("My Project");
      expect(project.path).toBe("/tmp/fake-project");
      expect(project.setupScript).toBeNull();
      expect(project.teardownScript).toBeNull();
      expect(project.defaultRunCommand).toBeNull();

      const projects = manager.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].id).toBe(project.id);
    });

    it("sets selectedProjectIndex to the new project", () => {
      manager.addProject("First", "/tmp/first");
      manager.addProject("Second", "/tmp/second");

      expect(manager.getSelectedProjectIndex()).toBe(1);
    });
  });

  describe("removeProject", () => {
    it("removes a project by id", () => {
      const p1 = manager.addProject("One", "/tmp/one");
      manager.addProject("Two", "/tmp/two");

      manager.removeProject(p1.id);

      const projects = manager.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe("Two");
    });

    it("adjusts selectedProjectIndex when removing", () => {
      manager.addProject("One", "/tmp/one");
      const p2 = manager.addProject("Two", "/tmp/two");

      // selectedProjectIndex is 1 (Two)
      manager.removeProject(p2.id);

      expect(manager.getSelectedProjectIndex()).toBe(0);
    });
  });

  describe("selectProject", () => {
    it("changes the selected project index", () => {
      manager.addProject("One", "/tmp/one");
      manager.addProject("Two", "/tmp/two");

      manager.selectProject(0);
      expect(manager.getSelectedProjectIndex()).toBe(0);

      manager.selectProject(1);
      expect(manager.getSelectedProjectIndex()).toBe(1);
    });

    it("persists across reloads", () => {
      manager.addProject("One", "/tmp/one");
      manager.addProject("Two", "/tmp/two");
      manager.selectProject(0);

      const reloaded = new ProjectManager(tmpDir);
      expect(reloaded.getSelectedProjectIndex()).toBe(0);
    });
  });

  describe("updateProject", () => {
    it("updates the project name", () => {
      const project = manager.addProject("Old Name", "/tmp/proj");

      const updated = manager.updateProject(project.id, { name: "New Name" });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("New Name");
      expect(manager.getProjects()[0].name).toBe("New Name");
    });

    it("updates setupScript", () => {
      const project = manager.addProject("Proj", "/tmp/proj");

      manager.updateProject(project.id, { setupScript: "npm install" });

      expect(manager.getProjects()[0].setupScript).toBe("npm install");
    });

    it("updates teardownScript", () => {
      const project = manager.addProject("Proj", "/tmp/proj");

      manager.updateProject(project.id, { teardownScript: "docker-compose down" });

      expect(manager.getProjects()[0].teardownScript).toBe("docker-compose down");
    });

    it("updates defaultRunCommand", () => {
      const project = manager.addProject("Proj", "/tmp/proj");

      manager.updateProject(project.id, { defaultRunCommand: "npm run dev" });

      expect(manager.getProjects()[0].defaultRunCommand).toBe("npm run dev");
    });

    it("updates multiple fields at once", () => {
      const project = manager.addProject("Proj", "/tmp/proj");

      manager.updateProject(project.id, {
        name: "Renamed",
        setupScript: "setup.sh",
        defaultRunCommand: "make run",
      });

      const p = manager.getProjects()[0];
      expect(p.name).toBe("Renamed");
      expect(p.setupScript).toBe("setup.sh");
      expect(p.defaultRunCommand).toBe("make run");
      expect(p.teardownScript).toBeNull();
    });

    it("can set a field to null", () => {
      const project = manager.addProject("Proj", "/tmp/proj");
      manager.updateProject(project.id, { setupScript: "initial" });
      expect(manager.getProjects()[0].setupScript).toBe("initial");

      manager.updateProject(project.id, { setupScript: null });
      expect(manager.getProjects()[0].setupScript).toBeNull();
    });

    it("returns null for unknown project id", () => {
      const result = manager.updateProject("nonexistent-id", { name: "X" });
      expect(result).toBeNull();
    });

    it("does not affect other projects", () => {
      const p1 = manager.addProject("One", "/tmp/one");
      const p2 = manager.addProject("Two", "/tmp/two");

      manager.updateProject(p1.id, { name: "One Updated" });

      const projects = manager.getProjects();
      expect(projects.find((p) => p.id === p1.id)!.name).toBe("One Updated");
      expect(projects.find((p) => p.id === p2.id)!.name).toBe("Two");
    });

    it("persists updates across reloads", () => {
      const project = manager.addProject("Proj", "/tmp/proj");
      manager.updateProject(project.id, {
        name: "Persisted",
        setupScript: "echo hello",
      });

      const reloaded = new ProjectManager(tmpDir);
      const p = reloaded.getProjects()[0];
      expect(p.name).toBe("Persisted");
      expect(p.setupScript).toBe("echo hello");
    });
  });

  describe("selectWorkspace", () => {
    it("updates the selected workspace index", () => {
      const project = manager.addProject("Proj", "/tmp/proj");

      manager.selectWorkspace(project.id, 2);

      const p = manager.getProjects()[0];
      expect(p.selectedWorkspaceIndex).toBe(2);
    });

    it("no-ops for unknown project id", () => {
      manager.addProject("Proj", "/tmp/proj");
      manager.selectWorkspace("nonexistent", 5);

      expect(manager.getProjects()[0].selectedWorkspaceIndex).toBe(0);
    });
  });

  describe("renameWorkspace", () => {
    it("sets a workspace name", () => {
      const project = manager.addProject("Proj", "/tmp/proj");

      manager.renameWorkspace(project.id, "/tmp/proj", "My Workspace");

      // Persists across reload
      const reloaded = new ProjectManager(tmpDir);
      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8")
      );
      expect(state.projects[0].workspaceNames["/tmp/proj"]).toBe("My Workspace");
    });

    it("removes name when set to empty string", () => {
      const project = manager.addProject("Proj", "/tmp/proj");

      manager.renameWorkspace(project.id, "/tmp/proj", "Named");
      manager.renameWorkspace(project.id, "/tmp/proj", "");

      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "projects.json"), "utf-8")
      );
      expect(state.projects[0].workspaceNames["/tmp/proj"]).toBeUndefined();
    });
  });
});
