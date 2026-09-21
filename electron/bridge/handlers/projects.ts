/**
 * Projects and workspaces (ADR-180 D8), as the `projects` namespace of the
 * handler table.
 *
 * Every one of these is reachable by a paired `full` device — ADR-178 D3 as
 * written, and as the pairing dialog's label already warns ("can do anything
 * the desktop can, including remove workspaces"). The ones that create,
 * rename, move or destroy a project, a workspace or a folder are `mutating`,
 * so a device's call leaves an audit line and the user at the machine's does
 * not.
 *
 * **Progress goes back to the caller, not to every window.** Making and
 * removing a worktree both report their steps to `ctx.caller.id` — a
 * connection id on both transports — so one dialog, in one window, sees its
 * own progress bar and a second window sees nothing.
 */

import { assertString } from "../../ipc-validate";
import { publishToRenderer } from "../../renderer-broadcast";
import type {
  ProjectInfo,
  ProjectUpdatableFields,
  WorkspaceFolder,
} from "../../persistence";
import type { LinkedIssue } from "../../linear";
import { method, type HandlerCtx } from "../method";

/** The four the sidebar needs to paint itself. */
export function projectsGetAll(ctx: HandlerCtx): Promise<ProjectInfo[]> {
  return ctx.deps.projectManager.getProjects();
}

export function projectsGetSelectedIndex(ctx: HandlerCtx): number {
  return ctx.deps.projectManager.getSelectedProjectIndex();
}

export function projectsSelect(ctx: HandlerCtx, index: number): void {
  ctx.deps.projectManager.selectProject(index);
}

export function projectsSelectWorkspace(
  ctx: HandlerCtx,
  projectId: string,
  workspaceIndex: number,
): void {
  ctx.deps.projectManager.selectWorkspace(projectId, workspaceIndex);
}

export function projectsAdd(
  ctx: HandlerCtx,
  name: string,
  projectPath: string,
): Promise<ProjectInfo> {
  assertString(name, "name");
  assertString(projectPath, "path");
  return ctx.deps.projectManager.addProject(name, projectPath);
}

export function projectsRemove(
  ctx: HandlerCtx,
  projectId: string,
): Promise<void> {
  return ctx.deps.projectManager.removeProject(projectId);
}

/**
 * Tear a worktree down, reporting each step to whoever asked for it as a
 * `projects.removeWorktreeProgress` event (ADR-180 D5).
 */
export async function projectsRemoveWorktree(
  ctx: HandlerCtx,
  projectId: string,
  worktreePath: string,
  deleteBranch?: boolean,
): Promise<void> {
  await ctx.deps.projectManager.removeWorktree(
    projectId,
    worktreePath,
    deleteBranch,
    (step: string) => {
      publishToRenderer(
        ctx.caller.id,
        "projects",
        "removeWorktreeProgress",
        step,
      );
    },
  );
  ctx.deps.statsStore.record("worktreesRemoved");
}

export function projectsCanQuickMerge(
  ctx: HandlerCtx,
  projectId: string,
  worktreePath: string,
): Promise<{ canMerge: boolean; reason?: string }> {
  return ctx.deps.projectManager.canQuickMerge(projectId, worktreePath);
}

export async function projectsQuickMergeWorktree(
  ctx: HandlerCtx,
  projectId: string,
  worktreePath: string,
): Promise<void> {
  await ctx.deps.projectManager.quickMergeWorktree(projectId, worktreePath);
  ctx.deps.statsStore.record("worktreesMerged");
}

/**
 * Make a worktree, and tell the caller how it is going: `ProjectManager`
 * takes the caller's id as the connection its setup progress goes back to.
 */
export async function projectsCreateWorktree(
  ctx: HandlerCtx,
  projectId: string,
  name: string,
  branch?: string,
  linkedIssue?: LinkedIssue,
  baseBranch?: string,
  useExistingBranch?: boolean,
): Promise<ProjectInfo | null> {
  const result = await ctx.deps.projectManager.createWorktree(
    projectId,
    name,
    branch,
    linkedIssue,
    baseBranch,
    useExistingBranch,
    ctx.caller.id,
  );
  ctx.deps.statsStore.record("worktreesCreated");
  return result;
}

export function projectsConvertMainToWorktree(
  ctx: HandlerCtx,
  projectId: string,
  name: string,
): Promise<ProjectInfo | null> {
  return ctx.deps.projectManager.convertMainToWorktree(projectId, name);
}

export function projectsListRemoteBranches(
  ctx: HandlerCtx,
  projectId: string,
): Promise<string[]> {
  return ctx.deps.projectManager.listRemoteBranches(projectId);
}

