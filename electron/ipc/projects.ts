/**
 * Projects and workspaces, as plain functions over `IpcDeps` (ADR-180 D8).
 *
 * The biggest namespace in the app, and the one that used to have the widest
 * gap between its two callers: four of these twenty-three were on the bridge
 * handler table and the other nineteen were `ipcMain.handle("projects:*")`
 * wrappers a browser could not reach at all. There is no `register()` here
 * any more — `electron/bridge/handlers.ts` calls these directly, for a
 * renderer window and a paired `full` device alike, which is ADR-178 D3 as
 * written and as the pairing dialog's label already warns ("can do anything
 * the desktop can, including remove workspaces"). Every mutating one is in
 * `MUTATING`, so a device's call leaves an audit line and the user at the
 * machine's does not.
 *
 * **Progress goes back to the caller, not to every window.** Making and
 * removing a worktree both report their steps, and both used to do it on
 * `event.sender` — the one thing a lifted function does not have. The caller
 * arrives as a `LayoutOrigin` instead (`ORIGIN_ARGS`, ADR-179 D3), and its
 * `id` *is* a connection id on both transports, so the events address the
 * same renderer the `event.sender` did. A call with no origin behind it —
 * the CLI, MCP, the issue-batch path — broadcasts, which is what every
 * window used to get unconditionally.
 */

import { assertString } from "../ipc-validate";
import {
  publishRendererBroadcast,
  publishToRenderer,
} from "../renderer-broadcast";
import type {
  ProjectInfo,
  ProjectUpdatableFields,
  WorkspaceFolder,
} from "../persistence";
import type { LinkedIssue } from "../linear";
import type { LayoutOrigin } from "../layout/layout-store";
import type { IpcDeps } from "./types";

/** The four the sidebar needs to paint itself. */
export function projectsGetAll(deps: IpcDeps): unknown {
  return deps.projectManager.getProjects();
}

export function projectsGetSelectedIndex(deps: IpcDeps): number {
  return deps.projectManager.getSelectedProjectIndex();
}

export function projectsSelect(deps: IpcDeps, index: number): void {
  deps.projectManager.selectProject(index);
}

export function projectsSelectWorkspace(
  deps: IpcDeps,
  projectId: string,
  workspaceIndex: number,
): void {
  deps.projectManager.selectWorkspace(projectId, workspaceIndex);
}

export function projectsAdd(
  deps: IpcDeps,
  name: string,
  projectPath: string,
): Promise<ProjectInfo> {
  assertString(name, "name");
  assertString(projectPath, "path");
  return deps.projectManager.addProject(name, projectPath);
}

export function projectsRemove(deps: IpcDeps, projectId: string): void {
  deps.projectManager.removeProject(projectId);
}

/**
 * Tear a worktree down, reporting each step to whoever asked for it.
 *
 * The steps used to go out on `event.sender`; they are a
 * `projects.removeWorktreeProgress` event now, addressed to the caller's
 * connection (ADR-180 D5) — one dialog, in one window, and a second window
 * has no business watching its progress bar.
 */
export async function projectsRemoveWorktree(
  deps: IpcDeps,
  projectId: string,
  worktreePath: string,
  deleteBranch?: boolean,
  origin?: LayoutOrigin,
): Promise<void> {
  const to = origin?.id ?? null;
  await deps.projectManager.removeWorktree(
    projectId,
    worktreePath,
    deleteBranch,
    (step: string) => {
      if (to === null) {
        publishRendererBroadcast("projects", "removeWorktreeProgress", step);
      } else {
        publishToRenderer(to, "projects", "removeWorktreeProgress", step);
      }
    },
  );
  deps.statsStore.record("worktreesRemoved");
}

export function projectsCanQuickMerge(
  deps: IpcDeps,
  projectId: string,
  worktreePath: string,
): Promise<{ canMerge: boolean; reason?: string }> {
  return deps.projectManager.canQuickMerge(projectId, worktreePath);
}

export async function projectsQuickMergeWorktree(
  deps: IpcDeps,
  projectId: string,
  worktreePath: string,
): Promise<void> {
  await deps.projectManager.quickMergeWorktree(projectId, worktreePath);
  deps.statsStore.record("worktreesMerged");
}

