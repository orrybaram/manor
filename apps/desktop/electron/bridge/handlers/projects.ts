/**
 * Projects and workspaces, as the `projects` namespace of the
 * handler table.
 *
 * Every one of these is reachable by a paired `full` device — by design, and
 * as the pairing dialog's label already warns ("can do anything
 * the desktop can, including remove workspaces"). The ones that create,
 * rename, move or destroy a project, a workspace or a folder are `mutating`,
 * so a device's call leaves an audit line and the user at the machine's does
 * not.
 *
 * **Progress goes back to the caller, not to every window.** Making and
 * removing a worktree both report their steps to `ctx.caller.id` — a
 * connection id on both transports — so one dialog, in one window, sees its
 * own progress bar and a second window sees nothing.
 *
 * **Routed on the desktop**. A project on an adopted remote host
 * is its server's: every workspace method names its project first
 * (`byProject(0)`) and is answered there. The rest stay here — they read or
 * write what only the desktop has (the merged list, the sidebar's order,
 * linked-project groups, moves between hosts), and `ProjectManager` reaches
 * each host's server itself where they touch a remote project.
 */

import { assertGroupUpdates, assertString } from "../../ipc-validate";
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
import {
  openInNewHost,
  type OpenInNewHostInput,
  type OpenInNewHostResult,
} from "../../projects/new-host-for-project";
import { publishRendererBroadcast } from "../../renderer-broadcast";
import { START_SCRIPT_MAX_WAIT_MS, type SetupScriptEnd } from "../../workspace-ops";
import type { ServerDeps, SharedDeps } from "../../ipc/types";
import { byProject, LOCAL_ROUTE, method, type HandlerCtx } from "../method";

/**
 * A project that moved from `oldHostId` keeps the saved layouts of the
 * workspaces it still has, under their keys on its new host.
 * The layout store owns them and broadcasts the move, so every
 * renderer's replica follows.
 */
