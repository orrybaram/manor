import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

function manorDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Manor");
  }
  return path.join(os.homedir(), ".local", "share", "Manor");
}

export interface TaskInfo {
  id: string;
  claudeSessionId: string;
  name: string | null;
  status: "active" | "completed" | "error" | "abandoned";
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  projectId: string | null;
  projectName: string | null;
  workspacePath: string | null;
  cwd: string;
  agentKind: "claude" | "opencode" | "codex";
  paneId: string | null;
  lastAgentStatus: string | null;
}

interface PersistedState {
  tasks: TaskInfo[];
}

export class TaskManager {
  private dataDir: string;
  private tasks: Map<string, TaskInfo>;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? manorDataDir();
    this.tasks = this.loadState();
  }

  private tasksFilePath(): string {
    return path.join(this.dataDir, "tasks.json");
  }

  private loadState(): Map<string, TaskInfo> {
    try {
      const data = fs.readFileSync(this.tasksFilePath(), "utf-8");
      const state: PersistedState = JSON.parse(data);
      const map = new Map<string, TaskInfo>();
      for (const task of state.tasks ?? []) {
        map.set(task.claudeSessionId, task);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private saveState(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const tasks = Array.from(this.tasks.values());
      const state: PersistedState = { tasks };
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.tasksFilePath(), JSON.stringify(state, null, 2));
    }, 500);
  }

  createTask(data: Omit<TaskInfo, "id" | "createdAt" | "updatedAt">): TaskInfo {
    const now = new Date().toISOString();
    const task: TaskInfo = {
      ...data,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.claudeSessionId, task);
    this.saveState();
    return task;
  }

  updateTask(id: string, updates: Partial<TaskInfo>): TaskInfo | null {
    const task = Array.from(this.tasks.values()).find((t) => t.id === id);
    if (!task) return null;
    const updated: TaskInfo = {
      ...task,
      ...updates,
      id: task.id,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(updated.claudeSessionId, updated);
    this.saveState();
    return updated;
  }

  getTaskBySessionId(claudeSessionId: string): TaskInfo | null {
    return this.tasks.get(claudeSessionId) ?? null;
  }

  getAllTasks(opts?: {
    projectId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): TaskInfo[] {
    let tasks = Array.from(this.tasks.values());

    if (opts?.projectId !== undefined) {
      tasks = tasks.filter((t) => t.projectId === opts.projectId);
    }
    if (opts?.status !== undefined) {
      tasks = tasks.filter((t) => t.status === opts.status);
    }

    tasks.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const offset = opts?.offset ?? 0;
    tasks = tasks.slice(offset);

    if (opts?.limit !== undefined) {
      tasks = tasks.slice(0, opts.limit);
    }

    return tasks;
  }

  setTaskStatus(id: string, status: TaskInfo["status"]): void {
    const task = Array.from(this.tasks.values()).find((t) => t.id === id);
    if (!task) return;

    const now = new Date().toISOString();
    const completedAt =
      status === "completed" || status === "error" ? now : task.completedAt;

    const updated: TaskInfo = {
      ...task,
      status,
      completedAt,
      updatedAt: now,
    };
    this.tasks.set(updated.claudeSessionId, updated);
    this.saveState();
  }

  linkPane(claudeSessionId: string, paneId: string): void {
    const task = this.tasks.get(claudeSessionId);
    if (!task) return;
    const updated: TaskInfo = {
      ...task,
      paneId,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(claudeSessionId, updated);
    this.saveState();
  }

  unlinkPane(paneId: string): void {
    let changed = false;
    for (const [sessionId, task] of this.tasks) {
      if (task.paneId === paneId) {
        this.tasks.set(sessionId, {
          ...task,
          paneId: null,
          updatedAt: new Date().toISOString(),
        });
        changed = true;
      }
    }
    if (changed) this.saveState();
  }
}
