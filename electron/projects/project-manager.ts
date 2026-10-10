/**
 * `ProjectManager`: the facade over `projects.json` that IPC, the control
 * routes and MCP talk to. It owns the state and composes the modules beside
 * it — each operation lives in the module for its job (ADR-183).
 */

import crypto from "node:crypto";

import { ExecShellBackend } from "../backend/exec-shell";
import { localFacts } from "../backend/machine-facts";
import { LOCAL_HOST_ID, type GitBackend, type HostSpec } from "../backend/types";
import { splitShared } from "../../src/lib/project-groups";
import { manorDataDir } from "../paths";
import type { HostPath } from "../per-host-poller";
import { detectDefaultBranch, listLocalBranches, listRemoteBranches, resyncDefaultBranches } from "./branches";
import type { ProjectContext, WorkspaceLayoutOwner } from "./context";
import { HostRecords } from "./host-records";
import { OriginLinks, forgetLinkDismissals } from "./origin-links";
import { moveProjectToHost, planClone, runClone, switchProjectHost } from "./host-move";
import { planTransfer, transferProject, type TransferDeps } from "./host-transfer";
import { PathRouter } from "./path-router";
import { workspaceKey, type WorkspaceKeyOwner } from "../../src/lib/workspace-key";
import * as groups from "./project-groups";
import {
  buildProjectInfo,
  listGitWorkspaces,
  seedCommands,
  LastKnownWorkspaces,
} from "./project-info";
import { StateStore } from "./state-store";
import * as folders from "./workspace-folders";
import * as worktrees from "./worktrees";
import type {
  CreateWorktreeOptions,
  GroupUpdatableFields,
  IssueSeed,
  LinkedIssue,
  LinkSuggestion,
  PersistedProject,
  ProjectGroupInfo,
  ProjectHostResolver,
  ProjectInfo,
  ProjectUpdatableFields,
  TransferMode,
  TransferPlan,
  TransferResult,
  WorkspaceFolder,
  WorkspaceFromIssue,
} from "./types";

export class ProjectManager {
  private readonly store: StateStore;
  private readonly hosts: HostRecords;
  private readonly paths: PathRouter;
  private readonly ctx: ProjectContext;
  private readonly origins: OriginLinks;
  private readonly hostFor: ProjectHostResolver;
  private resyncDone = false;
  /** Remote projects' last workspace listings, for while a host is away. */
  private readonly lastKnownWorkspaces: LastKnownWorkspaces;

  /**
   * `hosts` resolves a host id to its backend — `BackendRegistry.get` in
   * the app. A bare `GitBackend` is this machine's git for every project,
   * with this machine's shell and facts (local-only callers and tests).
   *
   * `isHostAway` says whether a host is not connected now — in the app,
   * `BackendRegistry.status(hostId) !== "connected"`. Only while it is does
   * a remote project fall back to its last workspace listing. Without it,
   * no host is ever away.
   */
  constructor(
    hosts: ProjectHostResolver | GitBackend,
    dataDir?: string,
    options: {
      isHostAway?: (hostId: string) => boolean;
      /**
       * The server's layout store, as far as removing a worktree or a
       * project needs it (ADR-182 D7). Optional so a test about projects
       * alone need not build one.
       */
      layout?: WorkspaceLayoutOwner;
    } = {},
  ) {
    this.lastKnownWorkspaces = new LastKnownWorkspaces(options.isHostAway ?? (() => false));
    if (typeof hosts === "function") {
      this.hostFor = hosts;
    } else {
      const local = { git: hosts, shell: new ExecShellBackend(), facts: localFacts() };
      this.hostFor = () => local;
    }
    this.store = new StateStore(dataDir ?? manorDataDir());
    this.hosts = new HostRecords(this.store);
    this.paths = new PathRouter(
      () => this.store.state.projects,
      (hostId) => this.hostFor(hostId).facts,
    );
    this.ctx = {
      store: this.store,
      hosts: this.hosts,
      paths: this.paths,
      host: (hostId) => this.hostFor(hostId),
      find: (projectId) => this.findProject(projectId),
      findAt: (hostId, dir) =>
        this.store.state.projects.find((p) => p.path === dir && p.hostId === hostId),
      info: (project) => this.buildProjectInfo(project),
      layout: options.layout,
    };
    this.origins = new OriginLinks(this.ctx);
  }

