/**
 * The subscription key of one task's `chat.taskEntry` (ADR-224 D3).
 *
 * `chat.entry` is keyed by `paneId`, and its subscriber count is what turns
 * a pane's watcher on. A task's stream is watched the same way, so its key
 * names the task as well as the pane: `<paneId>/<taskId>`. A task id (a
 * tool_use id) never holds a `/`, so the last one splits them.
 */

const SEPARATOR = "/";

/** The key to subscribe to `chat.onTaskEntry` with, and that it is published at. */
export function chatTaskKey(paneId: string, taskId: string): string {
  return `${paneId}${SEPARATOR}${taskId}`;
}

/** The pane and task a `chat.taskEntry` key names, or null if it is not one. */
export function parseChatTaskKey(
  key: string,
): { paneId: string; taskId: string } | null {
  const at = key.lastIndexOf(SEPARATOR);
  if (at <= 0 || at === key.length - 1) return null;
  return { paneId: key.slice(0, at), taskId: key.slice(at + 1) };
}
