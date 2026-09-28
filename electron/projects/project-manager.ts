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
import type { ProjectContext } from "./context";
import { HostRecords } from "./host-records";
import { moveProjectToHost, planRemoteClone, runRemoteClone, switchProjectHost } from "./host-move";
import { PathRouter } from "./path-router";
import * as groups from "./project-groups";
import { buildProjectInfo, listGitWorkspaces, seedCommands } from "./project-info";
import { StateStore } from "./state-store";
import * as folders from "./workspace-folders";
import * as worktrees from "./worktrees";
import type {
  GroupUpdatableFields,
  IssueSeed,
  LinkedIssue,
  PersistedProject,
  ProjectGroupInfo,
  ProjectHostResolver,
  ProjectInfo,
  ProjectUpdatableFields,
  WorkspaceFolder,
  WorkspaceFromIssue,
} from "./types";

export class ProjectManager {
  private readonly store: StateStore;
  private readonly hosts: HostRecords;
  private readonly paths: PathRouter;
  private readonly ctx: ProjectContext;
  private readonly hostFor: ProjectHostResolver;
  private resyncDone = false;

  /**
   * `hosts` resolves a host id to its backend — `BackendRegistry.get` in
   * the app. A bare `GitBackend` is this machine's git for every project,
   * with this machine's shell and facts (local-only callers and tests).
   */
  constructor(hosts: ProjectHostResolver | GitBackend, dataDir?: string) {
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
    };
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

  /** Throws unless `hostId` is a registered remote host (ADR-183). */
  assertRemoteHost(hostId: string): void {
    this.hosts.assertRemote(hostId);
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

  // ── Projects ──

  async getProjects(): Promise<ProjectInfo[]> {
    if (!this.resyncDone) {
      this.resyncDone = true;
      await resyncDefaultBranches(this.ctx);
      this.paths.warm();
    }
    return Promise.all(this.store.state.projects.map((p) => this.buildProjectInfo(p)));
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
   * Create a project on a remote host by cloning it there first (ADR-178
   * ticket 5), with progress on `projects:clone-progress` (ADR-183 ticket
   * 1), then the normal `addProject` path.
   *
   * If `remoteDir` already exists and is a clone of `repoUrl`, cloning is
   * skipped and the existing checkout is adopted instead of clobbered. Any
   * other non-empty directory is refused. A checkout Manor already has a
   * project for returns that project rather than a second record for the
   * same host+path (ADR-178 ticket 5 review).
   */
  async addRemoteProject(opts: {
    hostId: string;
    repoUrl: string;
    remoteDir: string;
    name: string;
  }): Promise<ProjectInfo> {
    this.hosts.assertRemote(opts.hostId);
    const plan = await planRemoteClone(this.ctx, opts.hostId, opts);
    await runRemoteClone(plan);
    if (plan.owner) return this.buildProjectInfo(plan.owner);
    return this.addProject(opts.name, plan.targetDir, opts.hostId);
  }

  /** See `host-move.ts`. */
  moveProjectToHost(
    projectId: string,
    opts: { hostId: string; repoUrl: string; remoteDir: string },
  ): Promise<ProjectInfo> {
    return moveProjectToHost(this.ctx, projectId, opts);
  }

  /** See `host-move.ts`. The caller connects a remote host first. */
  switchProjectHost(
    projectId: string,
    hostId: string,
    explicitPath?: string,
  ): Promise<ProjectInfo> {
    return switchProjectHost(this.ctx, projectId, hostId, explicitPath);
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

  removeProject(projectId: string): void {
    const state = this.store.state;
    groups.forgetProject(state, projectId);
    state.projects = state.projects.filter((p) => p.id !== projectId);
    if (state.selectedProjectIndex >= state.projects.length) {
      state.selectedProjectIndex = Math.max(0, state.projects.length - 1);
    }
    this.store.save();
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
    return groups.linkProjects(this.ctx, projectId, otherId);
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
    groups.unlinkProject(this.ctx, projectId);
  }

  /** Dissolve a group; every member keeps the shared settings, just unlinked. */
  unlinkGroup(groupId: string): void {
    groups.unlinkGroup(this.ctx, groupId);
  }

  /** Remember the host a group last made a workspace on (New Workspace picker). */
  setGroupLastUsedHost(groupId: string, hostId: string): void {
    groups.setGroupLastUsedHost(this.ctx, groupId, hostId);
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
    branch?: string,
    linkedIssue?: LinkedIssue,
    baseBranch?: string,
    useExistingBranch?: boolean,
  ): Promise<ProjectInfo | null> {
    return worktrees.createWorktree(
      this.ctx,
      projectId,
      name,
      branch,
      linkedIssue,
      baseBranch,
      useExistingBranch,
    );
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
