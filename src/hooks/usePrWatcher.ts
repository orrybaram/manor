import {
  useProjectStore,
  type ProjectInfo,
  type WorkspaceInfo,
} from "../store/project-store";
import { ghRepoOf } from "../lib/gh-repo";
import { keyOf } from "../lib/workspace-directory";
import { branchesEqual } from "../utils/branch-name";
import { deliverPrNotifications } from "../utils/pr-notifications";
import { usePreferencesStore } from "../store/preferences-store";
import { useMountEffect } from "./useMountEffect";

/**
 * Window focus and badge hover already refresh immediately, so the timer only
 * has to catch changes that happen while the app is idle. Every tick is at
 * least one GitHub call per worktree; at 15s eight worktrees came within
 * sight of the hourly limit on their own.
 */
const PR_POLL_INTERVAL = 60_000;

/**
 * Worktrees always get a PR lookup. The main checkout does too once it's
 * switched off the default branch — a PR opened from a branch checked out
 * there should still badge the row. On the default branch it gets none: a
 * `--head main` lookup would surface unrelated PRs.
 */
function tracksPr(project: ProjectInfo, ws: WorkspaceInfo): boolean {
  if (!ws.branch) return false;
  return !ws.isMain || !branchesEqual(ws.branch, project.defaultBranch);
}

function computeFingerprint() {
  const projects = useProjectStore.getState().projects;
  return projects
    .flatMap((p) =>
      p.workspaces
        .filter((ws) => tracksPr(p, ws))
        .map((ws) => `${p.path}:${ws.branch}`),
    )
    .join("|");
}

export async function fetchPrs() {
  const { projects, updateWorkspacePr } = useProjectStore.getState();
  for (const project of projects) {
    // The main checkout back on the default branch keeps no stale badge from
    // the branch it was on before.
    for (const ws of project.workspaces) {
      if (ws.pr && !tracksPr(project, ws)) {
        updateWorkspacePr(keyOf(project, ws), null);
      }
    }

    const tracked = project.workspaces.filter((ws) => tracksPr(project, ws));
    if (tracked.length === 0) continue;

    const branches = tracked.map((ws) => ws.branch);

    try {
      const results = await window.electronAPI.github.getPrsForBranches(
        ghRepoOf(project),
        branches,
      );

      for (const [branch, pr] of results) {
        const ws = tracked.find((w) => branchesEqual(w.branch, branch));
        if (ws) {
          deliverPrNotifications(
            ws.pr,
            pr,
            usePreferencesStore.getState().preferences,
          );
          updateWorkspacePr(keyOf(project, ws), pr);
        }
      }
    } catch {
      // gh CLI not available or network error — skip
    }
  }
}

export function usePrWatcher() {

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

    const handleFocus = () => {
      fetchPrs();
      startPolling();
    };
    window.addEventListener("focus", handleFocus);

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
      window.removeEventListener("focus", handleFocus);
    };
  });
}
