import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

import type { LinearAssociation, LinkedIssue } from "./linear";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

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

export interface CustomCommand {
  id: string;
  name: string;
  command: string;
}

export interface WorkspaceInfo {
  path: string;
  branch: string;
  isMain: boolean;
  name: string | null;
  linkedIssues?: LinkedIssue[];
}

export type { LinkedIssue };

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
  commands: CustomCommand[];
  themeName: string | null;
  setupComplete: boolean;
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
    | "commands"
    | "themeName"
    | "setupComplete"
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
  workspaceIssues?: Record<string, LinkedIssue[]>;
  color?: string | null;
  agentCommand?: string | null;
  commands?: CustomCommand[];
  themeName?: string | null;
  setupComplete?: boolean;
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
    return Promise.all(
      this.state.projects.map((p) => this.buildProjectInfo(p)),
    );
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
      commands: [],
      themeName: null,
      setupComplete: false,
    };

    // Seed commands from package.json if present
    const packageJsonPath = path.join(projectPath, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(
          fs.readFileSync(packageJsonPath, "utf-8"),
        );
        if (packageJson.scripts && typeof packageJson.scripts === "object") {
          const runner = fs.existsSync(path.join(projectPath, "pnpm-lock.yaml"))
            ? "pnpm run"
            : fs.existsSync(path.join(projectPath, "yarn.lock"))
              ? "yarn"
              : "npm run";
          project.commands = Object.keys(packageJson.scripts).map(
            (scriptName) => ({
              id: crypto.randomUUID(),
              name: scriptName,
              command: `${runner} ${scriptName}`,
            }),
          );
        }
      } catch (err) {
        console.error(
          "[ProjectManager] failed to read package.json:",
          err instanceof Error ? err.message : err,
        );
      }
    }

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
      commands: project.commands ?? [],
      themeName: null,
      setupComplete: false,
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
    if (updates.worktreePath) {
      updates.worktreePath = expandHome(updates.worktreePath);
    }
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
    const issues = p.workspaceIssues ?? {};
    const workspaces = rawWorkspaces.map((ws) => ({
      ...ws,
      name: names[ws.path] ?? null,
      linkedIssues: issues[ws.path] ?? [],
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
      commands: p.commands ?? [],
      themeName: p.themeName ?? null,
      setupComplete: p.setupComplete ?? true,
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

  linkIssueToWorkspace(
    projectId: string,
    workspacePath: string,
    issue: LinkedIssue,
  ): void {
    const project = this.findProject(projectId);
    if (!project) return;
    if (!project.workspaceIssues) project.workspaceIssues = {};
    const existing = project.workspaceIssues[workspacePath] ?? [];
    if (!existing.some((i) => i.id === issue.id)) {
      project.workspaceIssues[workspacePath] = [...existing, issue];
    }
    this.saveState();
  }

  unlinkIssueFromWorkspace(
    projectId: string,
    workspacePath: string,
    issueId: string,
  ): void {
    const project = this.findProject(projectId);
    if (!project) return;
    if (!project.workspaceIssues) return;
    const existing = project.workspaceIssues[workspacePath] ?? [];
    project.workspaceIssues[workspacePath] = existing.filter(
      (i) => i.id !== issueId,
    );
    this.saveState();
  }

  getWorkspaceIssues(
    projectId: string,
    workspacePath: string,
  ): LinkedIssue[] {
    const project = this.findProject(projectId);
    if (!project) return [];
    return project.workspaceIssues?.[workspacePath] ?? [];
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
    onProgress?: (step: string) => void,
  ): Promise<void> {
    const project = this.findProject(projectId);
    if (!project) return;

    const progress = onProgress ?? (() => {});

    // Detect the branch before removing the worktree
    let branchName: string | null = null;
    if (deleteBranch) {
      progress("Detecting branch…");
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
      } catch (err) {
        console.error(
          "[ProjectManager] failed to detect branch for worktree:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Run worktree teardown script before removal
    if (project.worktreeTeardownScript) {
      progress("Running teardown script…");
      try {
        await execAsync(project.worktreeTeardownScript, {
          cwd: worktreePath,
          timeout: 30000,
        });
      } catch (err) {
        console.error(
          "[ProjectManager] worktree teardown script failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    progress("Removing worktree files…");
    try {
      await execAsync(
        `git worktree remove --force ${JSON.stringify(worktreePath)}`,
        {
          cwd: project.path,
          timeout: 300_000, // 5 minutes — large repos with node_modules can be slow
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ProjectManager] git worktree remove failed:", message);

      // Check if the directory is actually gone (e.g. already removed externally)
      const { existsSync } = await import("fs");
      if (existsSync(worktreePath)) {
        // Directory still exists — this is a real failure, surface it
        throw new Error(`Failed to remove worktree: ${message}`, { cause: err });
      }

      // Directory is gone — prune stale git metadata and continue
      progress("Pruning stale worktree entries…");
      try {
        await execAsync("git worktree prune", {
          cwd: project.path,
          timeout: 10000,
        });
      } catch (pruneErr) {
        console.error(
          "[ProjectManager] git worktree prune failed:",
          pruneErr instanceof Error ? pruneErr.message : pruneErr,
        );
      }
    }

    // Clean up workspace metadata
    progress("Cleaning up metadata…");
    if (project.workspaceNames) {
      delete project.workspaceNames[worktreePath];
    }
    if (project.workspaceOrder) {
      project.workspaceOrder = project.workspaceOrder.filter(
        (p) => p !== worktreePath,
      );
    }
    if (project.workspaceIssues) {
      delete project.workspaceIssues[worktreePath];
    }
    this.saveState();

    if (deleteBranch && branchName) {
      progress("Deleting branch…");
      try {
        await execAsync(`git branch -D ${JSON.stringify(branchName)}`, {
          cwd: project.path,
          timeout: 10000,
        });
      } catch (err) {
        console.error(
          "[ProjectManager] git branch -D failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  async canQuickMerge(
    projectId: string,
    worktreePath: string,
  ): Promise<{ canMerge: boolean; reason?: string }> {
    const project = this.findProject(projectId);
    if (!project) return { canMerge: false, reason: "Project not found" };

    if (worktreePath === project.path) {
      return { canMerge: false, reason: "Cannot merge main workspace" };
    }

    // Detect branch name from git worktree list --porcelain
    let branchName: string | null = null;
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
    } catch (err) {
      console.error(
        "[ProjectManager] canQuickMerge: failed to detect branch for worktree:",
        err instanceof Error ? err.message : err,
      );
    }

    // Check for uncommitted changes in source worktree
    try {
      const { stdout } = await execAsync("git status --porcelain", {
        cwd: worktreePath,
        timeout: 10000,
      });
      if (stdout.trim().length > 0) {
        return { canMerge: false, reason: "Uncommitted changes in workspace" };
      }
    } catch (err) {
      console.error(
        "[ProjectManager] canQuickMerge: failed to check git status:",
        err instanceof Error ? err.message : err,
      );
    }

    // Check for uncommitted changes in main worktree (merge target)
    try {
      const { stdout } = await execAsync("git status --porcelain", {
        cwd: project.path,
        timeout: 10000,
      });
      if (stdout.trim().length > 0) {
        return { canMerge: false, reason: "Uncommitted changes in main workspace" };
      }
    } catch (err) {
      console.error(
        "[ProjectManager] canQuickMerge: failed to check main worktree git status:",
        err instanceof Error ? err.message : err,
      );
    }

    // Check fast-forward eligibility
    if (branchName) {
      try {
        await execAsync(
          `git merge-base --is-ancestor ${JSON.stringify(project.defaultBranch)} ${JSON.stringify(branchName)}`,
          {
            cwd: project.path,
            timeout: 10000,
          },
        );
      } catch {
        return { canMerge: false, reason: "Branch has diverged" };
      }
    }

    return { canMerge: true };
  }

  async quickMergeWorktree(
    projectId: string,
    worktreePath: string,
  ): Promise<void> {
    const check = await this.canQuickMerge(projectId, worktreePath);
    if (!check.canMerge) {
      throw new Error(
        `[ProjectManager] quickMergeWorktree: cannot merge — ${check.reason}`,
      );
    }

    const project = this.findProject(projectId);
    if (!project) return;

    // Detect branch name
    let branchName: string | null = null;
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
    } catch (err) {
      console.error(
        "[ProjectManager] quickMergeWorktree: failed to detect branch for worktree:",
        err instanceof Error ? err.message : err,
      );
    }

    if (!branchName) {
      throw new Error(
        "[ProjectManager] quickMergeWorktree: could not detect branch name",
      );
    }

    try {
      await execAsync(
        `git merge --ff-only ${JSON.stringify(branchName)}`,
        {
          cwd: project.path,
          timeout: 30000,
        },
      );
    } catch (err) {
      console.error(
        "[ProjectManager] quickMergeWorktree: git merge --ff-only failed:",
        err instanceof Error ? err.message : err,
      );
      throw err;
    }

    await this.removeWorktree(projectId, worktreePath, true);
  }

  async listRemoteBranches(projectId: string): Promise<string[]> {
    const project = this.findProject(projectId);
    if (!project) return [];

    try {
      // Fetch latest remote refs so for-each-ref has up-to-date data
      await execAsync("git fetch origin --prune", {
        cwd: project.path,
        timeout: 30000,
      });

      const { stdout } = await execAsync(
        'git for-each-ref --sort=-creatordate --format="%(refname:strip=3)" refs/remotes/origin',
        { cwd: project.path, timeout: 15000 },
      );

      const branches = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((b) => b && b !== "HEAD");

      return branches;
    } catch (err) {
      console.error(
        "[ProjectManager] git ls-remote --heads origin failed:",
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  }

  async createWorktree(
    projectId: string,
    name: string,
    branch?: string,
    linkedIssue?: LinkedIssue,
  ): Promise<ProjectInfo | null> {
    const project = this.findProject(projectId);
    if (!project) return null;

    const branchName = branch || name;
    const slug = slugify(name);
    const baseDir = project.worktreePath
      ? expandHome(project.worktreePath)
      : path.join(os.homedir(), ".manor", "worktrees", slugify(project.name));
    const worktreePath = path.join(baseDir, slug);

    // Prune stale worktree entries (e.g. leftover from a previous failed creation)
    try {
      await execFileAsync("git", ["worktree", "prune"], {
        cwd: project.path,
        timeout: 10000,
      });
    } catch (err) {
      console.error(
        "[ProjectManager] git worktree prune failed:",
        err instanceof Error ? err.message : err,
      );
    }

    // If an existing branch was selected, fetch first so local refs are up-to-date
    if (branch) {
      try {
        await execFileAsync("git", ["fetch", "origin", branchName], {
          cwd: project.path,
          timeout: 30000,
        });
      } catch (err) {
        console.error(
          "[ProjectManager] git fetch before checkout failed:",
          err instanceof Error ? err.message : err,
        );
      }
    } else {
      // Creating a new branch — fetch origin so we base off the latest remote refs
      try {
        await execFileAsync("git", ["fetch", "origin"], {
          cwd: project.path,
          timeout: 30000,
        });
      } catch (err) {
        console.error(
          "[ProjectManager] git fetch origin before new worktree failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const defaultBranchRef = `origin/${project.defaultBranch || "main"}`;

    try {
      await execFileAsync(
        "git",
        ["worktree", "add", worktreePath, "-b", branchName, defaultBranchRef],
        {
          cwd: project.path,
          timeout: 15000,
        },
      );
    } catch (createErr) {
      console.error(
        "[ProjectManager] git worktree add -b failed:",
        createErr instanceof Error ? createErr.message : createErr,
      );
      // Branch already exists — create worktree checking out the existing branch
      try {
        await execFileAsync(
          "git",
          ["worktree", "add", worktreePath, branchName],
          {
            cwd: project.path,
            timeout: 15000,
          },
        );
      } catch {
        // Neither new branch nor existing local branch — try remote tracking branch
        try {
          await execFileAsync(
            "git",
            ["fetch", "origin", branchName],
            { cwd: project.path, timeout: 30000 },
          );
          await execFileAsync(
            "git",
            ["worktree", "add", worktreePath, "-b", branchName, `origin/${branchName}`],
            { cwd: project.path, timeout: 15000 },
          );
        } catch (remoteErr) {
          console.error(
            "[ProjectManager] git worktree add from remote also failed:",
            remoteErr instanceof Error ? remoteErr.message : remoteErr,
          );
          throw remoteErr;
        }
      }
    }

    // Set custom name only if it differs from the branch
    if (name !== branchName) {
      if (!project.workspaceNames) project.workspaceNames = {};
      project.workspaceNames[worktreePath] = name;
    }

    // Auto-link the issue if provided
    if (linkedIssue) {
      if (!project.workspaceIssues) project.workspaceIssues = {};
      const existing = project.workspaceIssues[worktreePath] ?? [];
      if (!existing.some((i) => i.id === linkedIssue.id)) {
        project.workspaceIssues[worktreePath] = [...existing, linkedIssue];
      }
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
