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

import { assertGroupUpdates, assertString } from "../../ipc-validate";
import { publishToRenderer } from "../../renderer-broadcast";
import type {
  CreateWorktreeOptions,
  GroupUpdatableFields,
  ProjectInfo,
  ProjectUpdatableFields,
  WorkspaceFolder,
} from "../../persistence";
import { LOCAL_HOST_ID } from "../../backend/types";
import { workspaceKey } from "../../../src/lib/workspace-key";
import type { TransferMode, TransferResult } from "../../projects/types";
import type { HostDeps } from "../../ipc/types";
import { method, type HandlerCtx } from "../method";

/**
 * A project that moved from `oldHostId` keeps the saved layouts of the
 * workspaces it still has, under their keys on its new host (ADR-191 §3).
 * The layout store owns them (ADR-179 D1) and broadcasts the move, so every
 * renderer's replica follows.
 */
async function moveLayouts(
  deps: HostDeps,
  oldHostId: string,
  moved: ProjectInfo,
): Promise<ProjectInfo> {
  if (oldHostId !== moved.hostId) {
    await deps.layoutStore.moveWorkspaces(
      moved.workspaces.map((ws) => [
        workspaceKey(oldHostId, ws.path),
        workspaceKey(moved.hostId, ws.path),
      ]),
    );
  }
  return moved;
}

/** The four the sidebar needs to paint itself. */
export function projectsGetAll(ctx: HandlerCtx): Promise<ProjectInfo[]> {
  return ctx.deps.projectManager.getProjects();
}

