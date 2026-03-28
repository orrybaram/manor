/**
 * ExternalSessionManager — discovers and tracks agent sessions that were
 * started outside of Manor (e.g. from a terminal, VS Code, Cursor).
 *
 * External sessions are identified by the `external:{pid}` pane ID pattern
 * sent by the hook script when MANOR_PANE_ID is not set.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import type { TaskManager, TaskInfo } from "./task-persistence";
import type { AgentStatus, AgentKind } from "./terminal-host/types";

interface TrackedSession {
  pid: number;
  agentSessionId: string;
  taskId: string;
  startedAt: number | null;
  cwd: string;
  sourceApp: string | null;
}

interface ClaudeSessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind?: string;
  entrypoint?: string;
}

interface IdeLockFile {
  pid: number;
  workspaceFolders?: string[];
  ideName: string;
  transport?: string;
}

const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const CLAUDE_IDE_DIR = path.join(os.homedir(), ".claude", "ide");
const POLL_INTERVAL_MS = 10_000;

export class ExternalSessionManager {
  private taskManager: TaskManager;
  private getOwnPids: () => Set<number>;
  private broadcastTask: (task: TaskInfo) => void;
  private tracked = new Map<number, TrackedSession>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    taskManager: TaskManager,
    getOwnPids: () => Set<number>,
    broadcastTask: (task: TaskInfo) => void,
  ) {
    this.taskManager = taskManager;
    this.getOwnPids = getOwnPids;
    this.broadcastTask = broadcastTask;
  }

  /** Handle a hook event for an external session */
  handleHookEvent(
    pid: number,
    status: AgentStatus,
    kind: AgentKind,
    sessionId: string | null,
    eventType: string,
  ): void {
    // Skip PIDs that belong to Manor
    if (this.getOwnPids().has(pid)) return;

    const existing = this.tracked.get(pid);

    if (existing) {
      // Check for PID reuse: re-read session file and compare startedAt
      const sessionData = this.readSessionFile(pid);
      if (
        sessionData &&
        existing.startedAt !== null &&
        sessionData.startedAt !== existing.startedAt
      ) {
        // PID was reused — complete old task and create new one
        this.completeSession(pid);
        this.createSessionFromHook(pid, status, kind, sessionId, sessionData);
        return;
      }

      // Update existing task
      const task = this.taskManager.updateTask(existing.taskId, {
        lastAgentStatus: status,
        status: this.isTerminalStatus(eventType) ? "completed" : "active",
      });
      if (task) this.broadcastTask(task);
      return;
    }

    // New external session
    const sessionData = this.readSessionFile(pid);
    this.createSessionFromHook(pid, status, kind, sessionId, sessionData);
  }

  /** Run initial scan of ~/.claude/sessions/ and start polling */
  startPolling(): void {
    this.scanExistingSessions();

    this.pollTimer = setInterval(() => {
      this.checkLiveness();
    }, POLL_INTERVAL_MS);
  }

  /** Stop polling */
  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Clean shutdown */
  dispose(): void {
    this.stopPolling();
    this.tracked.clear();
  }

  // ── Private helpers ──

  private createSessionFromHook(
    pid: number,
    status: AgentStatus,
    kind: AgentKind,
    sessionId: string | null,
    sessionData: ClaudeSessionFile | null,
  ): void {
    const agentSessionId =
      sessionData?.sessionId ??
      sessionId ??
      `external-${pid}-${Date.now()}`;
    const cwd = sessionData?.cwd ?? "";
    const startedAt = sessionData?.startedAt ?? null;
    const sourceApp = this.detectSourceApp(pid);

    const task = this.taskManager.createTask({
      agentSessionId,
      name: null,
      status: "active",
      completedAt: null,
      projectId: null,
      projectName: null,
      workspacePath: cwd || null,
      cwd,
      agentKind: kind,
      paneId: null,
      lastAgentStatus: status,
      external: true,
      sourceApp,
    });

    this.tracked.set(pid, {
      pid,
      agentSessionId,
      taskId: task.id,
      startedAt,
      cwd,
      sourceApp,
    });

    this.broadcastTask(task);
  }

  private scanExistingSessions(): void {
    let files: string[];
    try {
      files = fs.readdirSync(CLAUDE_SESSIONS_DIR).filter((f) =>
        f.endsWith(".json"),
      );
    } catch {
      return; // Directory may not exist
    }

    const ownPids = this.getOwnPids();

    for (const file of files) {
      const pidStr = path.basename(file, ".json");
      const pid = Number(pidStr);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (ownPids.has(pid)) continue;
      if (this.tracked.has(pid)) continue;
      if (!this.isPidAlive(pid)) continue;

      const sessionData = this.readSessionFile(pid);
      if (!sessionData) continue;

      const agentSessionId = sessionData.sessionId ?? `external-${pid}-${sessionData.startedAt}`;
      const sourceApp = this.detectSourceApp(pid);

      const task = this.taskManager.createTask({
        agentSessionId,
        name: null,
        status: "active",
        completedAt: null,
        projectId: null,
        projectName: null,
        workspacePath: sessionData.cwd || null,
        cwd: sessionData.cwd ?? "",
        agentKind: "claude",
        paneId: null,
        lastAgentStatus: null,
        external: true,
        sourceApp,
      });

      this.tracked.set(pid, {
        pid,
        agentSessionId,
        taskId: task.id,
        startedAt: sessionData.startedAt,
        cwd: sessionData.cwd,
        sourceApp,
      });

      this.broadcastTask(task);
    }
  }

  private checkLiveness(): void {
    for (const [pid, session] of this.tracked) {
      if (!this.isPidAlive(pid)) {
        this.completeSession(pid);
      } else {
        // Check for PID reuse
        const sessionData = this.readSessionFile(pid);
        if (
          sessionData &&
          session.startedAt !== null &&
          sessionData.startedAt !== session.startedAt
        ) {
          this.completeSession(pid);
        }
      }
    }
  }

  private completeSession(pid: number): void {
    const session = this.tracked.get(pid);
    if (!session) return;

    this.tracked.delete(pid);
    const task = this.taskManager.updateTask(session.taskId, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    if (task) this.broadcastTask(task);
  }

  private readSessionFile(pid: number): ClaudeSessionFile | null {
    try {
      const filePath = path.join(CLAUDE_SESSIONS_DIR, `${pid}.json`);
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data) as ClaudeSessionFile;
    } catch {
      return null;
    }
  }

  private detectSourceApp(pid: number): string | null {
    // First try IDE lock file
    try {
      const lockPath = path.join(CLAUDE_IDE_DIR, `${pid}.lock`);
      const data = fs.readFileSync(lockPath, "utf-8");
      const lock = JSON.parse(data) as IdeLockFile;
      if (lock.ideName) return lock.ideName;
    } catch {
      // No lock file or invalid; fall through to ps
    }

    // Fall back to ps
    try {
      const output = (execFileSync("ps", ["-o", "comm=", "-p", String(pid)], {
        encoding: "utf-8",
        timeout: 2000,
      }) as string).trim();

      if (output) {
        // Map common process names
        const name = path.basename(output);
        if (name.toLowerCase().includes("iterm")) return "iTerm";
        if (name.toLowerCase().includes("terminal")) return "Terminal";
        if (name.toLowerCase().includes("alacritty")) return "Alacritty";
        if (name.toLowerCase().includes("kitty")) return "Kitty";
        if (name.toLowerCase().includes("wezterm")) return "WezTerm";
        if (name.toLowerCase().includes("warp")) return "Warp";
        return name;
      }
    } catch {
      // ps failed; return null
    }

    return null;
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private isTerminalStatus(eventType: string): boolean {
    return eventType === "SessionEnd";
  }
}