  private findProject(projectId: string): PersistedProject | undefined {
    return this.store.state.projects.find((p) => p.id === projectId);
  }

  private buildProjectInfo(p: PersistedProject): Promise<ProjectInfo> {
    return buildProjectInfo(
      p,
      this.hostFor(p.hostId).git,
      this.paths,
      groups.groupOf(this.store.state, p.id),
      this.lastKnownWorkspaces,
    );
  }

  // ── Hosts ──

  /** Registered remote hosts, in the order they were added. */
  getHosts(): Array<{ hostId: string; spec: HostSpec }> {
    return this.hosts.list();
  }

  /** Add a remote host, or replace how an existing one is reached. */
  saveHost(hostId: string, spec: HostSpec): void {
    this.hosts.save(hostId, spec);
    // A new address may be a different machine: re-ask its home.
    this.paths.forgetHost(hostId);
  }

  /** How `hostId` is named to people: its ssh target, or "this Mac". */
  hostLabel(hostId: string): string {
    return this.hosts.label(hostId);
  }

  /** Throws unless `hostId` is this machine or a registered host. */
  assertKnownHost(hostId: string): void {
    this.hosts.assertKnown(hostId);
  }

  getHostHookCursor(hostId: string): { seq: number; epoch: string | null } | null {
    return this.hosts.hookCursor(hostId);
  }

  /** Debounced; see `HostRecords.setHookCursor`. */
  setHostHookCursor(hostId: string, cursor: { seq: number; epoch: string | null }): void {
    this.hosts.setHookCursor(hostId, cursor);
  }

  /** Write a pending `setHostHookCursor` now. */
  flushHostHookSeqs(): void {
    this.hosts.flushHookCursors();
  }

  /** Remote hosts at least one project lives on. */
  remoteHostIdsInUse(): string[] {
    const ids = new Set<string>();
    for (const project of this.store.state.projects) {
      if (project.hostId !== LOCAL_HOST_ID) ids.add(project.hostId);
    }
    return Array.from(ids);
  }

  /** Paths of the projects that live on this machine. */
  localProjectPaths(): string[] {
    return this.store.state.projects
      .filter((p) => p.hostId === LOCAL_HOST_ID)
      .map((p) => p.path);
  }

  /** The projects that live on a remote host, each path with its host. */
  remoteProjectHostPaths(): HostPath[] {
    return this.store.state.projects
      .filter((p) => p.hostId !== LOCAL_HOST_ID)
      .map((p) => ({ path: p.path, hostId: p.hostId }));
  }

  /** Run `listener` after every write of `projects.json` — any project mutation. */
  onStateSaved(listener: () => void): void {
    this.store.onSave(listener);
  }

  /** The host a project lives on; `"local"` for unknown projects. */
  getProjectHostId(projectId: string | null | undefined): string {
    if (!projectId) return LOCAL_HOST_ID;
    return this.findProject(projectId)?.hostId ?? LOCAL_HOST_ID;
  }

  /** The host a bare filesystem path belongs to (see `PathRouter`). */
  hostIdForPath(p: string): string {
    return this.paths.hostIdForPath(p);
  }

  /**
   * Every project as a workspace-key owner, for migrating path-keyed data
   * (see `PathRouter.workspaceKeyOwners`), each project's workspaces listed
   * by its host's git. Null when a remote host did not answer in time. Asks
   * no host when every project is local: then every path is local anyway.
   */
  async workspaceKeyOwners(timeoutMs: number): Promise<WorkspaceKeyOwner[] | null> {
    if (this.remoteHostIdsInUse().length === 0) return [];
    return this.paths.workspaceKeyOwners(timeoutMs, async (project) =>
      (await this.hostFor(project.hostId).git.worktreeList(project.path)).map((wt) => wt.path),
    );
  }

  // ── Projects ──

  async getProjects(): Promise<ProjectInfo[]> {
    if (!this.resyncDone) {
      this.resyncDone = true;
      await resyncDefaultBranches(this.ctx);
      this.paths.warm();
    }
    return Promise.all(this.store.state.projects.map((p) => this.buildProjectInfo(p)));
  }

