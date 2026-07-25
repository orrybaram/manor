import { useCallback, useEffect, useMemo, useState } from "react";
import ListTodo from "lucide-react/dist/esm/icons/list-todo";
import { useProjectStore } from "../../store/project-store";
import { useMountEffect } from "../../hooks/useMountEffect";
import type { PaletteView } from "../command-palette/types";
import type { ActionItem } from "./EmptyStateShell";

/**
 * Resolves the single issue-tracker shortcut an empty state should offer, based
 * on the selected project's settings: Linear when the project is linked to a
 * team, otherwise GitHub when the `gh` CLI is installed and authenticated.
 *
 * The shortcut only materialises once the tracker confirms the user actually
 * has issues assigned. Also reports whether the `gh` CLI is missing so callers
 * can render the nudge.
 */
export function useIssuesShortcut(
  onOpenPaletteView?: (view: PaletteView) => void,
) {
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const project = projects[selectedProjectIndex];
  const repoPath = project?.path ?? null;

  const teamIds = useMemo(
    () => project?.linearAssociations?.map((a) => a.teamId) ?? [],
    [project?.linearAssociations],
  );
  const teamIdsKey = teamIds.join(",");
  const linearLinked = teamIds.length > 0;

  const [githubAvailable, setGithubAvailable] = useState(false);
  const [githubNotInstalled, setGithubNotInstalled] = useState(false);
  /** Probe key that came back with at least one issue — null while unknown. */
  const [issuesForKey, setIssuesForKey] = useState<string | null>(null);

  useMountEffect(() => {
    let cancelled = false;

    window.electronAPI.github
      .checkStatus()
      .then((status) => {
        if (cancelled) return;
        if (!status.installed) {
          setGithubNotInstalled(true);
        } else if (status.authenticated) {
          setGithubAvailable(true);
        }
      })
      .catch((err) =>
        console.error("[EmptyState] Failed to check GitHub status:", err),
      );

    return () => {
      cancelled = true;
    };
  });

  // Probe the active tracker for at least one assigned issue.
  const tracker: "linear" | "github" | null = linearLinked
    ? "linear"
    : githubAvailable && repoPath
      ? "github"
      : null;

  const probeKey = tracker
    ? `${tracker}:${tracker === "linear" ? teamIdsKey : repoPath}`
    : null;

  useEffect(() => {
    if (!probeKey) return;

    let cancelled = false;
    const probe =
      tracker === "linear"
        ? window.electronAPI.linear.getMyIssues(teamIdsKey.split(","), {
            limit: 1,
          })
        : window.electronAPI.github.getMyIssues(repoPath!, 1);

    probe
      .then((issues) => {
        if (!cancelled) setIssuesForKey(issues.length > 0 ? probeKey : null);
      })
      .catch((err) => {
        console.error("[EmptyState] Failed to check for issues:", err);
        if (!cancelled) setIssuesForKey(null);
      });

    return () => {
      cancelled = true;
    };
  }, [probeKey, tracker, teamIdsKey, repoPath]);

  const handleGitHubInstalled = useCallback(() => {
    setGithubNotInstalled(false);
    setGithubAvailable(true);
  }, []);

  // While the probe is in flight the row is rendered but reserved — it holds
  // its height so the shortcut list doesn't jump, then fades in if it resolves
  // to issues. Projects with no tracker at all get no row.
  const action: ActionItem | null =
    onOpenPaletteView && probeKey
      ? {
          icon: <ListTodo size={16} />,
          label: "Your Issues",
          keys: [],
          action: () =>
            onOpenPaletteView(
              tracker === "linear" ? "linear-all" : "github-all",
            ),
          hidden: issuesForKey !== probeKey,
        }
      : null;

  return {
    action,
    /** True when `gh` is missing and Linear isn't linked — the nudge case. */
    showGitHubNudge: githubNotInstalled && !githubAvailable && !linearLinked,
    onGitHubInstalled: handleGitHubInstalled,
  };
}
