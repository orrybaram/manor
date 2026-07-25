import { app, BrowserWindow, Notification, shell } from "electron";
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

export function playNotificationSound(soundName: string | false): void {
  if (typeof soundName === "string") {
    execFile("afplay", [`/System/Library/Sounds/${soundName}.aiff`]);
  }
}

/**
 * Present a silent native notification, suppressed while the window is focused.
 * Clicking it surfaces the window, then runs `onClick`. Single source of truth
 * for how the app shows native notifications and plays the configured sound.
 *
 * Returns whether a notification was actually presented. Callers that have an
 * in-app fallback (a toast) must branch on this rather than deciding for
 * themselves whether the window is focused: a renderer cannot see its own
 * focus reliably — `document.hasFocus()` is false whenever a `<webview>` pane
 * holds focus, while `win.isFocused()` is true, so both sides suppressing
 * independently dropped the event entirely.
 */
function presentNotification(
  mainWindow: BrowserWindow | null,
  preferencesManager: PreferencesManager,
  opts: { title: string; body: string; onClick?: () => void },
): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) {
    return false;
  }

  const notification = new Notification({
    title: opts.title,
    body: opts.body,
    silent: true,
  });
  notification.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
    opts.onClick?.();
  });
  notification.show();
  playNotificationSound(preferencesManager.get("notificationSound"));
  return true;
}

export function maybeSendNotification(
  task: TaskInfo,
  prevStatus: string | null | undefined,
  newStatus: AgentStatus,
  mainWindow: BrowserWindow | null,
  preferencesManager: PreferencesManager,
): void {
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

  presentNotification(mainWindow, preferencesManager, {
    title,
    body: [task.name || "Agent", task.projectName].filter(Boolean).join(" — "),
    onClick: () =>
      mainWindow?.webContents.send("notification:navigate-to-task", task.id),
  });
}

/**
 * Show a native notification on demand, triggered by the renderer (e.g. for
 * PR update alerts — see ADR-147). Returns whether it was presented; `false`
 * means the calling window is focused and the renderer should toast instead.
 */
export function showPrNotification(
  payload: { title: string; body: string; url?: string },
  mainWindow: BrowserWindow | null,
  preferencesManager: PreferencesManager,
): boolean {
  return presentNotification(mainWindow, preferencesManager, {
    title: payload.title,
    body: payload.body,
    onClick: payload.url ? () => shell.openExternal(payload.url!) : undefined,
  });
}
