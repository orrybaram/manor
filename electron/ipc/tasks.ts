import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import { updateDockBadge } from "../notifications";
import type { IpcDeps } from "./types";

export function register(deps: IpcDeps): void {
  const {
    taskManager,
    paneContextMap,
    unseenRespondedTasks,
    unseenInputTasks,
    preferencesManager,
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
      context: { projectId: string; projectName: string; workspacePath: string },
    ) => {
      assertString(paneId, "paneId");
      assertString(context.projectId, "projectId");
      assertString(context.projectName, "projectName");
      assertString(context.workspacePath, "workspacePath");
      paneContextMap.set(paneId, context);
    },
  );
}
