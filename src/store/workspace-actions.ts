import { selectActiveWorkspaceKey, useAppStore } from "./app-store";
import { workspaceKey } from "../lib/workspace-key";
import { useProjectStore } from "./project-store";
import { useToastStore } from "./toast-store";
import type { ProjectInfo, WorkspaceInfo } from "./project-store";
import { ipcErrorMessage } from "../lib/ipc-error";

/**
 * Remove a worktree: immediately switch away (if active), clean up tabs,
 * show a progress toast, and tear down in the background. Resolves to
 * whether the worktree was removed — git refuses a locked one, say — so a
 * caller showing the row as deleting can put it back.
 */
export function removeWorktreeWithToast(
  project: ProjectInfo,
  ws: WorkspaceInfo,
  deleteBranch?: boolean,
): Promise<boolean> {
  const appStore = useAppStore.getState();
  const projectStore = useProjectStore.getState();
  const toastStore = useToastStore.getState();

  const key = workspaceKey(project.hostId, ws.path);
  const wasActive = selectActiveWorkspaceKey(appStore) === key;
  const wsName =
    ws.name || ws.branch || ws.path.split("/").pop() || "workspace";

  // Immediately switch to next workspace before teardown
  if (wasActive) {
    const workspaces = project.workspaces;
    const removedIdx = workspaces.findIndex((w) => w.path === ws.path);
    // Pick the next workspace, or the one before if we're removing the last
    const nextIdx =
      removedIdx < workspaces.length - 1 ? removedIdx + 1 : removedIdx - 1;
    if (nextIdx >= 0) {
      projectStore.selectWorkspace(project.id, nextIdx);
    }
  }

  // Clean up tabs
  appStore.removeWorkspaceLayout(key);

  // Show toast and run async teardown
  const toastId = `toast-${crypto.randomUUID()}`;
  toastStore.addToast({
    id: toastId,
    message: `Removing "${wsName}"…`,
    status: "loading",
    detail: "Starting…",
  });

  // Listen for progress updates from the main process
  const unsubProgress = window.electronAPI.projects.onRemoveWorktreeProgress(
    (step) => {
      toastStore.updateToast(toastId, { detail: step });
    },
  );

  return projectStore
    .removeWorktree(project.id, ws.path, deleteBranch)
    .then(() => {
      toastStore.updateToast(toastId, {
        message: `Removed "${wsName}"`,
        status: "success",
        detail: undefined,
      });
      return true;
    })
    .catch((err: unknown) => {
      toastStore.updateToast(toastId, {
        message: `Failed to remove "${wsName}"`,
        status: "error",
        detail: ipcErrorMessage(err),
      });
      return false;
    })
    .finally(() => {
      unsubProgress();
    });
}

/**
 * Before a bulk hide or delete (ADR-190 §2): if the active workspace is one
 * of `targetPaths`, switch to main — or the first workspace that stays — so
 * the window never sits on, or steps onto, a row that is about to go.
 */
function navigateAwayFrom(
  project: ProjectInfo,
  targetPaths: ReadonlySet<string>,
): void {
  const active = useAppStore.getState().activeWorkspacePath;
  if (!active || !targetPaths.has(active)) return;
  const remaining = project.workspaces.filter((ws) => !targetPaths.has(ws.path));
  const next = remaining.find((ws) => ws.isMain) ?? remaining[0];
  if (!next) return;
  useProjectStore
    .getState()
    .selectWorkspace(project.id, project.workspaces.indexOf(next));
}

/**
 * Remove several worktrees in one gesture (ADR-190 §2): main is never a
 * target, and — when the active workspace is among the rest — the window
 * navigates away before any teardown starts, so the per-item "select next"
 * logic in `removeWorktreeWithToast` never lands on a row that is itself
 * about to go. Removals run sequentially: concurrent `git worktree remove`
 * calls on one repo risk lock contention, and each still gets its own toast.
 * Resolves to the paths that failed to go, so their rows can be un-dimmed.
 */
