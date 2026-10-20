import { useState } from "react";
import { onBridgeResync } from "../../../bridge/resync";
import { chatTaskKey } from "../../../../electron/chat-mirror/task-key";
import type { ChatEntry } from "../../../electron.d";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { mergeHistory, upsertEntry } from "./chat-entries";

type TaskChatView = {
  entries: ChatEntry[];
  /** The first history fetch has answered. */
  loaded: boolean;
  /** The task's transcript can't be read (yet). */
  unavailable: boolean;
};

/**
 * One background task's own transcript, read the way
 * `ChatPane` reads a pane's: subscribe to its stream first, then fetch the
 * history, and merge the two by entry id so nothing published in between is
 * lost. Mounted per open `TaskSheet`, so each watches one child stream.
 */
export function useTaskChatView(paneId: string, taskId: string): TaskChatView {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useMountEffect(() => {
    const chat = window.electronAPI.chat;
    let alive = true;
    let shown = false;

    function fetchHistory(): void {
      chat.getTaskHistory(paneId, taskId).then(
        (history) => {
          if (!alive) return;
          shown = history.ok;
          if (history.ok) {
            setEntries((prev) => mergeHistory(history.entries, prev));
          }
          setUnavailable(!history.ok);
          setLoaded(true);
        },
        () => {
          // A failed refetch keeps the transcript already on screen.
          if (!alive || shown) return;
          setUnavailable(true);
          setLoaded(true);
        },
      );
    }

    // Keyed by pane and task: only this task's pushes arrive here.
    const unsubscribe = chat.onTaskEntry(chatTaskKey(paneId, taskId), (_paneId, _taskId, entry) => {
      if (entry.kind !== "usage") setEntries((prev) => upsertEntry(prev, entry));
    });
    const unsubscribeResync = onBridgeResync(fetchHistory);
    fetchHistory();
    return () => {
      alive = false;
      unsubscribe();
      unsubscribeResync();
    };
  });

  return { entries, loaded, unavailable };
}
