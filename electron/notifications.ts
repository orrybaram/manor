import { app, BrowserWindow, Notification } from "electron";
import { execFile } from "node:child_process";
import type {
  NotificationKind,
  NotificationRecord,
  NotificationStore,
  NotificationTarget,
} from "./notification-store";
import type { PreferencesManager } from "./preferences";
import type { TaskInfo } from "./task-persistence";
import type { AgentStatus } from "./terminal-host/types";

/** Mirrors `PrNotifyEventKind` in `src/utils/pr-notifications.ts`. */
export type PrNotifyEventKind =
  | "comment"
  | "approved"
  | "changes-requested"
  | "checks-failed";

const PR_KIND_TO_NOTIFICATION_KIND: Record<PrNotifyEventKind, NotificationKind> = {
  comment: "pr-comment",
  approved: "pr-approved",
  "changes-requested": "pr-changes-requested",
  "checks-failed": "pr-checks-failed",
};

/**
 * The durable notification log (ADR-162). Set once from app-lifecycle; absent
 * in tests and in any context that never boots the app, where recording is
 * simply skipped.
 */
let notificationStore: NotificationStore | null = null;

export function setNotificationStore(store: NotificationStore | null): void {
  notificationStore = store;
}

/**
 * Broadcast the full notification list to the renderer. This is the single
 * send-site for `notifications:changed`; do not call
 * `webContents.send("notifications:changed", ...)` directly.
 *
 * The list is capped at 200 records, so shipping all of it on every mutation
 * is deliberate — it makes renderer drift impossible (ADR-162 §3).
 */
export function sendNotificationsUpdate(mainWindow: BrowserWindow | null): void {
  if (!notificationStore) return;
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    mainWindow.webContents.isDestroyed()
  ) {
    return;
  }
  try {
    mainWindow.webContents.send(
      "notifications:changed",
      notificationStore.getAll(),
    );
  } catch {
    // Render frame disposed — safe to ignore
  }
}

/**
 * Mark every notification about `taskId` read and broadcast the result.
 *
 * Paired with `tasks:markSeen`: the moment main accepts that the user is
 * looking at a task's pane, the log entries for that task stop counting as
 * unread. Without this the bell kept an indicator up for a session already on
 * screen — and it came back every time the user navigated away.
 */
export function markTaskNotificationsRead(
  taskId: string,
  mainWindow: BrowserWindow | null,
): void {
  if (!notificationStore) return;
  if (!notificationStore.markReadByTask(taskId)) return;
  sendNotificationsUpdate(mainWindow);
}

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
  opts: {
    title: string;
    body: string;
    record: { kind: NotificationKind; target: NotificationTarget | null };
  },
): boolean {
  // Record *before* the focus check. A notification suppressed because the
  // window was focused is exactly the case the log exists for (ADR-162 §2):
  // the user may have been looking at a different pane the whole time.
  const record: NotificationRecord | null =
    notificationStore?.append({
      kind: opts.record.kind,
      title: opts.title,
      body: opts.body,
      target: opts.record.target,
    }) ?? null;
  sendNotificationsUpdate(mainWindow);

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
    // One click path for banners and in-app rows alike: the renderer resolves
    // the record's target through `navigateToNotification` (ADR-162 §4).
    if (record) {
      mainWindow.webContents.send("notifications:navigate", record.id);
    }
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
  let kind: NotificationKind;
  if (
    newStatus === "responded" &&
    prevStatus !== "responded" &&
    preferencesManager.get("notifyOnResponse")
  ) {
    title = "Agent responded";
    kind = "agent-responded";
  } else if (
    newStatus === "requires_input" &&
    prevStatus !== "requires_input" &&
    preferencesManager.get("notifyOnRequiresInput")
  ) {
    title = "Agent needs input";
    kind = "agent-requires-input";
  } else {
    return;
  }

  presentNotification(mainWindow, preferencesManager, {
    title,
    body: [task.name || "Agent", task.projectName].filter(Boolean).join(" — "),
    record: { kind, target: { type: "task", taskId: task.id } },
  });
}

/**
 * Show a native notification on demand, triggered by the renderer (e.g. for
 * PR update alerts — see ADR-147). Returns whether it was presented; `false`
 * means the calling window is focused and the renderer should toast instead.
 */
export function showPrNotification(
  payload: { kind: PrNotifyEventKind; title: string; body: string; url?: string },
  mainWindow: BrowserWindow | null,
  preferencesManager: PreferencesManager,
): boolean {
  return presentNotification(mainWindow, preferencesManager, {
    title: payload.title,
    body: payload.body,
    record: {
      kind: PR_KIND_TO_NOTIFICATION_KIND[payload.kind] ?? "pr-comment",
      target: payload.url ? { type: "url", url: payload.url } : null,
    },
  });
}