  /**
   * Only the projects on remote hosts, their worktrees listed afresh. Local
   * projects' worktrees are kept current by `WorktreeWatcher`, so a refresh
   * that only needs what no watcher sees (a window focus) skips them.
   */
  async getRemoteProjects(): Promise<ProjectInfo[]> {
    return Promise.all(
      this.store.state.projects
        .filter((p) => p.hostId !== LOCAL_HOST_ID)
        .map((p) => this.buildProjectInfo(p)),
    );
  }

  getSelectedProjectIndex(): number {
    return this.store.state.selectedProjectIndex;
  }

  selectProject(index: number): void {
    this.store.state.selectedProjectIndex = index;
    this.store.save();
  }

  /** Re-detect every project's default branch without the network. */
  resyncDefaultBranches(): Promise<void> {
    return resyncDefaultBranches(this.ctx);
  }

  /** `hostId` names the host `projectPath` lives on; omitted, this machine. */
  async addProject(
    name: string,
    projectPath: string,
    hostId: string = LOCAL_HOST_ID,
  ): Promise<ProjectInfo> {
    const host = this.hostFor(hostId);
    const detected = await detectDefaultBranch(host.git, projectPath);
    const project: PersistedProject = {
      id: crypto.randomUUID(),
      name,
      path: projectPath,
      selectedWorkspaceIndex: 0,
      workspaces: [],
      defaultBranch: detected ?? "main",
      defaultRunCommand: null,
      worktreePath: null,
      worktreeStartScript: null,
      worktreeTeardownScript: null,
      color: null,
      agentCommand: null,
      commands: await seedCommands(host.facts, projectPath),
      themeName: null,
      setupComplete: false,
      portlessEnabled: true,
      hostId,
    };

    this.store.state.projects.push(project);
    this.store.state.selectedProjectIndex = this.store.state.projects.length - 1;
    this.store.save();

    const workspaces = (await listGitWorkspaces(host.git, projectPath)) ?? [
      { path: projectPath, branch: "main", isMain: true, name: null },
    ];

    return {
      id: project.id,
      name,
      path: projectPath,
      defaultBranch: project.defaultBranch,
      workspaces,
      selectedWorkspaceIndex: 0,
      defaultRunCommand: null,
      worktreePath: null,
      worktreeStartScript: null,
      worktreeTeardownScript: null,
      linearAssociations: [],
      color: null,
      agentCommand: null,
      commands: project.commands ?? [],
      themeName: null,
      setupComplete: false,
      portlessEnabled: true,
      hostId,
      folders: [],
      sidebarOrder: [],
      group: null,
    };
  }

  /**
   * Create a project on any host, this machine included, by cloning it
   * there first (ADR-178 ticket 5, ADR-194), with progress on `projects:clone-progress` (ADR-183 ticket
   * 1), then the normal `addProject` path.
   *
   * If `targetDir` already exists and is a clone of `repoUrl`, cloning is
   * skipped and the existing checkout is adopted instead of clobbered. Any
   * other non-empty directory is refused. A checkout Manor already has a
   * project for returns that project rather than a second record for the
   * same host+path (ADR-178 ticket 5 review).
   */
  async cloneProject(opts: {
    hostId: string;
    repoUrl: string;
    targetDir: string;
    name: string;
  }): Promise<ProjectInfo> {
    this.hosts.assertKnown(opts.hostId);
    const plan = await planClone(this.ctx, opts.hostId, opts);
    await runClone(plan);
    if (plan.owner) return this.buildProjectInfo(plan.owner);
    return this.addProject(opts.name, plan.targetDir, opts.hostId);
  }

  /** See `host-move.ts`. */
  moveProjectToHost(
    projectId: string,
    opts: { hostId: string; repoUrl: string; remoteDir: string },
  ): Promise<ProjectInfo> {
    this.lastKnownWorkspaces.forget(projectId);
    return moveProjectToHost(this.ctx, projectId, opts);
  }

  /** See `host-move.ts`. The caller connects a remote host first. */
  switchProjectHost(
    projectId: string,
    hostId: string,
    explicitPath?: string,
  ): Promise<ProjectInfo> {
    this.lastKnownWorkspaces.forget(projectId);
    return switchProjectHost(this.ctx, projectId, hostId, explicitPath);
  }