/** Only remote projects, their worktrees listed afresh. */
export function projectsGetRemote(ctx: HandlerCtx): Promise<ProjectInfo[]> {
  return ctx.deps.projectManager.getRemoteProjects();
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
 * Clone a repo onto any host, then add it (ADR-178 ticket 5, ADR-194).
 * Progress goes out as `projects.cloneProgress`.
 */
export async function projectsClone(
  ctx: HandlerCtx,
  opts: { hostId: string; repoUrl: string; targetDir: string; name: string },
): Promise<ProjectInfo> {
  const { deps } = ctx;
  assertString(opts?.hostId, "hostId");
  assertString(opts?.repoUrl, "repoUrl");
  assertString(opts?.targetDir, "targetDir");
  assertString(opts?.name, "name");
  deps.projectManager.assertKnownHost(opts.hostId);
  // Connect (and start the box, for a managed provider) before cloning — a
  // clone against a host that never got the chance to connect would just
  // fail with a confusing "unavailable" error. This machine is always
  // connected.
  if (opts.hostId !== LOCAL_HOST_ID) {
    await deps.backendRegistry.ensureConnected(opts.hostId);
  }
  return deps.projectManager.cloneProject(opts);
}

/**
 * ADR-179 (remote hosts): clone (or adopt) an existing project's repo onto a
 * remote host and point the same project record at it.
 */
export async function projectsMoveToHost(
  ctx: HandlerCtx,
  projectId: string,
  opts: { hostId: string; repoUrl: string; remoteDir: string },
): Promise<ProjectInfo> {
  const { deps } = ctx;
  assertString(projectId, "projectId");
  assertString(opts?.hostId, "hostId");
  assertString(opts?.repoUrl, "repoUrl");
  assertString(opts?.remoteDir, "remoteDir");
  const { projectManager } = deps;
  projectManager.assertKnownHost(opts.hostId);
  if (opts.hostId !== LOCAL_HOST_ID) {
    await deps.backendRegistry.ensureConnected(opts.hostId);
  }
  const oldHostId = projectManager.getProjectHostId(projectId);
  return moveLayouts(
    deps,
    oldHostId,
    await projectManager.moveProjectToHost(projectId, opts),
  );
}

/**
 * ADR-213: copy a project to a host (a new linked project) or move it
 * (re-point this one), either way. Either completes, or answers
 * `{ ok: false, needsInput }` with what to ask; the dialog calls again with
 * `repoUrl` / `targetDir` filled in.
 */
export async function projectsTransfer(
  ctx: HandlerCtx,
  opts: {
    projectId: string;
    hostId: string;
    mode: TransferMode;
    repoUrl?: string;
    targetDir?: string;
  },
): Promise<TransferResult> {
  const { deps } = ctx;
  assertString(opts?.projectId, "projectId");
  assertString(opts?.hostId, "hostId");
  if (opts.mode !== "copy" && opts.mode !== "move") {
    throw new Error("mode must be 'copy' or 'move'");
  }
  if (opts.repoUrl !== undefined) assertString(opts.repoUrl, "repoUrl");
  if (opts.targetDir !== undefined) assertString(opts.targetDir, "targetDir");
  deps.projectManager.assertKnownHost(opts.hostId);
  if (opts.hostId !== LOCAL_HOST_ID) {
    await deps.backendRegistry.ensureConnected(opts.hostId);
  }
  const overrides =
    opts.repoUrl !== undefined && opts.targetDir !== undefined
      ? { repoUrl: opts.repoUrl, targetDir: opts.targetDir }
      : undefined;
  return deps.projectManager.transferProject(
    opts.projectId,
    opts.hostId,
    opts.mode,
    overrides,
  );
}

export function projectsGetOriginUrl(
  ctx: HandlerCtx,
  projectId: string,
): Promise<string | null> {
  assertString(projectId, "projectId");
  return ctx.deps.projectManager.getOriginUrl(projectId);
}

export function projectsPathExists(
  ctx: HandlerCtx,
  projectId: string,
): Promise<boolean> {
  assertString(projectId, "projectId");
  return ctx.deps.projectManager.projectPathExists(projectId);
}

/**
 * ADR-179 (remote hosts): switch a project to a host without cloning — to
 * `path`, or the path it last had there. Refused when that path doesn't
 * exist on the host.
 */
export async function projectsSwitchHost(
  ctx: HandlerCtx,
  projectId: string,
  hostId: string,
  projectPath?: string | null,
): Promise<ProjectInfo> {
  const { deps } = ctx;
  assertString(projectId, "projectId");
  assertString(hostId, "hostId");
  // Null is an omitted argument that crossed the socket.
  const requestedPath = projectPath ?? undefined;
  if (requestedPath !== undefined) assertString(requestedPath, "path");
  const { projectManager } = deps;
  projectManager.assertKnownHost(hostId);
  if (hostId !== LOCAL_HOST_ID) {
    await deps.backendRegistry.ensureConnected(hostId);
  }
  const oldHostId = projectManager.getProjectHostId(projectId);
  return moveLayouts(
    deps,
    oldHostId,
    await projectManager.switchProjectHost(projectId, hostId, requestedPath),
  );
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
  // Through `workspaceOps` (ADR-203), which owes the stats counter and the
  // `projects.changed` broadcast.
  await ctx.deps.workspaceOps.remove(
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
  await ctx.deps.workspaceOps.quickMerge(projectId, worktreePath);
}

/**
 * Make a worktree, and tell the caller how it is going: `ProjectManager`
 * takes the caller's id as the connection its setup progress goes back to.
 */
export async function projectsCreateWorktree(
  ctx: HandlerCtx,
  projectId: string,
  name: string,
  opts: Omit<CreateWorktreeOptions, "origin"> = {},
): Promise<ProjectInfo | null> {
  // Picked field by field rather than spread: `origin` is who asked, and that
  // is the transport's to say, never the frame's. The renderer runs the setup
  // script itself (its pending setup view may launch an agent alongside it),
  // so `workspaceOps` (ADR-203) must not.
  const { project } = await ctx.deps.workspaceOps.create(
    {
      projectId,
      name,
      branch: opts.branch,
      linkedIssue: opts.linkedIssue,
      baseBranch: opts.baseBranch,
      useExistingBranch: opts.useExistingBranch,
      folderId: opts.folderId,
      origin: ctx.caller.id,
    },
    { runSetupScript: false },
  );
  return project;
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
  ctx.deps.projectManager.setWorkspaceFolder(
    projectId,
    workspacePath,
    folderId,
  );
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

/**
 * ADR-192: link two projects on different hosts into one group, or take one
 * out of its group. A project leaving keeps the group's shared settings;
 * nothing else about it changes.
 */
export function projectsLink(
  ctx: HandlerCtx,
  projectId: string,
  otherId: string,
): ReturnType<HostDeps["projectManager"]["linkProjects"]> {
  assertString(projectId, "projectId");
  assertString(otherId, "otherId");
  return ctx.deps.projectManager.linkProjects(projectId, otherId);
}

export function projectsUnlink(ctx: HandlerCtx, projectId: string): void {
  assertString(projectId, "projectId");
  ctx.deps.projectManager.unlinkProject(projectId);
}

export function projectsUnlinkGroup(ctx: HandlerCtx, groupId: string): void {
  assertString(groupId, "groupId");
  ctx.deps.projectManager.unlinkGroup(groupId);
}

/** ADR-192 ticket 2: set a group's shared settings. Returns every member. */
export function projectsUpdateGroup(
  ctx: HandlerCtx,
  groupId: unknown,
  updates: unknown,
): ReturnType<HostDeps["projectManager"]["updateGroup"]> {
  assertString(groupId, "groupId");
  assertGroupUpdates(updates, "updates");
  const { linearAssociations, ...rest } = updates;
  const clean: GroupUpdatableFields = { ...rest };
  // Null clears the group's teams.
  if (linearAssociations !== undefined) {
    clean.linearAssociations = linearAssociations ?? [];
  }
  return ctx.deps.projectManager.updateGroup(groupId, clean);
}

/** ADR-192: the host the New Workspace picker starts on next time. */
export function projectsSetGroupLastUsedHost(
  ctx: HandlerCtx,
  groupId: string,
  hostId: string,
): void {
  assertString(groupId, "groupId");
  assertString(hostId, "hostId");
  ctx.deps.projectManager.setGroupLastUsedHost(groupId, hostId);
}

/**
 * ADR-192 ticket 5: projects on other hosts with the same `origin`, to offer
 * as links after an add or clone. Suggests only; never links.
 */
export function projectsSuggestLinks(
  ctx: HandlerCtx,
  projectId: string,
): ReturnType<HostDeps["projectManager"]["suggestLinks"]> {
  assertString(projectId, "projectId");
  return ctx.deps.projectManager.suggestLinks(projectId);
}

export function projectsDismissLinkSuggestion(
  ctx: HandlerCtx,
  projectId: string,
  otherId: string,
): void {
  assertString(projectId, "projectId");
  assertString(otherId, "otherId");
  ctx.deps.projectManager.dismissLinkSuggestion(projectId, otherId);
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
  getRemote: method(projectsGetRemote),
  // Main's remote-host project lifecycle (ADR-191/194 on main). `clone`'s
  // progress is the `projects.cloneProgress` broadcast. Each of these moves
  // a project, a group, or what the sidebar shows.
  clone: method(projectsClone, { mutating: true }),
  moveToHost: method(projectsMoveToHost, { mutating: true }),
  transfer: method(projectsTransfer, { mutating: true }),
  getOriginUrl: method(projectsGetOriginUrl),
  pathExists: method(projectsPathExists),
  switchHost: method(projectsSwitchHost, { mutating: true }),
  // ADR-192: linked project groups.
  link: method(projectsLink, { mutating: true }),
  unlink: method(projectsUnlink, { mutating: true }),
  unlinkGroup: method(projectsUnlinkGroup, { mutating: true }),
  updateGroup: method(projectsUpdateGroup, { mutating: true }),
  setGroupLastUsedHost: method(projectsSetGroupLastUsedHost, {
    mutating: true,
  }),
  suggestLinks: method(projectsSuggestLinks),
  dismissLinkSuggestion: method(projectsDismissLinkSuggestion, {
    mutating: true,
  }),
};
