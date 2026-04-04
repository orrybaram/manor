import { app, BrowserWindow, Notification } from "electron";
import { execFile } from "node:child_process";
import type { PreferencesManager } from "./preferences";
import type { TaskInfo } from "./task-persistence";
import type { AgentStatus } from "./terminal-host/types";

export const unseenRespondedTasks = new Set<string>();
export const unseenInputTasks = new Set<string>();

export function updateDockBadge(preferencesManager: PreferencesManager): void {
  if (!preferencesManager.get("dockBadgeEnabled")) {
    app.dock?.setBadge("");
    return;
  }
  if (unseenInputTasks.size > 0) {
    app.dock?.setBadge(unseenInputTasks.size.toString());
  } else if (unseenRespondedTasks.size > 0) {
    app.dock?.setBadge("·");
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
    // TODO(adr-107): execFile("afplay") is macOS-specific platform utility — not
    // abstracted through the backend since it is not workspace I/O.
    execFile("afplay", [`/System/Library/Sounds/${soundName}.aiff`]);
  }
}