/**
 * Make a worktree, and tell the caller how it is going.
 *
 * The last argument is the caller's identity, appended by the bridge rather
 * than by the frame (`ORIGIN_ARGS`), and `ProjectManager` takes its `id` as
 * the connection its setup progress goes back to — the same window the
 * `event.sender.id` of the old wrapper named, and the same id a layout
 * command's origin carries.
 */
export async function projectsCreateWorktree(
  deps: IpcDeps,
  projectId: string,
  name: string,
  branch?: string,
  linkedIssue?: LinkedIssue,
  baseBranch?: string,
  useExistingBranch?: boolean,
  origin?: LayoutOrigin,
): Promise<ProjectInfo | null> {
  const result = await deps.projectManager.createWorktree(
    projectId,
    name,
    branch,
    linkedIssue,
    baseBranch,
    useExistingBranch,
    origin?.id ?? null,
  );
  deps.statsStore.record("worktreesCreated");
  return result;
}

export function projectsConvertMainToWorktree(
  deps: IpcDeps,
  projectId: string,
  name: string,
): Promise<ProjectInfo | null> {
  return deps.projectManager.convertMainToWorktree(projectId, name);
}

export function projectsListRemoteBranches(
  deps: IpcDeps,
  projectId: string,
): Promise<string[]> {
  return deps.projectManager.listRemoteBranches(projectId);
}

export function projectsListLocalBranches(
  deps: IpcDeps,
  projectId: string,
): Promise<string[]> {
  return deps.projectManager.listLocalBranches(projectId);
}

export function projectsRenameWorkspace(
  deps: IpcDeps,
  projectId: string,
  workspacePath: string,
  newName: string,
): void {
  deps.projectManager.renameWorkspace(projectId, workspacePath, newName);
}

export function projectsSetWorkspaceHidden(
  deps: IpcDeps,
  projectId: string,
  workspacePath: string,
  hidden: boolean,
): void {
  deps.projectManager.setWorkspaceHidden(projectId, workspacePath, hidden);
}

export function projectsCreateWorkspaceFolder(
  deps: IpcDeps,
  projectId: string,
  name: string,
  parentId?: string | null,
): WorkspaceFolder | null {
  assertString(name, "name");
  return deps.projectManager.createWorkspaceFolder(projectId, name, parentId);
}

/** Returns false when the move would create a folder cycle (ADR-172). */
export function projectsSetFolderParent(
  deps: IpcDeps,
  projectId: string,
  folderId: string,
  parentId: string | null,
): boolean {
  return deps.projectManager.setFolderParent(projectId, folderId, parentId);
}

export function projectsRenameWorkspaceFolder(
  deps: IpcDeps,
  projectId: string,
  folderId: string,
  name: string,
): void {
  assertString(name, "name");
  deps.projectManager.renameWorkspaceFolder(projectId, folderId, name);
}

export function projectsDeleteWorkspaceFolder(
  deps: IpcDeps,
  projectId: string,
  folderId: string,
): void {
  deps.projectManager.deleteWorkspaceFolder(projectId, folderId);
}

export function projectsSetWorkspaceFolder(
  deps: IpcDeps,
  projectId: string,
  workspacePath: string,
  folderId: string | null,
): void {
  deps.projectManager.setWorkspaceFolder(projectId, workspacePath, folderId);
}

/** `orderedKeys` entries may be workspace paths or folder ids (ADR-167). */
export function projectsReorderWorkspaces(
  deps: IpcDeps,
  projectId: string,
  orderedKeys: string[],
): void {
  deps.projectManager.reorderWorkspaces(projectId, orderedKeys);
}

export function projectsReorder(deps: IpcDeps, orderedIds: string[]): void {
  deps.projectManager.reorderProjects(orderedIds);
}

export function projectsUpdate(
  deps: IpcDeps,
  projectId: string,
  updates: ProjectUpdatableFields,
): Promise<ProjectInfo | null> {
  return deps.projectManager.updateProject(projectId, updates);
}
