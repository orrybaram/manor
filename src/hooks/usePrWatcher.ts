import { useProjectStore } from "../store/project-store";
import { branchesEqual } from "../utils/branch-name";
import { diffPrEvents, type PrNotifyEvent } from "../utils/pr-notifications";
import { useToastStore } from "../store/toast-store";
import { usePreferencesStore } from "../store/preferences-store";
import { useMountEffect } from "./useMountEffect";

const PR_POLL_INTERVAL = 15_000;

function notifyPrEvent(event: PrNotifyEvent, url: string) {
  if (document.hasFocus()) {
    useToastStore.getState().addToast({
      id: `pr-${event.kind}-${url}`,
      message: event.title,
      detail: event.body,
      status:
        event.kind === "checks-failed" || event.kind === "changes-requested"
          ? "error"
          : "success",
      action: {
        label: "View PR",
        onClick: () => {
          void window.electronAPI.shell.openExternal(url);
        },
      },
    });
  } else {
    void window.electronAPI.notifications.show({
      title: event.title,
      body: event.body,
      url,
    });
  }
}

function computeFingerprint() {
  const projects = useProjectStore.getState().projects;
  return projects
    .flatMap((p) =>
      p.workspaces
        .filter((ws) => !ws.isMain)
        .map((ws) => `${p.path}:${ws.branch}`),
    )
    .join("|");
}

export async function fetchPrs() {
  const { projects, updateWorkspacePr } = useProjectStore.getState();
  for (const project of projects) {
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
        const ws = nonMainWorkspaces.find((w) => branchesEqual(w.branch, branch));
        if (ws) {
          const prev = ws.pr;
          const events = diffPrEvents(prev, pr);
          if (pr && events.length > 0) {
            const prefs = usePreferencesStore.getState().preferences;
            const prefFor: Record<PrNotifyEvent["kind"], boolean> = {
              comment: prefs.notifyOnPrComment,
              approved: prefs.notifyOnPrApproved,
              "changes-requested": prefs.notifyOnPrChangesRequested,
              "checks-failed": prefs.notifyOnPrChecksFailed,
            };
            for (const event of events) {
              if (!prefFor[event.kind]) continue;
              notifyPrEvent(event, pr.url);
            }
          }

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
                  unresolvedThreads: pr.unresolvedThreads,
                  commentCount: pr.commentCount,
                }
              : null,
          );
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
