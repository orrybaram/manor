import { useRef } from "react";
import { useProjectStore } from "../store/project-store";
import { useMountEffect } from "./useMountEffect";

const PR_POLL_INTERVAL = 60_000;

function computeFingerprint() {
  const projects = useProjectStore.getState().projects;
  return projects
    .flatMap((p) =>
      p.workspaces.filter((ws) => !ws.isMain).map((ws) => `${p.path}:${ws.branch}`),
    )
    .join("|");
}

export function usePrWatcher() {
  const updateWorkspacePr = useProjectStore((s) => s.updateWorkspacePr);
  const updateWorkspacePrRef = useRef(updateWorkspacePr);
  updateWorkspacePrRef.current = updateWorkspacePr;

  const fetchPrs = useRef(async () => {
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
            updateWorkspacePrRef.current(
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
  }).current;

  useMountEffect(() => {
    let prevFingerprint = "";
    let timer: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(fetchPrs, PR_POLL_INTERVAL);
    };

    // Initial fetch
    prevFingerprint = computeFingerprint();
    fetchPrs();
    startPolling();

    // Subscribe to store changes to detect fingerprint changes
    const unsub = useProjectStore.subscribe(() => {
      const fp = computeFingerprint();
      if (fp !== prevFingerprint) {
        prevFingerprint = fp;
        fetchPrs();
        startPolling();
      }
    });

    return () => {
      unsub();
      if (timer) clearInterval(timer);
    };
  });
}