  /** What `host-transfer.ts` composes: this manager's own operations. */
  private transferDeps(): TransferDeps {
    return {
      originKeyOf: (project) => this.origins.keyOf(project),
      originUrl: (projectId) => this.getOriginUrl(projectId),
      cloneProject: (opts) => this.cloneProject(opts),
      linkProjects: (projectId, otherId) => this.linkProjects(projectId, otherId),
      removeProject: (projectId) => this.removeProject(projectId),
      moveProjectToHost: (projectId, opts) => this.moveProjectToHost(projectId, opts),
      switchProjectHost: (projectId, hostId, path) =>
        this.switchProjectHost(projectId, hostId, path),
    };
  }

  /** See `host-transfer.ts` (ADR-213). Changes nothing. */
  planTransfer(projectId: string, hostId: string): Promise<TransferPlan> {
    return planTransfer(this.ctx, this.transferDeps(), projectId, hostId);
  }

  /**
   * Copy or move a project onto a host in one call (ADR-213); see
   * `host-transfer.ts`. A move forgets the project's last workspace
   * listing through `moveProjectToHost`/`switchProjectHost`. The caller
   * connects a remote host first.
   */
  transferProject(
    projectId: string,
    hostId: string,
    mode: TransferMode,
    overrides?: { repoUrl: string; targetDir: string },
  ): Promise<TransferResult> {
    return transferProject(this.ctx, this.transferDeps(), projectId, hostId, mode, overrides);
  }

  /**
   * The project's `origin` URL, as its current host's git reports it, or
   * null on any failure. Pre-fills the repo URL when moving it to a host.
   */
  async getOriginUrl(projectId: string): Promise<string | null> {
    const project = this.findProject(projectId);
    if (!project) return null;
    try {
      const out = await this.hostFor(project.hostId).git.exec(project.path, [
        "remote",
        "get-url",
        "origin",
      ]);
      const url = out.trim();
      return url === "" ? null : url;
    } catch {
      return null;
    }
  }

  /** Whether the project's `path` exists on the host it lives on. */
  async projectPathExists(projectId: string): Promise<boolean> {
    const project = this.findProject(projectId);
    if (!project) return false;
    return this.pathExistsOnHost(project.hostId, project.path);
  }

  /** Whether `p` exists on `hostId`'s filesystem. */
  pathExistsOnHost(hostId: string, p: string): Promise<boolean> {
    return this.hostFor(hostId).facts.exists(p);
  }

  /**
   * Forget a project, and tear down the layout of every one of its
   * workspaces the same way `removeWorktree` does: their panes end and every
   * renderer drops them (ADR-182 D7). The directories stay; only Manor lets
   * go of them.
   *
   * The project leaves the list before the first `await`, so a caller that
   * does not wait still sees it gone.
   */
  async removeProject(projectId: string): Promise<void> {
    const project = this.findProject(projectId);
    const known = project ? this.lastKnownWorkspaces.recall(project) : undefined;
    const state = this.store.state;
    const groupId = groups.groupOf(state, projectId)?.id;
    groups.forgetProject(state, projectId);
    forgetLinkDismissals(state, projectId);
    this.lastKnownWorkspaces.forget(projectId);
    state.projects = state.projects.filter((p) => p.id !== projectId);
    if (state.selectedProjectIndex >= state.projects.length) {
      state.selectedProjectIndex = Math.max(0, state.projects.length - 1);
    }
    this.store.save();
    if (groupId) void this.origins.rememberGroupOrigin(groupId);
    const layout = this.ctx.layout;
    if (!project || !layout) return;

    let paths: string[] = known?.map((ws) => ws.path) ?? [];
    try {
      paths = (await this.buildProjectInfo(project)).workspaces.map((ws) => ws.path);
    } catch {
      // Host away: the last listing it had is the best there is.
    }
    for (const path of new Set([project.path, ...paths])) {
      layout.remove(workspaceKey(project.hostId, path));
    }
  }

