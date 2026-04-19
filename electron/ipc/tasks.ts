import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import { updateDockBadge } from "../notifications";
import { cleanAgentTitle } from "../title-utils";
import type { IpcDeps } from "./types";

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
    const all = taskManager.getAllTasks();
    return all.find((t) => t.id === taskId) ?? null;
  });

  ipcMain.handle(
    "tasks:update",
    (_event, taskId: string, updates: Record<string, unknown>) => {
      assertString(taskId, "taskId");
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
    updateDockBadge(preferencesManager);
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
    const updates: Parameters<typeof taskManager.updateTask>[1] = {
      status: "abandoned",
      completedAt: new Date().toISOString(),
    };
    if (!task.name && title) {
      const cleaned = cleanAgentTitle(title);
      if (cleaned) updates.name = cleaned;
    }
    const updated = taskManager.updateTask(task.id, updates);
    if (updated) {
      const { mainWindow } = deps;
      if (
        mainWindow &&
        !mainWindow.isDestroyed() &&
        !mainWindow.webContents.isDestroyed()
      ) {
        try {
          mainWindow.webContents.send("task-updated", updated);
        } catch {
          // Render frame disposed — safe to ignore
        }
      }
      updateDockBadge(preferencesManager);
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

    const liveIds = new Set(liveSessions.map((s) => s.sessionId));
    const allTasks = taskManager.getAllTasks();

    for (const task of allTasks) {
      if (
        task.status === "active" &&
        task.agentSessionId &&
        !liveIds.has(task.agentSessionId)
      ) {
        const updated = taskManager.updateTask(task.id, {
          status: "abandoned",
          completedAt: new Date().toISOString(),
        });
        if (updated) {
          const { mainWindow } = deps;
          if (
            mainWindow &&
            !mainWindow.isDestroyed() &&
            !mainWindow.webContents.isDestroyed()
          ) {
            try {
              mainWindow.webContents.send("task-updated", updated);
            } catch {
              // Render frame disposed — safe to ignore
            }
          }
          updateDockBadge(preferencesManager);
        }
      }
    }
  });
}
