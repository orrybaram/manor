import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { NewWorkspaceHandler } from "../../lib/start-issue-work";
import type { TaskRow } from "../../lib/tasks";
import { trackerFor } from "../../lib/trackers";
import { ipcErrorMessage } from "../../lib/ipc-error";
import { toast } from "../../toast";

/**
 * Start work on a task: fetch its body, then open the New Workspace dialog
 * prefilled (or reuse a workspace already on the branch). Shared by the
 * Tasks view and Home's Up next.
 */
export function useStartTask(
  onNewWorkspace?: NewWorkspaceHandler,
): (row: TaskRow) => Promise<void> {
  const queryClient = useQueryClient();

  // A start fetches the task's body first; ignore repeat clicks meanwhile.
  const startingRef = useRef(false);
  return useCallback(
    async (row: TaskRow) => {
      if (startingRef.current) return;
      startingRef.current = true;
      try {
        const tracker = trackerFor(row.provider);
        // Title only if the detail fetch fails — and the user is told so
        // rather than finding an empty description later.
        const detail = await queryClient
          .fetchQuery({
            ...tracker.detailQuery(tracker.refOf(row)),
            retry: false,
          })
          .catch((err: unknown) => {
            toast.info("Couldn't load the task's description — starting with its title only", {
              id: `task-body-${row.key}`,
              detail: ipcErrorMessage(err),
            });
            return null;
          });
        const body = detail?.body ?? null;
        tracker.startWork(row, body, onNewWorkspace);
      } finally {
        startingRef.current = false;
      }
    },
    [queryClient, onNewWorkspace],
  );
}