  /**
   * A `~` worktree root is stored as written and expanded only when read,
   * so it keeps meaning "home" on whichever host the project moves to
   * (ADR-183) — and saving one never asks the host anything.
   *
   * For a grouped project the shared settings (name, color, agent command,
   * Linear) are the group's, so those go to the group (ADR-192).
   */
  async updateProject(
    projectId: string,
    updates: ProjectUpdatableFields,
  ): Promise<ProjectInfo | null> {
    const project = this.findProject(projectId);
    if (!project) return null;
    const group = groups.groupOf(this.store.state, projectId);
    const { shared, own } = group
      ? splitShared(updates)
      : { shared: {}, own: updates };
    Object.assign(project, own);
    if (group && Object.keys(shared).length > 0) {
      // Saves the project's own changes too.
      groups.updateGroup(this.ctx, group.id, shared);
    } else {
      this.store.save();
    }
    return this.buildProjectInfo(project);
  }

  reorderProjects(orderedIds: string[]): void {
    const state = this.store.state;
    const byId = new Map(state.projects.map((p) => [p.id, p]));
    const reordered = orderedIds
      .map((id) => byId.get(id))
      .filter((p): p is PersistedProject => p != null);
    // Append any projects not in orderedIds (shouldn't happen, but safe)
    const orderedSet = new Set(orderedIds);
    for (const p of state.projects) {
      if (!orderedSet.has(p.id)) reordered.push(p);
    }
    const selectedId = state.projects[state.selectedProjectIndex]?.id;
    state.projects = reordered;
    if (selectedId) {
      const newIdx = reordered.findIndex((p) => p.id === selectedId);
      if (newIdx >= 0) state.selectedProjectIndex = newIdx;
    }
    this.store.save();
  }

  // ── Linked-project groups (see `project-groups.ts`, ADR-192) ──

  /**
   * Link two projects on different hosts: `projectId` joins `otherId`'s
   * group, `otherId` joins `projectId`'s, or a new group starts. Throws on
   * a second member for one host.
   */
  linkProjects(projectId: string, otherId: string): ProjectGroupInfo {
    const group = groups.linkProjects(this.ctx, projectId, otherId);
    // Record the group's `origin` once a member's host reports it (ticket 5).
    void this.origins.rememberGroupOrigin(group.id);
    return group;
  }

  /**
   * Set a group's shared settings (name, color, agent command, Linear).
   * Returns every member as the renderer now sees it. Throws on an unknown
   * group.
   */
  async updateGroup(groupId: string, updates: GroupUpdatableFields): Promise<ProjectInfo[]> {
    const group = groups.updateGroup(this.ctx, groupId, updates);
    return Promise.all(
      group.memberIds
        .map((id) => this.findProject(id))
        .filter((p): p is PersistedProject => p != null)
        .map((p) => this.buildProjectInfo(p)),
    );
  }

  /**
   * Take a project out of its group. It keeps the group's shared settings
   * as its own; its workspaces and other settings stay.
   */
  unlinkProject(projectId: string): void {
    const groupId = groups.groupOf(this.store.state, projectId)?.id;
    groups.unlinkProject(this.ctx, projectId);
    // The group's origin key is derived again from the members left.
    if (groupId) void this.origins.rememberGroupOrigin(groupId);
  }

  /** Dissolve a group; every member keeps the shared settings, just unlinked. */
  unlinkGroup(groupId: string): void {
    groups.unlinkGroup(this.ctx, groupId);
  }

  /** Remember the host a group last made a workspace on (New Workspace picker). */
  setGroupLastUsedHost(groupId: string, hostId: string): void {
    groups.setGroupLastUsedHost(this.ctx, groupId, hostId);
  }

  // ── Link suggestions by `origin` (see `origin-links.ts`, ADR-192 ticket 5) ──

  /**
   * Projects and groups on other hosts whose `origin` matches `projectId`'s,
   * minus dismissed ones. Only candidates: nothing is linked.
   */
  suggestLinks(projectId: string): Promise<LinkSuggestion[]> {
    return this.origins.suggest(projectId);
  }

  /** Stop suggesting `projectId` be linked with `otherId` (or its group). */
  dismissLinkSuggestion(projectId: string, otherId: string): void {
    this.origins.dismiss(projectId, otherId);
  }

  // ── Workspaces and folders (see `workspace-folders.ts`) ──

