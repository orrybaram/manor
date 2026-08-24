import type { NotificationRecord } from "../electron.d";
import { useNotificationStore } from "../store/notification-store";
import { useTaskStore } from "../store/task-store";
import { navigateToTask } from "./task-navigation";

/**
 * Resolve a notification to wherever it points. The single destination for
 * both a clicked native banner and a clicked row in the notifications
 * popover (ADR-162 §4) — two implementations of this is exactly the drift
 * this consolidates.
 */
export async function navigateToNotification(
  record: NotificationRecord,
): Promise<void> {
  if (!record.read) {
    await useNotificationStore.getState().markRead(record.id);
  }

  const target = record.target;
  if (!target) return;

  if (target.type === "url") {
    await window.electronAPI?.shell.openExternal(target.url);
    return;
  }

  const tasks = useTaskStore.getState().tasks;
  let task = tasks.find((t) => t.id === target.taskId) ?? null;
  if (!task) {
    task = (await window.electronAPI?.tasks.get(target.taskId)) ?? null;
  }
  // The task may have been pruned out from under the record; nothing to do.
  if (task) navigateToTask(task);
}