async function moveLayouts(
  deps: ServerDeps,
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
export function projectsGetAll(
  ctx: HandlerCtx<SharedDeps>,
): Promise<ProjectInfo[]> {
  return ctx.deps.projectManager.getProjects();
}

/** Only remote projects, their worktrees listed afresh. */
export function projectsGetRemote(
  ctx: HandlerCtx<ServerDeps>,
): Promise<ProjectInfo[]> {
  return ctx.deps.projectManager.getRemoteProjects();
}

export function projectsGetSelectedIndex(ctx: HandlerCtx<SharedDeps>): number {
  return ctx.deps.projectManager.getSelectedProjectIndex();
}

export function projectsSelect(
  ctx: HandlerCtx<ServerDeps>,
  index: number,
): void {
  ctx.deps.projectManager.selectProject(index);
}

export function projectsSelectWorkspace(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
  workspaceIndex: number,
): void {
  ctx.deps.projectManager.selectWorkspace(projectId, workspaceIndex);
}

export function projectsAdd(
  ctx: HandlerCtx<SharedDeps>,
  name: string,
  projectPath: string,
): Promise<ProjectInfo> {
  assertString(name, "name");
  assertString(projectPath, "path");
  return ctx.deps.projectManager.addProject(name, projectPath);
}

export async function projectsRemove(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
): Promise<void> {
  const { projectManager, backendRegistry } = ctx.deps;
  // Removing a project clears `forProject` on the hosts made for it;
  // the host list is re-sent so no one shows a stale mark.
  const marked = projectManager.hostsMadeFor(projectId);
  await projectManager.removeProject(projectId);
  for (const hostId of marked) backendRegistry.recordChanged(hostId);
}

/**
 * Clone a repo onto any host, then add it.
 * Progress goes out as `projects.cloneProgress`.
 */
export async function projectsClone(
  ctx: HandlerCtx<SharedDeps>,
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
 * Remote hosts: clone (or adopt) an existing project's repo onto a
 * remote host and point the same project record at it.
 */
export async function projectsMoveToHost(
  ctx: HandlerCtx<ServerDeps>,
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
  const moved = await moveLayouts(
    deps,
    oldHostId,
    await projectManager.moveProjectToHost(projectId, opts),
  );
  // The layouts just moved onto an adopted host go to its server too.
  await projectManager.handOverHost(moved.hostId);
  return moved;
}

/**
 * Copy a project to a host (a new linked project) or move it
 * (re-point this one), either way. Either completes, or answers
 * `{ ok: false, needsInput }` with what to ask; the dialog calls again with
 * `repoUrl` / `targetDir` filled in.
 */
export async function projectsTransfer(
  ctx: HandlerCtx<ServerDeps>,
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

/**
 * "In a new pod": make a host from profile `profileId`, bring
 * it up, and clone `repoUrl` onto it — or, with `sourceProjectId` (Set up
 * on), copy that project there, joining its group. A failure keeps the host
 * and answers the stage; `retryFrom` resumes on that host, with the
 * fallback dialog's `overrides` for a copy that needed input.
 */
export async function projectsOpenInNewHost(
  ctx: HandlerCtx<ServerDeps>,
  input: OpenInNewHostInput,
): Promise<OpenInNewHostResult> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("projects:openInNewHost.input must be an object");
  }
  assertString(input.profileId, "profileId");
  assertString(input.repoUrl, "repoUrl");
  if (input.repoUrl.trim() === "") throw new Error("A repository URL is required.");
  if (input.sourceProjectId !== undefined) {
    assertString(input.sourceProjectId, "sourceProjectId");
  }
  let retryFrom: OpenInNewHostInput["retryFrom"];
  if (input.retryFrom !== undefined) {
    const { hostId, stage, overrides } = input.retryFrom ?? {};
    assertString(hostId, "retryFrom.hostId");
    if (stage !== "up" && stage !== "clone") {
      throw new Error("retryFrom.stage must be 'up' or 'clone'");
    }
    if (overrides !== undefined) {
      if (stage !== "clone") throw new Error("retryFrom.overrides is only for stage 'clone'");
      if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
        throw new Error("retryFrom.overrides must be an object");
      }
      assertString(overrides.repoUrl, "retryFrom.overrides.repoUrl");
      assertString(overrides.targetDir, "retryFrom.overrides.targetDir");
      const repoUrl = overrides.repoUrl.trim();
      const targetDir = overrides.targetDir.trim();
      if (repoUrl === "" || targetDir === "") {
        throw new Error("retryFrom.overrides needs a repoUrl and a targetDir");
      }
      retryFrom = { hostId, stage, overrides: { repoUrl, targetDir } };
    } else {
      retryFrom = { hostId, stage };
    }
  }
  const { deps } = ctx;
  const result = await openInNewHost(
    {
      projectManager: deps.projectManager,
      backendRegistry: deps.backendRegistry,
      ...(deps.hostAdoption ? { hostAdoption: deps.hostAdoption } : {}),
    },
    {
      profileId: input.profileId,
      repoUrl: input.repoUrl.trim(),
      ...(input.sourceProjectId !== undefined ? { sourceProjectId: input.sourceProjectId } : {}),
      ...(retryFrom ? { retryFrom } : {}),
    },
  );
  if (result.ok) publishRendererBroadcast("projects", "changed");
  return result;
}

export function projectsGetOriginUrl(
  ctx: HandlerCtx<ServerDeps>,
  projectId: string,
): Promise<string | null> {
  assertString(projectId, "projectId");
  return ctx.deps.projectManager.getOriginUrl(projectId);
}

export function projectsPathExists(
  ctx: HandlerCtx<ServerDeps>,
  projectId: string,
): Promise<boolean> {
  assertString(projectId, "projectId");
  return ctx.deps.projectManager.projectPathExists(projectId);
}

/**
 * Remote hosts: switch a project to a host without cloning — to
 * `path`, or the path it last had there. Refused when that path doesn't
 * exist on the host.
 */
export async function projectsSwitchHost(
  ctx: HandlerCtx<ServerDeps>,
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
  const moved = await moveLayouts(
    deps,
    oldHostId,
    await projectManager.switchProjectHost(projectId, hostId, requestedPath),
  );
  await projectManager.handOverHost(moved.hostId);
  return moved;
}

/**
 * Tear a worktree down, reporting each step to whoever asked for it as a
 * `projects.removeWorktreeProgress` event.
 */
export async function projectsRemoveWorktree(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
  worktreePath: string,
  deleteBranch?: boolean,
): Promise<void> {
  // Through `workspaceOps`, which owes the stats counter and the
  // `projects.changed` broadcast.
  await ctx.deps.workspaceOps.remove(
    projectId,
    worktreePath,
    deleteBranch,
    (step: string) => {
      ctx.deps.workspaceOps.publishRemoveProgress(ctx.caller.id, step);
    },
  );
}

export function projectsCanQuickMerge(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
  worktreePath: string,
): Promise<{ canMerge: boolean; reason?: string }> {
  return ctx.deps.projectManager.canQuickMerge(projectId, worktreePath);
}

