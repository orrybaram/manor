import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

import type { LinearAssociation } from "./linear";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

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
  defaultRunCommand: string | null;
  worktreePath: string | null;
  worktreeStartScript: string | null;
  worktreeTeardownScript: string | null;
  linearAssociations: LinearAssociation[];
  color: string | null;
  agentCommand: string | null;
}

export type ProjectUpdatableFields = Partial<
  Pick<
    ProjectInfo,
    | "name"
    | "defaultRunCommand"
    | "worktreePath"
    | "worktreeStartScript"
    | "worktreeTeardownScript"
    | "linearAssociations"
    | "color"
    | "agentCommand"
  >
>;

interface PersistedProject {
  id: string;
  name: string;
  path: string;
  selectedWorkspaceIndex: number;
  workspaces: unknown[];
  defaultBranch: string;
  defaultRunCommand: string | null;
  worktreePath: string | null;
  worktreeStartScript?: string | null;
  worktreeTeardownScript?: string | null;
  linearAssociations?: LinearAssociation[];
  workspaceNames?: Record<string, string>;
  workspaceOrder?: string[];
  color?: string | null;
  agentCommand?: string | null;
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
    fs.writeFileSync(
      this.projectsFilePath(),
      JSON.stringify(this.state, null, 2),
    );
  }

  private findProject(projectId: string): PersistedProject | undefined {
    return this.state.projects.find((p) => p.id === projectId);
  }

  async getProjects(): Promise<ProjectInfo[]> {
    return Promise.all(this.state.projects.map((p) => this.buildProjectInfo(p)));
  }

  getSelectedProjectIndex(): number {
    return this.state.selectedProjectIndex;
  }

  selectProject(index: number): void {
    this.state.selectedProjectIndex = index;
    this.saveState();
  }

  async addProject(name: string, projectPath: string): Promise<ProjectInfo> {
    const id = crypto.randomUUID();
    const project: PersistedProject = {
      id,
      name,
      path: projectPath,
      selectedWorkspaceIndex: 0,
      workspaces: [],
      defaultBranch: "main",
      defaultRunCommand: null,
      worktreePath: null,
      worktreeStartScript: null,
      worktreeTeardownScript: null,
      color: null,
      agentCommand: null,
    };
    this.state.projects.push(project);
    this.state.selectedProjectIndex = this.state.projects.length - 1;
    this.saveState();

    const workspaces = (await listGitWorkspaces(projectPath)) ?? [
      { path: projectPath, branch: "main", isMain: true, name: null },
    ];

    return {
      id,
      name,
      path: projectPath,
      defaultBranch: "main",
      workspaces,
      selectedWorkspaceIndex: 0,
      defaultRunCommand: null,
      worktreePath: null,
      worktreeStartScript: null,
      worktreeTeardownScript: null,
      linearAssociations: [],
      color: null,
      agentCommand: null,
    };
  }

  removeProject(projectId: string): void {
    this.state.projects = this.state.projects.filter((p) => p.id !== projectId);
    if (this.state.selectedProjectIndex >= this.state.projects.length) {
      this.state.selectedProjectIndex = Math.max(
        0,
        this.state.projects.length - 1,
      );
    }
    this.saveState();
  }

  selectWorkspace(projectId: string, workspaceIndex: number): void {
    const project = this.findProject(projectId);
    if (project) {
      project.selectedWorkspaceIndex = workspaceIndex;
      const projectIndex = this.state.projects.indexOf(project);
      if (projectIndex >= 0) {
        this.state.selectedProjectIndex = projectIndex;
      }
      this.saveState();
    }
  }

  renameWorkspace(
    projectId: string,
    workspacePath: string,
    newName: string,
  ): void {
    const project = this.findProject(projectId);
    if (!project) return;
    if (!project.workspaceNames) project.workspaceNames = {};
    if (newName.trim() === "") {
      delete project.workspaceNames[workspacePath];
    } else {
      project.workspaceNames[workspacePath] = newName.trim();
    }
    this.saveState();
  }

  async updateProject(
    projectId: string,
    updates: ProjectUpdatableFields,
  ): Promise<ProjectInfo | null> {
    const project = this.findProject(projectId);
    if (!project) return null;
    Object.assign(project, updates);
    this.saveState();
    return this.buildProjectInfo(project);
  }

  private async buildProjectInfo(p: PersistedProject): Promise<ProjectInfo> {
    const rawWorkspaces = (await listGitWorkspaces(p.path)) ?? [
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
      defaultRunCommand: p.defaultRunCommand,
      worktreePath: p.worktreePath ?? null,
      worktreeStartScript: p.worktreeStartScript ?? null,
      worktreeTeardownScript: p.worktreeTeardownScript ?? null,
      linearAssociations: p.linearAssociations ?? [],
      color: p.color ?? null,
      agentCommand: p.agentCommand ?? null,
    };
  }

  reorderProjects(orderedIds: string[]): void {
    const byId = new Map(this.state.projects.map((p) => [p.id, p]));
    const reordered = orderedIds
      .map((id) => byId.get(id))
      .filter((p): p is PersistedProject => p != null);
    // Append any projects not in orderedIds (shouldn't happen, but safe)
    const orderedSet = new Set(orderedIds);
    for (const p of this.state.projects) {
      if (!orderedSet.has(p.id)) reordered.push(p);
    }
    const selectedId = this.state.projects[this.state.selectedProjectIndex]?.id;
    this.state.projects = reordered;
    if (selectedId) {
      const newIdx = reordered.findIndex((p) => p.id === selectedId);
      if (newIdx >= 0) this.state.selectedProjectIndex = newIdx;
    }
    this.saveState();
  }

  reorderWorkspaces(projectId: string, orderedPaths: string[]): void {
    const project = this.findProject(projectId);
    if (!project) return;
    project.workspaceOrder = orderedPaths;
    this.saveState();
  }

  async removeWorktree(
    projectId: string,
    worktreePath: string,
    deleteBranch?: boolean,
  ): Promise<void> {
    const project = this.findProject(projectId);
    if (!project) return;

    // Detect the branch before removing the worktree
    let branchName: string | null = null;
    if (deleteBranch) {
      try {
        const { stdout } = await execAsync("git worktree list --porcelain", {
          cwd: project.path,
          timeout: 10000,
        });
        let currentPath = "";
        for (const line of stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            currentPath = line.slice(9);
          } else if (
            line.startsWith("branch refs/heads/") &&
            currentPath === worktreePath
          ) {
            branchName = line.slice(18);
          }
        }
      } catch {
        /* proceed without branch deletion */
      }
    }

    // Run worktree teardown script before removal
    if (project.worktreeTeardownScript) {
      try {
        await execAsync(project.worktreeTeardownScript, {
          cwd: worktreePath,
          timeout: 30000,
        });
      } catch {
        /* teardown script failure should not block removal */
      }
    }

    try {
      await execAsync(
        `git worktree remove --force ${JSON.stringify(worktreePath)}`,
        {
          cwd: project.path,
          timeout: 30000,
        },
      );
    } catch {
      // Worktree may already be gone — prune stale entries and continue
      try {
        await execAsync("git worktree prune", {
          cwd: project.path,
          timeout: 10000,
        });
      } catch {
        /* best effort */
      }
    }

    // Clean up workspace metadata
    if (project.workspaceNames) {
      delete project.workspaceNames[worktreePath];
    }
    if (project.workspaceOrder) {
      project.workspaceOrder = project.workspaceOrder.filter(
        (p) => p !== worktreePath,
      );
    }
    this.saveState();

    if (deleteBranch && branchName) {
      try {
        await execAsync(`git branch -D ${JSON.stringify(branchName)}`, {
          cwd: project.path,
          timeout: 10000,
        });
      } catch {
        /* branch may already be gone or is checked out elsewhere */
      }
    }
  }

  async createWorktree(
    projectId: string,
    name: string,
    branch?: string,
  ): Promise<ProjectInfo | null> {
    const project = this.findProject(projectId);
    if (!project) return null;

    const branchName = branch || name;
    const slug = slugify(name);
    const baseDir =
      project.worktreePath ||
      path.join(os.homedir(), ".manor", "worktrees", slugify(project.name));
    const worktreePath = path.join(baseDir, slug);

    // Prune stale worktree entries (e.g. leftover from a previous failed creation)
    try {
      await execFileAsync("git", ["worktree", "prune"], {
        cwd: project.path,
        timeout: 10000,
      });
    } catch {
      /* best-effort */
    }

    try {
      await execFileAsync(
        "git",
        ["worktree", "add", worktreePath, "-b", branchName],
        {
          cwd: project.path,
          timeout: 15000,
        },
      );
    } catch {
      // Branch already exists — create worktree checking out the existing branch
      await execFileAsync(
        "git",
        ["worktree", "add", worktreePath, branchName],
        {
          cwd: project.path,
          timeout: 15000,
        },
      );
    }

    // Set custom name only if it differs from the branch
    if (name !== branchName) {
      if (!project.workspaceNames) project.workspaceNames = {};
      project.workspaceNames[worktreePath] = name;
    }
    this.saveState();

    return this.buildProjectInfo(project);
  }
}

async function listGitWorkspaces(
  projectPath: string,
): Promise<WorkspaceInfo[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain"],
      {
        cwd: projectPath,
        timeout: 5000,
      },
    );

    const workspaces: WorkspaceInfo[] = [];
    let currentPath = "";
    let currentBranch = "";
    let isFirst = true;

    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (currentPath) {
          workspaces.push({
            path: currentPath,
            branch: currentBranch,
            isMain: isFirst,
            name: null,
          });
          isFirst = false;
        }
        currentPath = line.slice(9);
        currentBranch = "";
      } else if (line.startsWith("branch refs/heads/")) {
        currentBranch = line.slice(18);
      } else if (line === "" && currentPath) {
        workspaces.push({
          path: currentPath,
          branch: currentBranch,
          isMain: isFirst,
          name: null,
        });
        isFirst = false;
        currentPath = "";
        currentBranch = "";
      }
    }

    if (currentPath) {
      workspaces.push({
        path: currentPath,
        branch: currentBranch,
        isMain: isFirst,
        name: null,
      });
    }

    return workspaces.length > 0 ? workspaces : null;
  } catch {
    return null;
  }
}
