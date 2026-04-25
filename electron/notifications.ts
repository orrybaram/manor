import { app, BrowserWindow, Notification } from "electron";
import { execFile } from "node:child_process";
import type { PreferencesManager } from "./preferences";
import type { TaskInfo } from "./task-persistence";
import type { AgentStatus } from "./terminal-host/types";

export const unseenRespondedTasks = new Set<string>();
export const unseenInputTasks = new Set<string>();

/**
 * Per-task unseen flags as broadcast to the renderer alongside `task-updated`.
 *
 * The renderer keeps two Sets (`unseenRespondedTaskIds`, `unseenInputTaskIds`)
 * as a *cache* of these flags — see ADR-136 §"Change 3". Always derive the flags
 * from main's Sets at the moment of the broadcast so the renderer never drifts.
 */
export type TaskUnseenFlags = {
  responded: boolean;
  requires_input: boolean;
};

export function getUnseenFlagsForTask(taskId: string): TaskUnseenFlags {
  return {
    responded: unseenRespondedTasks.has(taskId),
    requires_input: unseenInputTasks.has(taskId),
  };
}

/**
 * Snapshot of the full unseen state, used by `tasks:getUnseen` to prime the
 * renderer cache on boot.
 */
export function getUnseenSnapshot(): {
  responded: string[];
  requires_input: string[];
} {
  return {
    responded: Array.from(unseenRespondedTasks),
    requires_input: Array.from(unseenInputTasks),
  };
}

/**
 * Broadcast a `task-updated` event to the renderer with the current unseen
 * flags, then refresh the dock badge. This is the single send-site for
 * `task-updated`; do not call `webContents.send("task-updated", ...)` directly.
 */
export function sendTaskUpdate(
  mainWindow: BrowserWindow | null,
  task: TaskInfo,
  preferencesManager: PreferencesManager,
): void {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    try {
      mainWindow.webContents.send(
        "task-updated",
        task,
        getUnseenFlagsForTask(task.id),
      );
    } catch {
      // Render frame disposed — safe to ignore
    }
  }
  updateDockBadge(preferencesManager);
}

export function updateDockBadge(preferencesManager: PreferencesManager): void {
  if (!preferencesManager.get("dockBadgeEnabled")) {
    app.dock?.setBadge("");
    return;
  }
  if (unseenInputTasks.size > 0) {
    app.dock?.setBadge(unseenInputTasks.size.toString());
  } else if (unseenRespondedTasks.size > 0) {
    app.dock?.setBadge("•");
  } else {
    app.dock?.setBadge("");
  }
}

export function maybeSendNotification(
  task: TaskInfo,
  prevStatus: string | null | undefined,
  newStatus: AgentStatus,
  mainWindow: BrowserWindow | null,
  preferencesManager: PreferencesManager,
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isFocused()) return;

  let title: string;
  if (
    newStatus === "responded" &&
    prevStatus !== "responded" &&
    preferencesManager.get("notifyOnResponse")
  ) {
    title = "Agent responded";
  } else if (
    newStatus === "requires_input" &&
    prevStatus !== "requires_input" &&
    preferencesManager.get("notifyOnRequiresInput")
  ) {
    title = "Agent needs input";
  } else {
    return;
  }

  const notification = new Notification({
    title,
    body: [task.name || "Agent", task.projectName].filter(Boolean).join(" — "),
    silent: true,
  });
  notification.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("notification:navigate-to-task", task.id);
  });
  notification.show();
  const soundName = preferencesManager.get("notificationSound");
  if (typeof soundName === "string") {
    execFile("afplay", [`/System/Library/Sounds/${soundName}.aiff`]);
  }
}