  selectWorkspace(projectId: string, workspaceIndex: number): void {
    const project = this.findProject(projectId);
    if (!project) return;
    project.selectedWorkspaceIndex = workspaceIndex;
    const projectIndex = this.store.state.projects.indexOf(project);
    if (projectIndex >= 0) this.store.state.selectedProjectIndex = projectIndex;
    this.store.save();
  }

  renameWorkspace(projectId: string, workspacePath: string, newName: string): void {
    folders.renameWorkspace(this.ctx, projectId, workspacePath, newName);
  }

  setWorkspaceHidden(projectId: string, workspacePath: string, hidden: boolean): void {
    folders.setWorkspaceHidden(this.ctx, projectId, workspacePath, hidden);
  }

  createWorkspaceFolder(
    projectId: string,
    name: string,
    parentId?: string | null,
  ): WorkspaceFolder | null {
    return folders.createWorkspaceFolder(this.ctx, projectId, name, parentId);
  }

  renameWorkspaceFolder(projectId: string, folderId: string, name: string): void {
    folders.renameWorkspaceFolder(this.ctx, projectId, folderId, name);
  }

  setFolderParent(projectId: string, folderId: string, parentId: string | null): boolean {
    return folders.setFolderParent(this.ctx, projectId, folderId, parentId);
  }

  deleteWorkspaceFolder(projectId: string, folderId: string): void {
    folders.deleteWorkspaceFolder(this.ctx, projectId, folderId);
  }

  setWorkspaceFolder(projectId: string, workspacePath: string, folderId: string | null): void {
    folders.setWorkspaceFolder(this.ctx, projectId, workspacePath, folderId);
  }

  reorderWorkspaces(projectId: string, orderedKeys: string[]): void {
    folders.reorderWorkspaces(this.ctx, projectId, orderedKeys);
  }

  linkIssueToWorkspace(projectId: string, workspacePath: string, issue: LinkedIssue): void {
    folders.linkIssueToWorkspace(this.ctx, projectId, workspacePath, issue);
  }

  unlinkIssueFromWorkspace(projectId: string, workspacePath: string, issueId: string): void {
    folders.unlinkIssueFromWorkspace(this.ctx, projectId, workspacePath, issueId);
  }

  getWorkspaceIssues(projectId: string, workspacePath: string): LinkedIssue[] {
    return this.findProject(projectId)?.workspaceIssues?.[workspacePath] ?? [];
  }

  // ── Worktrees and branches (see `worktrees.ts`, `branches.ts`) ──

  removeWorktree(
    projectId: string,
    worktreePath: string,
    deleteBranch?: boolean,
    onProgress?: (step: string) => void,
  ): Promise<void> {
    return worktrees.removeWorktree(this.ctx, projectId, worktreePath, deleteBranch, onProgress);
  }

  canQuickMerge(
    projectId: string,
    worktreePath: string,
  ): Promise<{ canMerge: boolean; reason?: string }> {
    return worktrees.canQuickMerge(this.ctx, projectId, worktreePath);
  }

  quickMergeWorktree(projectId: string, worktreePath: string): Promise<void> {
    return worktrees.quickMergeWorktree(this.ctx, projectId, worktreePath);
  }

  createWorkspacesFromIssues(
    projectId: string,
    issues: IssueSeed[],
    baseBranch?: string,
  ): Promise<WorkspaceFromIssue[]> {
    return worktrees.createWorkspacesFromIssues(
      this.ctx,
      projectId,
      issues,
      baseBranch,
      (...args) => this.createWorktree(...args),
    );
  }

  createWorktree(
    projectId: string,
    name: string,
    opts: CreateWorktreeOptions = {},
  ): Promise<ProjectInfo | null> {
    return worktrees.createWorktree(this.ctx, projectId, name, opts);
  }

  convertMainToWorktree(projectId: string, name: string): Promise<ProjectInfo | null> {
    return worktrees.convertMainToWorktree(this.ctx, projectId, name);
  }

  listLocalBranches(projectId: string): Promise<string[]> {
    return listLocalBranches(this.ctx, projectId);
  }

  listRemoteBranches(projectId: string): Promise<string[]> {
    return listRemoteBranches(this.ctx, projectId);
  }
}