export async function projectsQuickMergeWorktree(
  ctx: HandlerCtx<SharedDeps>,
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
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
  name: string,
  opts: Omit<CreateWorktreeOptions, "origin"> & { skipStartScript?: boolean } = {},
): Promise<ProjectInfo | null> {
  // Picked field by field rather than spread: `origin` is who asked, and that
  // is the transport's to say, never the frame's. The setup script starts on
  // the server, in a tab of its own.
  const { project } = await ctx.deps.workspaceOps.create({
    projectId,
    name,
    branch: opts.branch,
    linkedIssue: opts.linkedIssue,
    baseBranch: opts.baseBranch,
    useExistingBranch: opts.useExistingBranch,
    folderId: opts.folderId,
    origin: ctx.caller.id,
    ...(opts.skipStartScript === true ? { skipStartScript: true } : {}),
  });
  return project;
}

/**
 * Run a workspace's start script and wait for it to end, up to
 * `timeoutMs` (10 minutes by default, 30 at most): for a caller that made
 * the workspace with `skipStartScript` and readied it first (a move to
 * another host). Null when the project has no start script.
 */
export async function projectsRunStartScript(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
  workspacePath: string,
  timeoutMs?: number | null,
): Promise<SetupScriptEnd | null> {
  assertString(projectId, "projectId");
  assertString(workspacePath, "workspacePath");
  const wait =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, START_SCRIPT_MAX_WAIT_MS)
      : 10 * 60_000;
  const project = (await ctx.deps.projectManager.getProjects()).find((p) => p.id === projectId);
  if (!project) throw new Error(`Unknown project "${projectId}".`);
  if (!project.workspaces.some((ws) => ws.path === workspacePath)) {
    throw new Error(`"${workspacePath}" is not a workspace of ${project.name}.`);
  }
  return ctx.deps.workspaceOps.runStartScript(project, workspacePath, {
    timeoutMs: wait,
    origin: ctx.caller.id,
  });
}

export function projectsConvertMainToWorktree(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
  name: string,
): Promise<ProjectInfo | null> {
  return ctx.deps.projectManager.convertMainToWorktree(projectId, name);
}

export function projectsListRemoteBranches(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
): Promise<string[]> {
  return ctx.deps.projectManager.listRemoteBranches(projectId);
}

export function projectsListLocalBranches(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
): Promise<string[]> {
  return ctx.deps.projectManager.listLocalBranches(projectId);
}

export function projectsRenameWorkspace(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
  workspacePath: string,
  newName: string,
): void {
  ctx.deps.projectManager.renameWorkspace(projectId, workspacePath, newName);
}

export function projectsSetWorkspaceHidden(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
  workspacePath: string,
  hidden: boolean,
): void {
  ctx.deps.projectManager.setWorkspaceHidden(projectId, workspacePath, hidden);
}

