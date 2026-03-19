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

function projectsFile(): string {
  return path.join(manorDataDir(), "projects.json");
}

export interface WorkspaceInfo {
  path: string;
  branch: string;
  isMain: boolean;
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
}

interface PersistedState {
  projects: PersistedProject[];
  selectedProjectIndex: number;
}

export class ProjectManager {
  private state: PersistedState;

  constructor() {
    this.state = this.loadState();
  }

  private loadState(): PersistedState {
    try {
      const data = fs.readFileSync(projectsFile(), "utf-8");
      return JSON.parse(data);
    } catch {
      return { projects: [], selectedProjectIndex: 0 };
    }
  }

  private saveState(): void {
    const dir = manorDataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(projectsFile(), JSON.stringify(this.state, null, 2));
  }

  getProjects(): ProjectInfo[] {
    return this.state.projects.map((p) => {
      const workspaces = listGitWorkspaces(p.path) ?? [
        { path: p.path, branch: p.defaultBranch, isMain: true },
      ];
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
    });
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
      { path: projectPath, branch: "main", isMain: true },
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
          workspaces.push({ path: currentPath, branch: currentBranch, isMain: isFirst });
          isFirst = false;
        }
        currentPath = line.slice(9);
        currentBranch = "";
      } else if (line.startsWith("branch refs/heads/")) {
        currentBranch = line.slice(18);
      } else if (line === "" && currentPath) {
        workspaces.push({ path: currentPath, branch: currentBranch, isMain: isFirst });
        isFirst = false;
        currentPath = "";
        currentBranch = "";
      }
    }

    if (currentPath) {
      workspaces.push({ path: currentPath, branch: currentBranch, isMain: isFirst });
    }

    return workspaces.length > 0 ? workspaces : null;
  } catch {
    return null;
  }
}
