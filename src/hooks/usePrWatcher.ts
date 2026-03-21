import { useEffect, useRef, useCallback } from "react";
import { useProjectStore } from "../store/project-store";

const PR_POLL_INTERVAL = 60_000;

export function usePrWatcher() {
  const projects = useProjectStore((s) => s.projects);
  const updateWorkspacePr = useProjectStore((s) => s.updateWorkspacePr);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPrs = useCallback(async () => {
    for (const project of useProjectStore.getState().projects) {
      const nonMainWorkspaces = project.workspaces.filter(
        (ws) => !ws.isMain && ws.branch,
      );
      if (nonMainWorkspaces.length === 0) continue;

      const branches = nonMainWorkspaces.map((ws) => ws.branch);

      try {
        const results = await window.electronAPI.github.getPrsForBranches(
          project.path,
          branches,
        );

        for (const [branch, pr] of results) {
          const ws = nonMainWorkspaces.find((w) => w.branch === branch);
          if (ws) {
            updateWorkspacePr(
              ws.path,
              pr
                ? {
                    number: pr.number,
                    state: pr.state,
                    title: pr.title,
                    url: pr.url,
                    isDraft: pr.isDraft,
                    additions: pr.additions,
                    deletions: pr.deletions,
                    reviewDecision: pr.reviewDecision,
                    checks: pr.checks,
                  }
                : null,
            );
          }
        }
      } catch {
        // gh CLI not available or network error — skip
      }
    }
  }, [updateWorkspacePr]);

  // Build a stable fingerprint of branches to detect changes
  const prevFingerprintRef = useRef("");
  const fingerprint = projects
    .flatMap((p) => p.workspaces.filter((ws) => !ws.isMain).map((ws) => `${p.path}:${ws.branch}`))
    .join("|");

  useEffect(() => {
    // Fetch immediately on mount or branch change
    const changed = fingerprint !== prevFingerprintRef.current;
    prevFingerprintRef.current = fingerprint;

    if (changed) {
      fetchPrs();
    }

    // Set up polling
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(fetchPrs, PR_POLL_INTERVAL);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [fingerprint, fetchPrs]);
}
