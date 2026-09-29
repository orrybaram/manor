import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ghRepoOf } from "../../../lib/gh-repo";
import {
  startGitHubIssueWork,
  startLinearIssueWork,
  type NewWorkspaceHandler,
} from "../../../lib/start-issue-work";
import type { GitHubIssue, LinearIssue } from "../../../electron.d";
import type { UpNextRow } from "./useUpNextIssues";

/**
 * Start work on an Up next issue: fetch its body, then open the New Workspace
 * dialog prefilled (or reuse a workspace already on the branch). Shared by
 * Home's Up next rows and the palette's Up next view (ADR-197 §2).
 */
export function useStartUpNextIssue(
  onNewWorkspace?: NewWorkspaceHandler,
): (row: UpNextRow) => Promise<void> {
  const queryClient = useQueryClient();

  // A click fetches the issue body first; ignore repeat clicks meanwhile.
  const startingRef = useRef(false);
  return useCallback(
    async (row: UpNextRow) => {
      if (startingRef.current) return;
      startingRef.current = true;
      try {
        const { issue, project } = row;
        if (issue.source === "github") {
          const listed = issue.raw as GitHubIssue;
          const repo = ghRepoOf(project);
          // `getMyIssues` has no body; the palette's detail query does. Same key,
          // so a palette visit and a Home click share the cache. Title only if
          // the detail fetch fails.
          const detail = await queryClient
            .fetchQuery({
              queryKey: ["github-issue-detail", repo.hostId, repo.path, listed.number, listed.url],
              queryFn: () =>
                window.electronAPI.github.getIssueDetail(repo, listed.number, listed.url),
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
          const listed = issue.raw as LinearIssue;
          const detail = await queryClient
            .fetchQuery({
              queryKey: ["linear-issue-detail", listed.id],
              queryFn: () => window.electronAPI.linear.getIssueDetail(listed.id),
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
