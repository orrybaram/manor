import { useCallback, useEffect, useMemo, useState } from "react";
import ListTodo from "lucide-react/dist/esm/icons/list-todo";
import { onBehalfOf } from "../../bridge/router";
import { useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { ghRepoOf } from "../../lib/gh-repo";
import { isRemoteHost } from "../../lib/hosts";
import { entryLookup } from "../../lib/task-list";
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
export function useIssuesShortcut() {
  const projects = useProjectStore((s) => s.projects);
  const selectedProjectIndex = useProjectStore((s) => s.selectedProjectIndex);
  const project = projects[selectedProjectIndex];
  // On the project's host: a local and a remote checkout can share a path.
  // Memoized on the strings, so a store update doesn't make a new repo.
  const repoPath = project?.path;
  const repoHostId = project?.hostId;
  const repo = useMemo(
    () => (repoPath === undefined ? null : ghRepoOf({ path: repoPath, hostId: repoHostId })),
    [repoPath, repoHostId],
  );

  const teamIds = useMemo(
    () => project?.linearAssociations?.map((a) => a.teamId) ?? [],
    [project?.linearAssociations],
  );
  const teamIdsKey = teamIds.join(",");
  const linearLinked = teamIds.length > 0;

  /** What `gh` said on one host; ignored once the project's host differs. */
  const [ghStatus, setGhStatus] = useState<{
    hostId: string | undefined;
    installed: boolean;
    authenticated: boolean;
  } | null>(null);
  // `gh` runs on the project's own host with that host's sign-in: a remote project asks its box, not this machine.
  const remoteHostId = repoHostId && isRemoteHost(repoHostId) ? repoHostId : undefined;
  const current = ghStatus?.hostId === remoteHostId ? ghStatus : null;
  const githubAvailable = !!current?.installed && current.authenticated;
  // The nudge installs `gh` on this machine; it can't do that for a box.
  const githubNotInstalled = current !== null && !current.installed && remoteHostId === undefined;
  /** Probe key that came back with at least one issue — null while unknown. */
  const [issuesForKey, setIssuesForKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.github
      .checkStatus(remoteHostId)
      .then((status) => {
        if (!cancelled) {
          setGhStatus({
            hostId: remoteHostId,
            installed: status.installed,
            authenticated: status.authenticated,
          });
        }
      })
      .catch((err) =>
        console.error("[EmptyState] Failed to check GitHub status:", err),
      );
    return () => {
      cancelled = true;
    };
  }, [remoteHostId]);

  // Probe the active tracker for at least one assigned issue.
  const tracker: "linear" | "github" | null = linearLinked
    ? "linear"
    : githubAvailable && repo
      ? "github"
      : null;

  const probeKey = tracker
    ? `${tracker}:${tracker === "linear" ? teamIdsKey : `${repo?.hostId}:${repo?.path}`}`
    : null;

  useEffect(() => {
    if (!probeKey) return;

    let cancelled = false;
    const probe =
      tracker === "linear"
        ? onBehalfOf(repoHostId, () =>
            window.electronAPI.linear.getMyIssues(teamIdsKey.split(","), {
              limit: 1,
            }),
          )
        : window.electronAPI.github.getMyIssues(repo!, 1);

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
  }, [probeKey, tracker, teamIdsKey, repo, repoHostId]);

  const handleGitHubInstalled = useCallback(() => {
    setGhStatus({ hostId: undefined, installed: true, authenticated: true });
  }, []);

  // While the probe is in flight the row is rendered but reserved — it holds
  // its height so the shortcut list doesn't jump, then fades in if it resolves
  // to issues. Projects with no tracker at all get no row.
  const action: ActionItem | null =
    probeKey
      ? {
          icon: <ListTodo size={16} />,
          label: "Your Tasks",
          keys: [],
          action: () => {
            // Preset the Tasks view to the selected project's top-level
            // entry (the group's key for a project inside a group).
            const { projects, selectedProjectIndex } = useProjectStore.getState();
            const selected = projects[selectedProjectIndex];
            useAppStore.getState().showTasksView(
              selected
                ? { project: entryLookup(projects)(selected).entryKey }
                : undefined,
            );
          },
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
