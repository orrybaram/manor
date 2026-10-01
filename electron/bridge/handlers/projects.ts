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

import { assertGroupUpdates, assertString } from "../../ipc-validate";
import {
  publishRendererBroadcast,
  publishToRenderer,
} from "../../renderer-broadcast";
import type {
  GroupUpdatableFields,
  ProjectInfo,
  ProjectUpdatableFields,
  WorkspaceFolder,
} from "../../persistence";
import type { LinkedIssue } from "../../linear";
import type { LayoutOrigin } from "../../layout/layout-store";
import { LOCAL_HOST_ID } from "../../backend/types";
import { workspaceKey } from "../../../src/lib/workspace-key";
import type { IpcDeps } from "../../ipc/types";

/**
 * A project that moved from `oldHostId` keeps the saved layouts of the
 * workspaces it still has, under their keys on its new host (ADR-191 §3).
 * The layout store owns them (ADR-179 D1) and broadcasts the move, so every
 * renderer's replica follows.
 */
async function moveLayouts(
  deps: IpcDeps,
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
export function projectsGetAll(deps: IpcDeps): unknown {
  return deps.projectManager.getProjects();
}

/** Only remote projects, their worktrees listed afresh. */
export function projectsGetRemote(deps: IpcDeps): unknown {
  return deps.projectManager.getRemoteProjects();
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
 * Clone a repo onto any host, then add it (ADR-178 ticket 5, ADR-194).
 * Progress goes out as `projects.cloneProgress`.
 */
export async function projectsClone(
  deps: IpcDeps,
  opts: { hostId: string; repoUrl: string; targetDir: string; name: string },
): Promise<ProjectInfo> {
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
  deps: IpcDeps,
  projectId: string,
  opts: { hostId: string; repoUrl: string; remoteDir: string },
): Promise<ProjectInfo> {
  assertString(projectId, "projectId");
  assertString(opts?.hostId, "hostId");
  assertString(opts?.repoUrl, "repoUrl");
  assertString(opts?.remoteDir, "remoteDir");
  const { projectManager } = deps;
  projectManager.assertRemoteHost(opts.hostId);
  await deps.backendRegistry.ensureConnected(opts.hostId);
  const oldHostId = projectManager.getProjectHostId(projectId);
  return moveLayouts(
    deps,
    oldHostId,
    await projectManager.moveProjectToHost(projectId, opts),
  );
}

export function projectsGetOriginUrl(
  deps: IpcDeps,
  projectId: string,
): Promise<string | null> {
  assertString(projectId, "projectId");
  return deps.projectManager.getOriginUrl(projectId);
}

export function projectsPathExists(
  deps: IpcDeps,
  projectId: string,
): Promise<boolean> {
  assertString(projectId, "projectId");
  return deps.projectManager.projectPathExists(projectId);
}

/**
 * ADR-179 (remote hosts): switch a project to a host without cloning — to
 * `path`, or the path it last had there. Refused when that path doesn't
 * exist on the host.
 */
export async function projectsSwitchHost(
  deps: IpcDeps,
  projectId: string,
  hostId: string,
  projectPath?: string | null,
): Promise<ProjectInfo> {
  assertString(projectId, "projectId");
  assertString(hostId, "hostId");
  // Null is an omitted argument that crossed the socket (see `surface.ts`).
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
  // Through `workspaceOps` (ADR-203), which owes the stats counter and the
  // `projects.changed` broadcast.
  await deps.workspaceOps.remove(
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
  await deps.workspaceOps.quickMerge(projectId, worktreePath);
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
  // The renderer runs the setup script itself (its pending setup view may
  // launch an agent alongside it), so main must not (ADR-203).
  const { project } = await deps.workspaceOps.create(
    {
      projectId,
      name,
      branch,
      linkedIssue,
      baseBranch,
      useExistingBranch,
      origin: origin?.id ?? null,
    },
    { runSetupScript: false },
  );
  return project;
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

/**
 * ADR-192: link two projects on different hosts into one group, or take one
 * out of its group. A project leaving keeps the group's shared settings;
 * nothing else about it changes.
 */
export function projectsLink(
  deps: IpcDeps,
  projectId: string,
  otherId: string,
): unknown {
  assertString(projectId, "projectId");
  assertString(otherId, "otherId");
  return deps.projectManager.linkProjects(projectId, otherId);
}

export function projectsUnlink(deps: IpcDeps, projectId: string): void {
  assertString(projectId, "projectId");
  deps.projectManager.unlinkProject(projectId);
}

export function projectsUnlinkGroup(deps: IpcDeps, groupId: string): void {
  assertString(groupId, "groupId");
  deps.projectManager.unlinkGroup(groupId);
}

/** ADR-192 ticket 2: set a group's shared settings. Returns every member. */
export function projectsUpdateGroup(
  deps: IpcDeps,
  groupId: unknown,
  updates: unknown,
): unknown {
  assertString(groupId, "groupId");
  assertGroupUpdates(updates, "updates");
  const { linearAssociations, ...rest } = updates;
  const clean: GroupUpdatableFields = { ...rest };
  // Null clears the group's teams.
  if (linearAssociations !== undefined) {
    clean.linearAssociations = linearAssociations ?? [];
  }
  return deps.projectManager.updateGroup(groupId, clean);
}

/** ADR-192: the host the New Workspace picker starts on next time. */
export function projectsSetGroupLastUsedHost(
  deps: IpcDeps,
  groupId: string,
  hostId: string,
): void {
  assertString(groupId, "groupId");
  assertString(hostId, "hostId");
  deps.projectManager.setGroupLastUsedHost(groupId, hostId);
}

/**
 * ADR-192 ticket 5: projects on other hosts with the same `origin`, to offer
 * as links after an add or clone. Suggests only; never links.
 */
export function projectsSuggestLinks(deps: IpcDeps, projectId: string): unknown {
  assertString(projectId, "projectId");
  return deps.projectManager.suggestLinks(projectId);
}

export function projectsDismissLinkSuggestion(
  deps: IpcDeps,
  projectId: string,
  otherId: string,
): void {
  assertString(projectId, "projectId");
  assertString(otherId, "otherId");
  deps.projectManager.dismissLinkSuggestion(projectId, otherId);
}

export function projectsUpdate(
  deps: IpcDeps,
  projectId: string,
  updates: ProjectUpdatableFields,
): Promise<ProjectInfo | null> {
  return deps.projectManager.updateProject(projectId, updates);
}