export function projectsListLocalBranches(
  ctx: HandlerCtx,
  projectId: string,
): Promise<string[]> {
  return ctx.deps.projectManager.listLocalBranches(projectId);
}

export function projectsRenameWorkspace(
  ctx: HandlerCtx,
  projectId: string,
  workspacePath: string,
  newName: string,
): void {
  ctx.deps.projectManager.renameWorkspace(projectId, workspacePath, newName);
}

export function projectsSetWorkspaceHidden(
  ctx: HandlerCtx,
  projectId: string,
  workspacePath: string,
  hidden: boolean,
): void {
  ctx.deps.projectManager.setWorkspaceHidden(projectId, workspacePath, hidden);
}

export function projectsCreateWorkspaceFolder(
  ctx: HandlerCtx,
  projectId: string,
  name: string,
  parentId?: string | null,
): WorkspaceFolder | null {
  assertString(name, "name");
  return ctx.deps.projectManager.createWorkspaceFolder(
    projectId,
    name,
    parentId ?? null,
  );
}

/** Returns false when the move would create a folder cycle (ADR-172). */
export function projectsSetFolderParent(
  ctx: HandlerCtx,
  projectId: string,
  folderId: string,
  parentId: string | null,
): boolean {
  return ctx.deps.projectManager.setFolderParent(projectId, folderId, parentId);
}

export function projectsRenameWorkspaceFolder(
  ctx: HandlerCtx,
  projectId: string,
  folderId: string,
  name: string,
): void {
  assertString(name, "name");
  ctx.deps.projectManager.renameWorkspaceFolder(projectId, folderId, name);
}

export function projectsDeleteWorkspaceFolder(
  ctx: HandlerCtx,
  projectId: string,
  folderId: string,
): void {
  ctx.deps.projectManager.deleteWorkspaceFolder(projectId, folderId);
}

export function projectsSetWorkspaceFolder(
  ctx: HandlerCtx,
  projectId: string,
  workspacePath: string,
  folderId: string | null,
): void {
  ctx.deps.projectManager.setWorkspaceFolder(projectId, workspacePath, folderId);
}

/** `orderedKeys` entries may be workspace paths or folder ids (ADR-167). */
export function projectsReorderWorkspaces(
  ctx: HandlerCtx,
  projectId: string,
  orderedKeys: string[],
): void {
  ctx.deps.projectManager.reorderWorkspaces(projectId, orderedKeys);
}

export function projectsReorder(ctx: HandlerCtx, orderedIds: string[]): void {
  ctx.deps.projectManager.reorderProjects(orderedIds);
}

export function projectsUpdate(
  ctx: HandlerCtx,
  projectId: string,
  updates: ProjectUpdatableFields,
): Promise<ProjectInfo | null> {
  return ctx.deps.projectManager.updateProject(projectId, updates);
}

export const projects = {
  getAll: method(projectsGetAll),
  getSelectedIndex: method(projectsGetSelectedIndex),
  select: method(projectsSelect, { mutating: true }),
  selectWorkspace: method(projectsSelectWorkspace, { mutating: true }),
  add: method(projectsAdd, { mutating: true }),
  remove: method(projectsRemove, { mutating: true }),
  removeWorktree: method(projectsRemoveWorktree, { mutating: true }),
  // `canQuickMerge` and the two branch listings read.
  canQuickMerge: method(projectsCanQuickMerge),
  quickMergeWorktree: method(projectsQuickMergeWorktree, { mutating: true }),
  createWorktree: method(projectsCreateWorktree, { mutating: true }),
  convertMainToWorktree: method(projectsConvertMainToWorktree, {
    mutating: true,
  }),
  listRemoteBranches: method(projectsListRemoteBranches),
  listLocalBranches: method(projectsListLocalBranches),
  renameWorkspace: method(projectsRenameWorkspace, { mutating: true }),
  setWorkspaceHidden: method(projectsSetWorkspaceHidden, { mutating: true }),
  createWorkspaceFolder: method(projectsCreateWorkspaceFolder, {
    mutating: true,
  }),
  setFolderParent: method(projectsSetFolderParent, { mutating: true }),
  renameWorkspaceFolder: method(projectsRenameWorkspaceFolder, {
    mutating: true,
  }),
  deleteWorkspaceFolder: method(projectsDeleteWorkspaceFolder, {
    mutating: true,
  }),
  setWorkspaceFolder: method(projectsSetWorkspaceFolder, { mutating: true }),
  reorderWorkspaces: method(projectsReorderWorkspaces, { mutating: true }),
  reorder: method(projectsReorder, { mutating: true }),
  update: method(projectsUpdate, { mutating: true }),
};
