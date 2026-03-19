import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

function manorDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Manor");
  }
  return path.join(os.homedir(), ".local", "share", "Manor");
}

export interface WorkspaceInfo {
  path: string;
  branch: string;
  isMain: boolean;
  name: string | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  workspaces: WorkspaceInfo[];
  selectedWorkspaceIndex: number;
  setupScript: string | null;
  teardownScript: string | null;
  defaultRunCommand: string | null;
}

interface PersistedProject {
  id: string;
  name: string;
  path: string;
  selectedWorkspaceIndex: number;
  workspaces: unknown[];
  defaultBranch: string;
  setupScript: string | null;
  teardownScript: string | null;
  defaultRunCommand: string | null;
  workspaceNames?: Record<string, string>;
  workspaceOrder?: string[];
}

interface PersistedState {
  projects: PersistedProject[];
  selectedProjectIndex: number;
}

export class ProjectManager {
  private state: PersistedState;
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? manorDataDir();
    this.state = this.loadState();
  }

  private projectsFilePath(): string {
    return path.join(this.dataDir, "projects.json");
  }

  private loadState(): PersistedState {
    try {
      const data = fs.readFileSync(this.projectsFilePath(), "utf-8");
      return JSON.parse(data);
    } catch {
      return { projects: [], selectedProjectIndex: 0 };
    }
  }

  private saveState(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.projectsFilePath(), JSON.stringify(this.state, null, 2));
  }

  getProjects(): ProjectInfo[] {
    return this.state.projects.map((p) => this.buildProjectInfo(p));
  }

  getSelectedProjectIndex(): number {
    return this.state.selectedProjectIndex;
  }

  selectProject(index: number): void {
    this.state.selectedProjectIndex = index;
    this.saveState();
  }

  addProject(name: string, projectPath: string): ProjectInfo {
    const id = crypto.randomUUID();
    const project: PersistedProject = {
      id,
      name,
      path: projectPath,
      selectedWorkspaceIndex: 0,
      workspaces: [],
      defaultBranch: "main",
      setupScript: null,
      teardownScript: null,
      defaultRunCommand: null,
    };
    this.state.projects.push(project);
    this.state.selectedProjectIndex = this.state.projects.length - 1;
    this.saveState();

    const workspaces = listGitWorkspaces(projectPath) ?? [
      { path: projectPath, branch: "main", isMain: true, name: null },
    ];

    return {
      id,
      name,
      path: projectPath,
      defaultBranch: "main",
      workspaces,
      selectedWorkspaceIndex: 0,
      setupScript: null,
      teardownScript: null,
      defaultRunCommand: null,
    };
  }

  removeProject(projectId: string): void {
    this.state.projects = this.state.projects.filter((p) => p.id !== projectId);
    if (this.state.selectedProjectIndex >= this.state.projects.length) {
      this.state.selectedProjectIndex = Math.max(0, this.state.projects.length - 1);
    }
    this.saveState();
  }

  selectWorkspace(projectId: string, workspaceIndex: number): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (project) {
      project.selectedWorkspaceIndex = workspaceIndex;
      this.saveState();
    }
  }

  renameWorkspace(projectId: string, workspacePath: string, newName: string): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    if (!project.workspaceNames) project.workspaceNames = {};
    if (newName.trim() === "") {
      delete project.workspaceNames[workspacePath];
    } else {
      project.workspaceNames[workspacePath] = newName.trim();
    }
    this.saveState();
  }

  updateProject(projectId: string, updates: Partial<Pick<PersistedProject, "name" | "setupScript" | "teardownScript" | "defaultRunCommand">>): ProjectInfo | null {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return null;
    Object.assign(project, updates);
    this.saveState();
    return this.buildProjectInfo(project);
  }

  private buildProjectInfo(p: PersistedProject): ProjectInfo {
    const rawWorkspaces = listGitWorkspaces(p.path) ?? [
      { path: p.path, branch: p.defaultBranch, isMain: true, name: null },
    ];
    // Apply persisted ordering
    const order = p.workspaceOrder;
    if (order && order.length > 0) {
      const orderMap = new Map(order.map((path, i) => [path, i]));
      rawWorkspaces.sort((a, b) => {
        const ai = orderMap.get(a.path) ?? Infinity;
        const bi = orderMap.get(b.path) ?? Infinity;
        return ai - bi;
      });
    }
    const names = p.workspaceNames ?? {};
    const workspaces = rawWorkspaces.map((ws) => ({
      ...ws,
      name: names[ws.path] ?? null,
    }));
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      defaultBranch: p.defaultBranch,
      workspaces,
      selectedWorkspaceIndex: p.selectedWorkspaceIndex,
      setupScript: p.setupScript,
      teardownScript: p.teardownScript,
      defaultRunCommand: p.defaultRunCommand,
    };
  }

  reorderWorkspaces(projectId: string, orderedPaths: string[]): void {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return;
    project.workspaceOrder = orderedPaths;
    this.saveState();
  }

  removeWorktree(projectPath: string, worktreePath: string): void {
    execSync(`git worktree remove ${JSON.stringify(worktreePath)}`, {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 10000,
    });
  }

  createWorktree(projectId: string, name: string, branch?: string): ProjectInfo | null {
    const project = this.state.projects.find((p) => p.id === projectId);
    if (!project) return null;

    const branchName = branch || name;
    // Place worktree as sibling directory: <project-parent>/<name>
    const worktreePath = path.join(path.dirname(project.path), name);

    execSync(
      `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branchName)}`,
      {
        cwd: project.path,
        encoding: "utf-8",
        timeout: 15000,
      }
    );

    // Set custom name if provided
    if (!project.workspaceNames) project.workspaceNames = {};
    project.workspaceNames[worktreePath] = name;
    this.saveState();

    return this.buildProjectInfo(project);
  }
}

function listGitWorkspaces(projectPath: string): WorkspaceInfo[] | null {
  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: projectPath,
      encoding: "utf-8",
      timeout: 5000,
    });

    const workspaces: WorkspaceInfo[] = [];
    let currentPath = "";
    let currentBranch = "";
    let isFirst = true;

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (currentPath) {
          workspaces.push({ path: currentPath, branch: currentBranch, isMain: isFirst, name: null });
          isFirst = false;
        }
        currentPath = line.slice(9);
        currentBranch = "";
      } else if (line.startsWith("branch refs/heads/")) {
        currentBranch = line.slice(18);
      } else if (line === "" && currentPath) {
        workspaces.push({ path: currentPath, branch: currentBranch, isMain: isFirst, name: null });
        isFirst = false;
        currentPath = "";
        currentBranch = "";
      }
    }

    if (currentPath) {
      workspaces.push({ path: currentPath, branch: currentBranch, isMain: isFirst, name: null });
    }

    return workspaces.length > 0 ? workspaces : null;
  } catch {
    return null;
  }
}