export async function removeWorktreesWithToast(
  project: ProjectInfo,
  workspaces: WorkspaceInfo[],
  deleteBranch?: boolean,
): Promise<string[]> {
  const targets = workspaces.filter((ws) => !ws.isMain);
  if (targets.length === 0) return [];

  navigateAwayFrom(project, new Set(targets.map((ws) => ws.path)));

  const failed: string[] = [];
  for (const ws of targets) {
    if (!(await removeWorktreeWithToast(project, ws, deleteBranch))) {
      failed.push(ws.path);
    }
  }
  return failed;
}

/**
 * Quick-merge a worktree into the default branch: immediately switch away
 * (if active), clean up tabs, show a progress toast, and merge in the
 * background.
 */
export function quickMergeWorktreeWithToast(
  project: ProjectInfo,
  ws: WorkspaceInfo,
): void {
  const appStore = useAppStore.getState();
  const projectStore = useProjectStore.getState();
  const toastStore = useToastStore.getState();

  const key = workspaceKey(project.hostId, ws.path);
  const wasActive = selectActiveWorkspaceKey(appStore) === key;
  const wsName =
    ws.name || ws.branch || ws.path.split("/").pop() || "workspace";

  // Immediately switch to next workspace before merge/teardown
  if (wasActive) {
    const workspaces = project.workspaces;
    const removedIdx = workspaces.findIndex((w) => w.path === ws.path);
    const nextIdx =
      removedIdx < workspaces.length - 1 ? removedIdx + 1 : removedIdx - 1;
    if (nextIdx >= 0) {
      projectStore.selectWorkspace(project.id, nextIdx);
    }
  }

  // Clean up tabs
  appStore.removeWorkspaceLayout(key);

  // Show toast and run async merge
  const toastId = `toast-${crypto.randomUUID()}`;
  toastStore.addToast({
    id: toastId,
    message: `Merging "${wsName}" into ${project.defaultBranch}...`,
    status: "loading",
  });

  projectStore
    .quickMergeWorktree(project.id, ws.path)
    .then(() => {
      toastStore.updateToast(toastId, {
        message: `Merged "${wsName}" into ${project.defaultBranch}`,
        status: "success",
      });
    })
    .catch((err) => {
      toastStore.updateToast(toastId, {
        message: `Failed to merge "${wsName}"`,
        status: "error",
        detail: String(err),
      });
    });
}

/**
 * Hide a workspace from the sidebar, and — when it was the one selected —
 * fall back to the project's main workspace so the user is never left on a
 * surface that is no longer listed.
 *
 * Shared by the sidebar's context menu and the Workspace › Hide Workspace menu
 * item (ADR-170).
 */
export function hideWorkspaceAndNavigate(
  projectId: string,
  path: string,
): void {
  const projectStore = useProjectStore.getState();
  const project = projectStore.projects.find((p) => p.id === projectId);
  if (!project) return;

  const wsIdx = project.workspaces.findIndex((w) => w.path === path);
  if (wsIdx < 0) return;
  const wasSelected = wsIdx === project.selectedWorkspaceIndex;

  projectStore.setWorkspaceHidden(projectId, path, true);

  if (!wasSelected) return;
  const mainIndex = project.workspaces.findIndex((w) => w.isMain);
  if (mainIndex >= 0) projectStore.selectWorkspace(projectId, mainIndex);
}

/**
 * Hide several workspaces at once (ADR-190 §2): main is never a target, and —
 * when the active workspace is among the rest — the window navigates to main
 * before any of them disappear, mirroring `hideWorkspaceAndNavigate`'s single-
 * workspace fallback. Hides are awaited sequentially.
 */
export async function hideWorkspacesAndNavigate(
  projectId: string,
  paths: string[],
): Promise<void> {
  const projectStore = useProjectStore.getState();
  const project = projectStore.projects.find((p) => p.id === projectId);
  if (!project) return;

  const wsByPath = new Map(project.workspaces.map((ws) => [ws.path, ws]));
  const targets = paths.filter((path) => {
    const ws = wsByPath.get(path);
    return ws && !ws.isMain;
  });
  if (targets.length === 0) return;

  navigateAwayFrom(project, new Set(targets));

  for (const path of targets) {
    await projectStore.setWorkspaceHidden(projectId, path, true);
  }
}
