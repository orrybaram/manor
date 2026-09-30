import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ghRepoOf } from "../../lib/gh-repo";
import {
  startGitHubIssueWork,
  startLinearIssueWork,
  type NewWorkspaceHandler,
} from "../../lib/start-issue-work";
import type { TaskRow } from "../../lib/tasks";

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
        const { project } = row;
        if (row.raw.provider === "github") {
          const listed = row.raw.issue;
          const repo = ghRepoOf(project);
          // Same key as the palette's detail view, so they share the cache.
          // Title only if the detail fetch fails.
          const detail = await queryClient
            .fetchQuery({
              queryKey: [
                "github-issue-detail",
                repo.hostId,
                repo.path,
                listed.number,
                listed.url,
              ],
              queryFn: () =>
                window.electronAPI.github.getIssueDetail(
                  repo,
                  listed.number,
                  listed.url,
                ),
              staleTime: 60_000,
              retry: false,
            })
            .catch(() => null);
          startGitHubIssueWork({
            project,
            repo,
            issue: { ...listed, body: detail?.body ?? null },
            onNewWorkspace,
          });
        } else {
          const listed = row.raw.issue;
          const detail = await queryClient
            .fetchQuery({
              queryKey: ["linear-issue-detail", listed.id],
              queryFn: () =>
                window.electronAPI.linear.getIssueDetail(listed.id),
              staleTime: 60_000,
              retry: false,
            })
            .catch(() => null);
          startLinearIssueWork({
            project,
            issue: { ...listed, description: detail?.description ?? null },
            onNewWorkspace,
          });
        }
      } finally {
        startingRef.current = false;
      }
    },
    [queryClient, onNewWorkspace],
  );
}