export function projectsCreateWorkspaceFolder(
  ctx: HandlerCtx<SharedDeps>,
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

/** Returns false when the move would create a folder cycle. */
export function projectsSetFolderParent(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
  folderId: string,
  parentId: string | null,
): boolean {
  return ctx.deps.projectManager.setFolderParent(projectId, folderId, parentId);
}

export function projectsRenameWorkspaceFolder(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
  folderId: string,
  name: string,
): void {
  assertString(name, "name");
  ctx.deps.projectManager.renameWorkspaceFolder(projectId, folderId, name);
}

export function projectsDeleteWorkspaceFolder(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
  folderId: string,
): void {
  ctx.deps.projectManager.deleteWorkspaceFolder(projectId, folderId);
}

export function projectsSetWorkspaceFolder(
  ctx: HandlerCtx<SharedDeps>,
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

/** `orderedKeys` entries may be workspace paths or folder ids. */
export function projectsReorderWorkspaces(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
  orderedKeys: string[],
): void {
  ctx.deps.projectManager.reorderWorkspaces(projectId, orderedKeys);
}

export function projectsReorder(
  ctx: HandlerCtx<ServerDeps>,
  orderedIds: string[],
): void {
  ctx.deps.projectManager.reorderProjects(orderedIds);
}

/**
 * Link two projects on different hosts into one group, or take one
 * out of its group. A project leaving keeps the group's shared settings;
 * nothing else about it changes.
 */
export function projectsLink(
  ctx: HandlerCtx<ServerDeps>,
  projectId: string,
  otherId: string,
): ReturnType<ServerDeps["projectManager"]["linkProjects"]> {
  assertString(projectId, "projectId");
  assertString(otherId, "otherId");
  return ctx.deps.projectManager.linkProjects(projectId, otherId);
}

export function projectsUnlink(
  ctx: HandlerCtx<ServerDeps>,
  projectId: string,
): void {
  assertString(projectId, "projectId");
  ctx.deps.projectManager.unlinkProject(projectId);
}

export function projectsUnlinkGroup(
  ctx: HandlerCtx<ServerDeps>,
  groupId: string,
): void {
  assertString(groupId, "groupId");
  ctx.deps.projectManager.unlinkGroup(groupId);
}

/** Set a group's shared settings. Returns every member. */
export function projectsUpdateGroup(
  ctx: HandlerCtx<ServerDeps>,
  groupId: unknown,
  updates: unknown,
): ReturnType<ServerDeps["projectManager"]["updateGroup"]> {
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

/** The host the New Workspace picker starts on next time. */
export function projectsSetGroupLastUsedHost(
  ctx: HandlerCtx<ServerDeps>,
  groupId: string,
  hostId: string,
): void {
  assertString(groupId, "groupId");
  assertString(hostId, "hostId");
  ctx.deps.projectManager.setGroupLastUsedHost(groupId, hostId);
}

/**
 * Projects on other hosts with the same `origin`, to offer
 * as links after an add or clone. Suggests only; never links.
 */
export function projectsSuggestLinks(
  ctx: HandlerCtx<ServerDeps>,
  projectId: string,
): ReturnType<ServerDeps["projectManager"]["suggestLinks"]> {
  assertString(projectId, "projectId");
  return ctx.deps.projectManager.suggestLinks(projectId);
}

export function projectsDismissLinkSuggestion(
  ctx: HandlerCtx<ServerDeps>,
  projectId: string,
  otherId: string,
): void {
  assertString(projectId, "projectId");
  assertString(otherId, "otherId");
  ctx.deps.projectManager.dismissLinkSuggestion(projectId, otherId);
}

/**
 * Join every same-origin pair of projects on different hosts, as
 * `suggestLinks` would offer them, without asking. Returns the pairs
 * joined, for the renderer's Undo toast.
 */
export function projectsAutoJoin(
  ctx: HandlerCtx<ServerDeps>,
): ReturnType<ServerDeps["projectManager"]["autoJoin"]> {
  return ctx.deps.projectManager.autoJoin();
}

/**
 * "Keep separate…": split the project's group and remember every
 * pair it split, so `autoJoin` leaves them apart.
 */
export function projectsKeepSeparate(
  ctx: HandlerCtx<ServerDeps>,
  projectId: string,
): void {
  assertString(projectId, "projectId");
  ctx.deps.projectManager.keepSeparate(projectId);
}

/**
 * Undo one `autoJoin` pair for good: unlink the newcomer, give
 * back its own settings, and dismiss the pair.
 */
export function projectsUndoAutoJoin(
  ctx: HandlerCtx<ServerDeps>,
  joinedId: string,
  intoId: string,
): void {
  assertString(joinedId, "joinedId");
  assertString(intoId, "intoId");
  ctx.deps.projectManager.undoAutoJoin(joinedId, intoId);
}

export function projectsUpdate(
  ctx: HandlerCtx<SharedDeps>,
  projectId: string,
  updates: ProjectUpdatableFields,
): Promise<ProjectInfo | null> {
  return ctx.deps.projectManager.updateProject(projectId, updates);
}

export const projects = {
  // The merged list: this desktop's projects and every adopted
  // host's, in the sidebar's order, under the desktop's groups.
  getAll: method(projectsGetAll, { route: LOCAL_ROUTE }),
  getSelectedIndex: method(projectsGetSelectedIndex, { route: LOCAL_ROUTE }),
  select: method(projectsSelect, { mutating: true, route: LOCAL_ROUTE }),
  // The selection is the desktop's; a remote project's workspace index is
  // written through to its host by `ProjectManager`.
  selectWorkspace: method(projectsSelectWorkspace, { mutating: true, route: LOCAL_ROUTE }),
  // A path on this machine.
  add: method(projectsAdd, { mutating: true, route: LOCAL_ROUTE }),
  // Groups and the sidebar's order forget it here, its host forgets it there.
  remove: method(projectsRemove, { mutating: true, route: LOCAL_ROUTE }),
  removeWorktree: method(projectsRemoveWorktree, { mutating: true, route: byProject(0) }),
  // `canQuickMerge` and the two branch listings read.
  canQuickMerge: method(projectsCanQuickMerge, { route: byProject(0) }),
  quickMergeWorktree: method(projectsQuickMergeWorktree, {
    mutating: true,
    route: byProject(0),
  }),
  createWorktree: method(projectsCreateWorktree, { mutating: true, route: byProject(0) }),
  runStartScript: method(projectsRunStartScript, { mutating: true, route: byProject(0) }),
  convertMainToWorktree: method(projectsConvertMainToWorktree, {
    mutating: true,
    route: byProject(0),
  }),
  listRemoteBranches: method(projectsListRemoteBranches, { route: byProject(0) }),
  listLocalBranches: method(projectsListLocalBranches, { route: byProject(0) }),
  renameWorkspace: method(projectsRenameWorkspace, { mutating: true, route: byProject(0) }),
  setWorkspaceHidden: method(projectsSetWorkspaceHidden, {
    mutating: true,
    route: byProject(0),
  }),
  createWorkspaceFolder: method(projectsCreateWorkspaceFolder, {
    mutating: true,
    route: byProject(0),
  }),
  setFolderParent: method(projectsSetFolderParent, { mutating: true, route: byProject(0) }),
  renameWorkspaceFolder: method(projectsRenameWorkspaceFolder, {
    mutating: true,
    route: byProject(0),
  }),
  deleteWorkspaceFolder: method(projectsDeleteWorkspaceFolder, {
    mutating: true,
    route: byProject(0),
  }),
  setWorkspaceFolder: method(projectsSetWorkspaceFolder, {
    mutating: true,
    route: byProject(0),
  }),
  reorderWorkspaces: method(projectsReorderWorkspaces, {
    mutating: true,
    route: byProject(0),
  }),
  reorder: method(projectsReorder, { mutating: true, route: LOCAL_ROUTE }),
  // A grouped project's shared settings are the group's, which only the
  // desktop has; `ProjectManager` writes its own ones to its host.
  update: method(projectsUpdate, { mutating: true, route: LOCAL_ROUTE }),
  getRemote: method(projectsGetRemote, { route: LOCAL_ROUTE }),
  // Main's remote-host project lifecycle. `clone`'s
  // progress is the `projects.cloneProgress` broadcast. Each of these moves
  // a project, a group, or what the sidebar shows. A clone onto an adopted
  // host, and a move to or from one, reach its server through
  // `ProjectManager`.
  clone: method(projectsClone, { mutating: true, route: LOCAL_ROUTE }),
  moveToHost: method(projectsMoveToHost, { mutating: true, route: LOCAL_ROUTE }),
  transfer: method(projectsTransfer, { mutating: true, route: LOCAL_ROUTE }),
  // Runs a recipe on this machine to start a box:
  // the desktop user's call alone, like `hosts.addRecipeHost`.
  openInNewHost: method(projectsOpenInNewHost, {
    localOnly: true,
    mutating: true,
    route: LOCAL_ROUTE,
  }),
  // Read with the project's host's git, over its daemon, wherever it lives.
  getOriginUrl: method(projectsGetOriginUrl, { route: LOCAL_ROUTE }),
  pathExists: method(projectsPathExists, { route: LOCAL_ROUTE }),
  switchHost: method(projectsSwitchHost, { mutating: true, route: LOCAL_ROUTE }),
  // Linked project groups — the desktop's alone.
  link: method(projectsLink, { mutating: true, route: LOCAL_ROUTE }),
  unlink: method(projectsUnlink, { mutating: true, route: LOCAL_ROUTE }),
  unlinkGroup: method(projectsUnlinkGroup, { mutating: true, route: LOCAL_ROUTE }),
  updateGroup: method(projectsUpdateGroup, { mutating: true, route: LOCAL_ROUTE }),
  setGroupLastUsedHost: method(projectsSetGroupLastUsedHost, {
    mutating: true,
    route: LOCAL_ROUTE,
  }),
  suggestLinks: method(projectsSuggestLinks, { route: LOCAL_ROUTE }),
  dismissLinkSuggestion: method(projectsDismissLinkSuggestion, {
    mutating: true,
    route: LOCAL_ROUTE,
  }),
  // Same-origin projects join on their own; "Keep separate…".
  autoJoin: method(projectsAutoJoin, { mutating: true, route: LOCAL_ROUTE }),
  keepSeparate: method(projectsKeepSeparate, { mutating: true, route: LOCAL_ROUTE }),
  undoAutoJoin: method(projectsUndoAutoJoin, { mutating: true, route: LOCAL_ROUTE }),
};
