import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import {
  getUnseenSnapshot,
  sendTaskUpdate,
  updateDockBadge,
} from "../notifications";
import { cleanAgentTitle } from "../title-utils";
import type { IpcDeps } from "./types";

const ALLOWED_RENDERER_TASK_FIELDS: ReadonlySet<string> = new Set([
  "name",
]);

function assertRendererTaskUpdate(updates: unknown): asserts updates is Record<string, unknown> {
  if (!updates || typeof updates !== "object") {
    throw new Error("tasks:update: updates must be an object");
  }
  for (const key of Object.keys(updates as object)) {
    if (!ALLOWED_RENDERER_TASK_FIELDS.has(key)) {
      throw new Error(`tasks:update: field "${key}" is not writable from renderer`);
    }
  }
}

export function register(deps: IpcDeps): void {
  const {
    taskManager,
    paneContextMap,
    unseenRespondedTasks,
    unseenInputTasks,
    preferencesManager,
    backend,
  } = deps;

  ipcMain.handle(
    "tasks:getAll",
    (
      _event,
      opts?: {
        projectId?: string;
        status?: string;
        limit?: number;
        offset?: number;
      },
    ) => {
      return taskManager.getAllTasks(opts);
    },
  );

  ipcMain.handle("tasks:get", (_event, taskId: string) => {
    assertString(taskId, "taskId");
    return taskManager.getTaskById(taskId);
  });

  ipcMain.handle("tasks:getActive", () => {
    return taskManager.getActiveTasks();
  });

  ipcMain.handle("tasks:getRecent", (_event, opts?: { limit?: number }) => {
    const limit = opts?.limit ?? 50;
    return taskManager.getAllTasks({ limit });
  });

  /**
   * Returns the full unseen-flag snapshot from main as `{ responded, requires_input }`
   * arrays of task ids. Used by the renderer on boot to prime its cache so
   * the pulse-state matches main exactly. See ADR-136 §"Change 3".
   */
  ipcMain.handle("tasks:getUnseen", () => {
    return getUnseenSnapshot();
  });

  /**
   * Returns the count of tasks pruned during the most recent TaskManager
   * boot, exactly once per upgrade. After the renderer consumes it, the
   * `taskPruneNoticeShown` flag is set so subsequent boots return 0.
   */
  ipcMain.handle("tasks:consumePruneNotice", () => {
    const count = taskManager.getLastPruneCount();
    if (count <= 0) return 0;
    if (preferencesManager.get("taskPruneNoticeShown")) return 0;
    preferencesManager.set("taskPruneNoticeShown", true);
    return count;
  });

  ipcMain.handle(
    "tasks:update",
    (_event, taskId: string, updates: unknown) => {
      assertString(taskId, "taskId");
      assertRendererTaskUpdate(updates);
      return taskManager.updateTask(taskId, updates);
    },
  );

  ipcMain.handle("tasks:delete", (_event, taskId: string) => {
    assertString(taskId, "taskId");
    unseenRespondedTasks.delete(taskId);
    unseenInputTasks.delete(taskId);
    const result = taskManager.deleteTask(taskId);
    updateDockBadge(preferencesManager);
    return result;
  });

  ipcMain.handle("tasks:markSeen", (_event, taskId: string) => {
    assertString(taskId, "taskId");
    unseenRespondedTasks.delete(taskId);
    unseenInputTasks.delete(taskId);
    // Re-broadcast so the renderer cache reflects the cleared flags. The task
    // itself didn't mutate, but `sendTaskUpdate` ships the unseen flags
    // alongside it — this is what keeps main authoritative for pulse state.
    const all = taskManager.getAllTasks();
    const task = all.find((t) => t.id === taskId) ?? null;
    if (task) {
      sendTaskUpdate(deps.mainWindow, task, preferencesManager);
    } else {
      // Task is gone (deleted before markSeen reached us) — at least refresh
      // the dock badge since the Sets just shrank.
      updateDockBadge(preferencesManager);
    }
  });

  ipcMain.handle("tasks:markResumed", (_event, taskId: string) => {
    assertString(taskId, "taskId");
    return taskManager.updateTask(taskId, {
      resumedAt: new Date().toISOString(),
    });
  });

  ipcMain.handle(
    "tasks:setPaneContext",
    (
      _event,
      paneId: string,
      context: { projectId: string; projectName: string; workspacePath: string; agentCommand: string | null },
    ) => {
      assertString(paneId, "paneId");
      assertString(context.projectId, "projectId");
      assertString(context.projectName, "projectName");
      assertString(context.workspacePath, "workspacePath");
      paneContextMap.set(paneId, context);
    },
  );

  ipcMain.handle("tasks:abandonForPane", (_event, paneId: string, title?: string | null) => {
    assertString(paneId, "paneId");
    const task = taskManager.getTaskByPaneId(paneId);
    if (!task || task.status !== "active") return;
    const nameUpdate = !task.name && title ? cleanAgentTitle(title) : null;
    const updated = taskManager.updateTask(task.id, {
      status: "abandoned",
      completedAt: new Date().toISOString(),
      ...(nameUpdate ? { name: nameUpdate } : {}),
    });
    if (updated) {
      sendTaskUpdate(deps.mainWindow, updated, preferencesManager);
    }
  });

  ipcMain.handle("tasks:reconcileStale", async () => {
    let liveSessions: Array<{ sessionId: string }>;
    try {
      liveSessions = await backend.pty.listSessions();
    } catch {
      // Daemon unreachable — skip reconciliation
      return;
    }

    const livePaneIds = new Set(liveSessions.map((s) => s.sessionId));
    const allTasks = taskManager.getAllTasks();

    for (const task of allTasks) {
      if (task.status !== "active") continue;
      if (!task.paneId) continue;
      if (livePaneIds.has(task.paneId)) continue;
      if (task.lastAgentStatus === "responded") continue;

      const updated = taskManager.updateTask(task.id, {
        status: "abandoned",
        completedAt: new Date().toISOString(),
      });
      if (updated) {
        sendTaskUpdate(deps.mainWindow, updated, preferencesManager);
      }
    }
  });
}
