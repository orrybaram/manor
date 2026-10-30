/**
 * `ProjectManager`: the facade over `projects.json` that IPC, the control
 * routes and MCP talk to. It owns the state and composes the modules beside
 * it — each operation lives in the module for its job.
 *
 * **On the desktop it holds this machine's projects only**, and
 * a remote host's until that host has adopted them. An adopted host's
 * projects are its server's: they come in through `RemoteProjects` (each
 * host's `HostProxy`) and are merged into what `getProjects` answers, under
 * the desktop's linked-project groups — which only the desktop has, since
 * linking spans hosts. A group's shared settings are written through to
 * each remote member's host. Workspace writes for a remote project never
 * reach here: the bridge forwards them to its host (`BridgeForward`).
 */

import type { PaneEnding } from "../layout/layout-store";
import crypto from "node:crypto";

import { ExecShellBackend } from "../backend/exec-shell";
import { localFacts } from "../backend/machine-facts";
import { LOCAL_HOST_ID, type GitBackend, type HostSpec } from "../backend/types";
import type { ManifestProject } from "../host-server/manifest";
import { splitShared } from "../../src/lib/project-groups";
import { manorDataDir } from "../paths";
import { detectDefaultBranch, listLocalBranches, listRemoteBranches, resyncDefaultBranches } from "./branches";
import type { ProjectContext, WorkspaceLayoutOwner } from "./context";
import { mergeAdoptedProject } from "./adopt-records";
import { moveAcrossServers } from "./host-move";
import { HostRecords } from "./host-records";
import { HostProfiles, type HostProfileInput, type SignInKind } from "./host-profiles";
import type { TemplateContext } from "../backend/providers/recipe-templates/types";
import {
  OriginLinks,
  forgetLinkDismissals,
  isDismissed,
  rememberDismissal,
} from "./origin-links";
import { moveProjectToHost, planClone, runClone, switchProjectHost } from "./host-move";
import { adoptedProjectHosts } from "./project-groups";
import { planTransfer, transferProject, type TransferDeps } from "./host-transfer";
import { PathRouter } from "./path-router";
import { createProjectProgress } from "./progress";
import type { PublishToRenderer } from "../renderer-broadcast";
import { workspaceKey, type WorkspaceKeyOwner } from "../../src/lib/workspace-key";
import * as groups from "./project-groups";
import {
  buildProjectInfo,
  listGitWorkspaces,
  persistedFromInfo,
  seedCommands,
  withGroup,
} from "./project-info";
import { StateStore } from "./state-store";
import * as folders from "./workspace-folders";
import * as worktrees from "./worktrees";
import type {
  CreateWorktreeOptions,
  GroupUpdatableFields,
  HostProfile,
  IssueSeed,
  LinkedIssue,
  LinkSuggestion,
  PersistedProject,
  PersistedProjectGroup,
  ProjectGroupInfo,
  ProjectHostResolver,
  ProjectInfo,
  ProjectUpdatableFields,
  RemoteProjects,
  SignInMeta,
  TransferMode,
  TransferPlan,
  TransferResult,
  WorkspaceFolder,
  WorkspaceFromIssue,
} from "./types";

/** The settings a group shares, as one project had them on its own. */
type SharedSettings = Pick<
  PersistedProject,
  "name" | "color" | "agentCommand" | "themeName" | "commands" | "linearAssociations"
>;

function snapshotShared(p: PersistedProject): SharedSettings {
  return {
    name: p.name,
    color: p.color,
    agentCommand: p.agentCommand,
    themeName: p.themeName,
    commands: p.commands ? [...p.commands] : undefined,
    linearAssociations: p.linearAssociations ? [...p.linearAssociations] : undefined,
  };
}

function restoreShared(p: PersistedProject, own: SharedSettings): void {
  p.name = own.name;
  for (const key of ["color", "agentCommand", "themeName", "commands", "linearAssociations"] as const) {
    if (own[key] === undefined) delete p[key];
    else (p as unknown as Record<string, unknown>)[key] = own[key];
  }
}

export class ProjectManager {
  private readonly store: StateStore;
  private readonly hosts: HostRecords;
  private readonly profiles: HostProfiles;
  private readonly paths: PathRouter;
  private readonly ctx: ProjectContext;
  private readonly origins: OriginLinks;
  /** A project's own shared settings from just before `autoJoin` joined it, for `undoAutoJoin`. */
  private readonly joinedOwn = new Map<string, SharedSettings>();
  private readonly hostFor: ProjectHostResolver;
  private resyncDone = false;
  /** Adopted remote hosts' projects, on the desktop. */
  private readonly remote: RemoteProjects | undefined;

  /**
   * `hosts` resolves a host id to its backend — `BackendRegistry.get` in
   * the app. A bare `GitBackend` is this machine's git for every project,
   * with this machine's shell and facts (local-only callers and tests).
   */
  constructor(
    hosts: ProjectHostResolver | GitBackend,
    dataDir?: string,
    options: {
      /**
       * The server's layout store, as far as removing a worktree or a
       * project needs it. Optional so a test about projects
       * alone need not build one.
       */
      layout?: WorkspaceLayoutOwner;
      /**
       * How setup and clone progress reach renderers: the
       * composer's publish function. Without one, progress goes nowhere —
       * a test about projects alone has no renderer to tell.
       */
      publish?: PublishToRenderer;
      /**
       * Adopted remote hosts' projects: the desktop's. A host
       * server, which has no hosts of its own, has none.
       */
      remote?: RemoteProjects;
    } = {},
  ) {
    this.remote = options.remote;
    if (typeof hosts === "function") {
      this.hostFor = hosts;
    } else {
      const local = { git: hosts, shell: new ExecShellBackend(), facts: localFacts() };
      this.hostFor = () => local;
    }
    this.store = new StateStore(dataDir ?? manorDataDir());
    this.hosts = new HostRecords(this.store);
    this.profiles = new HostProfiles(this.store);
    // Remote hosts' projects route their paths too.
    this.paths = new PathRouter(
      () => this.allRecords(),
      (hostId) => this.hostFor(hostId).facts,
    );
    this.ctx = {
      store: this.store,
      hosts: this.hosts,
      paths: this.paths,
      host: (hostId) => this.hostFor(hostId),
      find: (projectId) => this.findProject(projectId),
      member: (projectId) => this.member(projectId),
      all: () => this.allRecords(),
      findAt: (hostId, dir) =>
        this.allRecords().find((p) => p.path === dir && p.hostId === hostId),
      info: (project) => this.buildProjectInfo(project),
      progress: createProjectProgress(options.publish ?? (() => {})),
      layout: options.layout,
      remote: this.remote,
    };
    this.origins = new OriginLinks(this.ctx);
  }

  private findProject(projectId: string): PersistedProject | undefined {
    return this.store.state.projects.find((p) => p.id === projectId);
  }

  // ── Remote hosts' projects ──

  /**
   * Adopted remote hosts' projects, as their servers hold them, less any
   * this desktop holds itself: one being moved off its host, for a moment.
   */
  private remoteInfos(): ProjectInfo[] {
    if (!this.remote) return [];
    const held = new Set(this.store.state.projects.map((p) => p.id));
    return this.remote.list().filter((p) => !held.has(p.id));
  }

  private remoteInfo(projectId: string): ProjectInfo | undefined {
    return this.remoteInfos().find((p) => p.id === projectId);
  }

  /** A project wherever it lives: this desktop's record, or a copy of a host's. */
  private member(projectId: string): PersistedProject | undefined {
    const held = this.findProject(projectId);
    if (held) return held;
    const info = this.remoteInfo(projectId);
    return info ? persistedFromInfo(info) : undefined;
  }

  /** Every project, this desktop's and remote hosts', in the sidebar's order. */
  private allRecords(): PersistedProject[] {
    return this.ordered([
      ...this.store.state.projects,
      ...this.remoteInfos().map(persistedFromInfo),
    ]);
  }

  /**
   * `projects` in the sidebar's order (`projectOrder`); without one, as
   * given. Ids it does not list keep their places after it.
   */
  private ordered<T extends { id: string }>(projects: T[]): T[] {
    const order = this.store.state.projectOrder;
    if (!order) return projects;
    const at = new Map(order.map((id, i) => [id, i]));
    return projects
      .map((project, i) => ({ project, rank: at.get(project.id) ?? order.length + i }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ project }) => project);
  }

  /** A remote project as the renderer sees it: its group's settings over it. */
  private decorateRemote(info: ProjectInfo): ProjectInfo {
    this.paths.setWorkspacePaths(
      info.id,
      info.workspaces.map((ws) => ws.path),
    );
    return withGroup(info, groups.groupOf(this.store.state, info.id));
  }

  /**
   * A remote host's answer, if it is a project, as the renderer sees it.
   * What the bridge forwards for a remote project comes back through here.
   */
  decorateRemoteResult(result: unknown): unknown {
    if (
      typeof result === "object" &&
      result !== null &&
      typeof (result as ProjectInfo).id === "string" &&
      Array.isArray((result as ProjectInfo).workspaces)
    ) {
      return this.decorateRemote(result as ProjectInfo);
    }
    return result;
  }

  /** The remote API, or a throw naming what needs it. */
  private requireRemote(what: string): RemoteProjects {
    if (!this.remote) throw new Error(`${what} needs a remote host's server.`);
    return this.remote;
  }

  /** Add `projectId` to the end of the sidebar's order, when it keeps one. */
  private appendToOrder(projectId: string): void {
    const order = this.store.state.projectOrder;
    if (order && !order.includes(projectId)) order.push(projectId);
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

  /**
   * Forget remote host `hostId`: its record, and every project
   * on it — this desktop's records of them, and the ones its server holds
   * (by the host's live list, and the ids handed over at adoption). Their
   * group memberships go as a removed project's do (the group
   * dissolves when one member is left), and with them their link
   * dismissals and their places in the sidebar's order. Nothing on the box
   * is touched: call before the registry lets go of the host, while its
   * live list still names its projects.
   */
  removeHost(hostId: string): void {
    this.hosts.assertRemote(hostId);
    const state = this.store.state;
    const selectedId = this.selectedProjectId();
    const held = state.projects.filter((p) => p.hostId === hostId);
    const ids = new Set([
      ...held.map((p) => p.id),
      ...(state.hosts?.[hostId]?.adoptedProjectIds ?? []),
      ...this.remoteInfos()
        .filter((p) => p.hostId === hostId)
        .map((p) => p.id),
    ]);
    const touchedGroups = new Set<string>();
    for (const id of ids) {
      const groupId = groups.groupOf(state, id)?.id;
      if (groups.forgetProject(state, id) && groupId) touchedGroups.add(groupId);
      forgetLinkDismissals(state, id);
    }
    state.projects = state.projects.filter((p) => p.hostId !== hostId);
    if (state.projectOrder) state.projectOrder = state.projectOrder.filter((id) => !ids.has(id));
    this.hosts.remove(hostId);
    this.hosts.clearForProjects(ids);
    this.paths.forgetHost(hostId);
    this.reselect(selectedId);
    this.store.save();
    for (const project of held) this.ctx.layout?.remove(workspaceKey(hostId, project.path));
    for (const groupId of touchedGroups) void this.origins.rememberGroupOrigin(groupId);
  }

  /**
   * The names of the projects on `hostId`: what destroying it
   * loses, since the host is their source of truth. This desktop's
   * own records of them, and what its server last listed (live or cached).
   */
  projectNamesOnHost(hostId: string): string[] {
    const names = [
      ...this.store.state.projects.filter((p) => p.hostId === hostId).map((p) => p.name),
      ...this.remoteInfos()
        .filter((p) => p.hostId === hostId)
        .map((p) => p.name),
    ];
    return [...new Set(names)];
  }

  /** How `hostId` is named to people: its ssh target, or "this Mac". */
  hostLabel(hostId: string): string {
    return this.hosts.label(hostId);
  }

  /** Throws unless `hostId` is this machine or a registered host. */
  assertKnownHost(hostId: string): void {
    this.hosts.assertKnown(hostId);
  }

  /** Remote hosts at least one project lives on. */
  remoteHostIdsInUse(): string[] {
    const ids = new Set<string>();
    for (const project of this.store.state.projects) {
      if (project.hostId !== LOCAL_HOST_ID) ids.add(project.hostId);
    }
    for (const project of this.remoteInfos()) ids.add(project.hostId);
    // An adopted host's projects are known only from its server, through
    // a cache that may be gone: it is in use whether or not one is listed,
    // or it would never connect to say what it has.
    for (const hostId of adoptedProjectHosts(this.store.state).values()) ids.add(hostId);
    for (const [hostId, host] of Object.entries(this.store.state.hosts ?? {})) {
      if (host?.adopted) ids.add(hostId);
    }
    return Array.from(ids);
  }

  /** Paths of the projects that live on this machine. */
  localProjectPaths(): string[] {
    return this.store.state.projects
      .filter((p) => p.hostId === LOCAL_HOST_ID)
      .map((p) => p.path);
  }

  /**
   * The projects on `hostId` as `projects.json` holds them, for adoption
   * onto that host's server: copies, with a linked-project group's
   * shared settings already resolved into each one — the host
   * server knows nothing of groups — without `hostPaths` (which name other
   * hosts) and with `hostId` rewritten to `local`, as the box knows it.
   */
  manifestRecords(hostId: string): ManifestProject[] {
    return this.store.state.projects
      .filter((p) => p.hostId === hostId)
      .map((p) => {
        const { hostPaths: _hostPaths, ...record } = structuredClone(p);
        const shared = groups.resolveShared(groups.groupOf(this.store.state, p.id), p);
        return {
          ...record,
          hostId: LOCAL_HOST_ID,
          name: shared.name,
          color: shared.color,
          agentCommand: shared.agentCommand,
          themeName: shared.themeName,
          commands: structuredClone(shared.commands),
          linearAssociations: structuredClone(shared.linearAssociations),
        };
      });
  }

  /**
   * The projects on `hostId` exactly as `projects.json` holds them, copied —
   * what adoption backs up before it removes them — with the
   * groups that name any of them.
   */
  hostProjectRecords(hostId: string): {
    projects: PersistedProject[];
    groups: PersistedProjectGroup[];
  } {
    const state = this.store.state;
    const projects = state.projects.filter((p) => p.hostId === hostId);
    const ids = new Set(projects.map((p) => p.id));
    return structuredClone({
      projects,
      groups: (state.groups ?? []).filter((g) => g.memberIds.some((id) => ids.has(id))),
    });
  }

  /**
   * Forget `projectIds` on `hostId` once its server has adopted them. Unlike `removeProject` this ends nothing: their workspaces, layout
   * and sessions live on, on the host. A linked-project group keeps their ids
   * in `memberIds` — the ids survive adoption — and the host's record keeps
   * them too (`adoptedProjectIds`), so the next load does not drop them as
   * unknown. Returns the ids removed.
   */
  removeAdoptedProjects(hostId: string, projectIds: readonly string[]): string[] {
    const state = this.store.state;
    const wanted = new Set(projectIds);
    const removed = state.projects.filter((p) => p.hostId === hostId && wanted.has(p.id));
    if (removed.length === 0) return [];
    // They stay in the sidebar, from the host, in their places;
    // the selection, an index into the sidebar's list, stays where it was.
    state.projectOrder ??= state.projects.map((p) => p.id);
    state.projects = state.projects.filter((p) => !removed.includes(p));
    const ids = removed.map((p) => p.id);
    this.hosts.recordAdoptedProjects(hostId, ids);
    this.store.save();
    return ids;
  }

  /**
   * Point every reference to an id the host merged away at the id it lives
   * on under now: a record that matched one of `hostId`'s by
   * path joined that one. Groups, dismissed pairs and the sidebar's order
   * follow; the new id is remembered as `hostId`'s. Saves.
   */
  remapProjectIds(hostId: string, remap: ReadonlyMap<string, string>): void {
    if (remap.size === 0) return;
    const state = this.store.state;
    const to = (id: string): string => remap.get(id) ?? id;
    for (const group of state.groups ?? []) {
      group.memberIds = [...new Set(group.memberIds.map(to))];
    }
    if (state.dismissedLinkSuggestions) {
      state.dismissedLinkSuggestions = state.dismissedLinkSuggestions.map(
        ([a, b]) => [to(a), to(b)] as [string, string],
      );
    }
    if (state.projectOrder) state.projectOrder = [...new Set(state.projectOrder.map(to))];
    this.hosts.recordAdoptedProjects(hostId, [...remap.values()]);
    this.store.save();
  }

  /** Whether `hostId`'s records have been handed over. */
  isHostAdopted(hostId: string): boolean {
    return this.hosts.isAdopted(hostId);
  }

  /** The hand-over of `hostId`'s records is complete. */
  markHostAdopted(hostId: string): void {
    this.hosts.markAdopted(hostId);
  }

  /** "Phones paired with this Mac can reach <host>". */
  hostLinksPhones(hostId: string): boolean {
    return this.hosts.linkPhones(hostId);
  }

  setHostLinksPhones(hostId: string, on: boolean): void {
    this.hosts.setLinkPhones(hostId, on);
  }

  /** "Keep Manor running when <host> restarts". */
  hostSupervised(hostId: string): boolean {
    return this.hosts.supervise(hostId);
  }

  setHostSupervised(hostId: string, on: boolean): void {
    this.hosts.setSupervise(hostId, on);
  }

  /** The host profile `hostId` was made from, if any. */
  hostProfileId(hostId: string): string | undefined {
    return this.hosts.profileId(hostId);
  }

  setHostProfileId(hostId: string, profileId: string | undefined): void {
    this.hosts.setProfileId(hostId, profileId);
  }

  /** The project `hostId` was made for, if any. */
  hostForProject(hostId: string): string | undefined {
    return this.hosts.forProject(hostId);
  }

  setHostForProject(hostId: string, projectId: string | undefined): void {
    this.hosts.setForProject(hostId, projectId);
  }

  /**
   * Hosts that were made for `projectId`: `removeProject` and
   * `removeHost` clear their `forProject`, so callers read this first to
   * know which hosts' records changed.
   */
  hostsMadeFor(projectId: string): string[] {
    return this.hosts.list().filter((h) => this.hosts.forProject(h.hostId) === projectId).map((h) => h.hostId);
  }

  /** Every host profile. */
  listHostProfiles(): HostProfile[] {
    return this.profiles.list();
  }

  getHostProfile(profileId: string): HostProfile | undefined {
    return this.profiles.get(profileId);
  }

  /** Make or update a host profile; throws if the template refuses its answers. */
  saveHostProfile(input: HostProfileInput, ctx: TemplateContext): HostProfile {
    return this.profiles.save(input, ctx);
  }

  /** Record or clear a profile's sign-in metadata; never a token. */
  setHostProfileSignIn(profileId: string, which: SignInKind, meta: SignInMeta | null): HostProfile {
    return this.profiles.setSignIn(profileId, which, meta);
  }

  /** Forget a host profile; its hosts stay, without a `profileId`. */
  removeHostProfile(profileId: string): void {
    this.profiles.remove(profileId);
  }

  /** Linked pairings on `hostId` still to revoke. */
  pendingHostRevokes(hostId: string): string[] {
    return this.hosts.pendingRevokes(hostId);
  }

  addPendingHostRevokes(hostId: string, hostDeviceIds: readonly string[]): void {
    this.hosts.addPendingRevokes(hostId, hostDeviceIds);
  }

  clearPendingHostRevokes(hostId: string, hostDeviceIds: readonly string[]): void {
    this.hosts.clearPendingRevokes(hostId, hostDeviceIds);
  }

  /** Pairings started on `hostId` whose answer was not handled yet. */
  pendingHostMints(hostId: string): Array<{ label: string; startedAt: number }> {
    return this.hosts.pendingMints(hostId);
  }

  addPendingHostMint(hostId: string, mint: { label: string; startedAt: number }): void {
    this.hosts.addPendingMint(hostId, mint);
  }

  clearPendingHostMints(hostId: string, labels: readonly string[]): void {
    this.hosts.clearPendingMints(hostId, labels);
  }

  /** `hostId`'s pairing keys were reset: nothing there is owed any more. */
  forgetOwedOnHost(hostId: string): void {
    this.hosts.forgetOwed(hostId);
  }

  /**
   * On a host server: take in the desktop's records for this host. A project matched by id — or, failing that, by path — is merged with
   * the host winning every conflict (`mergeAdoptedProject`); any other is
   * added, as this host's own. Writes once.
   */
  adoptProjects(records: readonly ManifestProject[]): void {
    const state = this.store.state;
    for (const record of records) {
      const existing =
        this.findProject(record.id) ??
        state.projects.find((p) => p.hostId === LOCAL_HOST_ID && p.path === record.path);
      if (existing) mergeAdoptedProject(existing, record);
      else state.projects.push({ ...structuredClone(record), hostId: LOCAL_HOST_ID });
    }
    this.store.save();
  }

  /**
   * The project a workspace on `hostId` belongs to, as an agent's record
   * names it: its id, and the name and agent command the
   * renderer sees — a linked group's shared values where it has them. Null
   * when no project owns the path. Synchronous, from what is already known
   * (`PathRouter.projectForPath`): the agent pipeline asks on every hook.
   */
  workspaceProject(
    hostId: string,
    workspacePath: string,
  ): { projectId: string; projectName: string; agentCommand: string | null } | null {
    const project = this.paths.projectForPath(hostId, workspacePath);
    if (!project) return null;
    const shared = groups.resolveShared(groups.groupOf(this.store.state, project.id), project);
    return {
      projectId: project.id,
      projectName: shared.name,
      agentCommand: shared.agentCommand,
    };
  }

  /** Run `listener` after every write of `projects.json` — any project mutation. */
  onStateSaved(listener: () => void): void {
    this.store.onSave(listener);
  }

  /** The host a project lives on; `"local"` for unknown projects. */
  getProjectHostId(projectId: string | null | undefined): string {
    if (!projectId) return LOCAL_HOST_ID;
    return (
      this.findProject(projectId)?.hostId ??
      this.remoteInfo(projectId)?.hostId ??
      adoptedProjectHosts(this.store.state).get(projectId) ??
      LOCAL_HOST_ID
    );
  }

  /** Whether a project lives on a remote host's server. */
  isRemoteProject(projectId: string): boolean {
    return !this.findProject(projectId) && this.remoteInfo(projectId) !== undefined;
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
    const held = await Promise.all(this.store.state.projects.map((p) => this.buildProjectInfo(p)));
    return this.ordered([...held, ...this.remoteInfos().map((p) => this.decorateRemote(p))]);
  }

  /**
   * Only the projects on remote hosts, their worktrees listed afresh. Local
   * projects' worktrees are kept current by `WorktreeWatcher`, so a refresh
   * that only needs what no watcher sees (a window focus) skips them.
   */
  async getRemoteProjects(): Promise<ProjectInfo[]> {
    const held = await Promise.all(
      this.store.state.projects
        .filter((p) => p.hostId !== LOCAL_HOST_ID)
        .map((p) => this.buildProjectInfo(p)),
    );
    return this.ordered([...held, ...this.remoteInfos().map((p) => this.decorateRemote(p))]);
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
    this.appendToOrder(project.id);
    this.store.state.selectedProjectIndex = Math.max(0, this.orderOf(project.id));
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
   * there first, with progress on `projects:clone-progress`, then the
   * normal `addProject` path.
   *
   * If `targetDir` already exists and is a clone of `repoUrl`, cloning is
   * skipped and the existing checkout is adopted instead of clobbered. Any
   * other non-empty directory is refused. A checkout Manor already has a
   * project for returns that project rather than a second record for the
   * same host+path.
   */
  async cloneProject(opts: {
    hostId: string;
    repoUrl: string;
    targetDir: string;
    name: string;
  }): Promise<ProjectInfo> {
    this.hosts.assertKnown(opts.hostId);
    // A host whose projects are its server's clones and adds it there;
    // the host's server reports the progress.
    if (this.remote?.owns(opts.hostId)) {
      const cloned = (await this.remote.call(opts.hostId, "clone", [opts])) as ProjectInfo;
      this.appendToOrder(cloned.id);
      this.store.state.selectedProjectIndex = Math.max(0, this.orderOf(cloned.id));
      this.store.save();
      return this.decorateRemote(cloned);
    }
    const plan = await planClone(this.ctx, opts.hostId, opts);
    await runClone(this.ctx, plan);
    if (plan.owner) return this.buildProjectInfo(plan.owner);
    return this.addProject(opts.name, plan.targetDir, opts.hostId);
  }

  /**
   * See `host-move.ts`. A project on a remote host's server, or moving onto
   * one, crosses servers (`moveAcrossServers`).
   */
  moveProjectToHost(
    projectId: string,
    opts: { hostId: string; repoUrl: string; remoteDir: string },
  ): Promise<ProjectInfo> {
    return moveAcrossServers(this.ctx, projectId, opts.hostId, () =>
      moveProjectToHost(this.ctx, projectId, opts),
    );
  }

  /** See `host-move.ts`. The caller connects a remote host first. */
  switchProjectHost(
    projectId: string,
    hostId: string,
    explicitPath?: string,
  ): Promise<ProjectInfo> {
    return moveAcrossServers(this.ctx, projectId, hostId, () =>
      switchProjectHost(this.ctx, projectId, hostId, explicitPath),
    );
  }

  /**
   * Hand what this desktop still holds for `hostId` — a moved project's
   * layout, say — to its server, when its projects are its server's.
   * A no-op for any other host.
   */
  async handOverHost(hostId: string): Promise<void> {
    if (this.remote?.owns(hostId)) await this.remote.handOver(hostId, []);
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

  /** See `host-transfer.ts`. Changes nothing. */
  planTransfer(projectId: string, hostId: string): Promise<TransferPlan> {
    return planTransfer(this.ctx, this.transferDeps(), projectId, hostId);
  }

  /**
   * Copy or move a project onto a host in one call; see
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
   * The project's stored `origin` URL on its current host, or null on any
   * failure. Pre-fills the repo URL when setting it up on another host. Not
   * `remote get-url`: that applies this host's `insteadOf` rewrites, which
   * another host may not share and which `remoteDirIsCloneOf` won't match.
   */
  async getOriginUrl(projectId: string): Promise<string | null> {
    const project = this.member(projectId);
    if (!project) return null;
    try {
      const out = await this.hostFor(project.hostId).git.exec(project.path, [
        "config",
        "--get",
        "remote.origin.url",
      ]);
      const url = out.trim();
      return url === "" ? null : url;
    } catch {
      return null;
    }
  }

  /** Whether the project's `path` exists on the host it lives on. */
  async projectPathExists(projectId: string): Promise<boolean> {
    const project = this.member(projectId);
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
   * renderer drops them. The directories stay; only Manor lets
   * go of them.
   *
   * The project leaves the list before the first `await`, so a caller that
   * does not wait still sees it gone.
   */
  async removeProject(projectId: string): Promise<void> {
    const selectedId = this.selectedProjectId();
    const remote = this.remoteInfo(projectId);
    if (remote && !this.findProject(projectId)) {
      // Its host's server forgets it and ends its panes there;
      // this desktop only lets go of its groups' and dismissals' mention.
      await this.requireRemote("Removing it").call(remote.hostId, "remove", [projectId]);
      const state = this.store.state;
      const groupId = groups.groupOf(state, projectId)?.id;
      groups.forgetProject(state, projectId);
      forgetLinkDismissals(state, projectId);
      if (state.projectOrder) state.projectOrder = state.projectOrder.filter((id) => id !== projectId);
      this.hosts.clearForProjects(new Set([projectId]));
      this.reselect(selectedId);
      this.store.save();
      if (groupId) void this.origins.rememberGroupOrigin(groupId);
      return;
    }
    const project = this.findProject(projectId);
    const state = this.store.state;
    const groupId = groups.groupOf(state, projectId)?.id;
    groups.forgetProject(state, projectId);
    forgetLinkDismissals(state, projectId);
    state.projects = state.projects.filter((p) => p.id !== projectId);
    this.hosts.clearForProjects(new Set([projectId]));
    this.reselect(selectedId);
    this.store.save();
    if (groupId) void this.origins.rememberGroupOrigin(groupId);
    const layout = this.ctx.layout;
    if (!project || !layout) return;

    let paths: string[] = [];
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
   * — and saving one never asks the host anything.
   *
   * For a grouped project the shared settings (name, color, agent command,
   * Linear) are the group's, so those go to the group.
   */
  async updateProject(
    projectId: string,
    updates: ProjectUpdatableFields,
  ): Promise<ProjectInfo | null> {
    const project = this.findProject(projectId);
    if (!project) return this.updateRemoteProject(projectId, updates);
    const group = groups.groupOf(this.store.state, projectId);
    const { shared, own } = group
      ? splitShared(updates)
      : { shared: {}, own: updates };
    Object.assign(project, own);
    if (group && Object.keys(shared).length > 0) {
      // Saves the project's own changes too.
      groups.updateGroup(this.ctx, group.id, shared);
      await groups.writeThroughShared(this.ctx, group);
    } else {
      this.store.save();
    }
    return this.buildProjectInfo(project);
  }

  /**
   * `updateProject` for a project on a remote host's server:
   * its own settings are written there, a group's shared ones to the group,
   * which writes them through to every remote member. Null when no host
   * has it.
   */
  private async updateRemoteProject(
    projectId: string,
    updates: ProjectUpdatableFields,
  ): Promise<ProjectInfo | null> {
    const info = this.remoteInfo(projectId);
    if (!info) return null;
    const remote = this.requireRemote("Updating it");
    const group = groups.groupOf(this.store.state, projectId);
    const { shared, own } = group ? splitShared(updates) : { shared: {}, own: updates };
    let updated: ProjectInfo = info;
    if (Object.keys(own).length > 0) {
      const answer = (await remote.call(info.hostId, "update", [projectId, own])) as ProjectInfo | null;
      if (answer) updated = answer;
    }
    if (group && Object.keys(shared).length > 0) {
      groups.updateGroup(this.ctx, group.id, shared);
      await groups.writeThroughShared(this.ctx, group);
    }
    return this.decorateRemote(updated);
  }

  reorderProjects(orderedIds: string[]): void {
    const state = this.store.state;
    const selectedId = this.selectedProjectId();
    // The whole sidebar's order, remote hosts' projects included.
    if (this.remote || state.projectOrder) {
      const known = new Set(this.allRecords().map((p) => p.id));
      const listed = orderedIds.filter((id) => known.has(id));
      state.projectOrder = [...listed, ...[...known].filter((id) => !listed.includes(id))];
    }
    const byId = new Map(state.projects.map((p) => [p.id, p]));
    const reordered = orderedIds
      .map((id) => byId.get(id))
      .filter((p): p is PersistedProject => p != null);
    // Append any projects not in orderedIds (shouldn't happen, but safe)
    const orderedSet = new Set(orderedIds);
    for (const p of state.projects) {
      if (!orderedSet.has(p.id)) reordered.push(p);
    }
    state.projects = reordered;
    this.reselect(selectedId);
    this.store.save();
  }

  // ── Linked-project groups (see `project-groups.ts`) ──

  /**
   * Link two projects on different hosts: `projectId` joins `otherId`'s
   * group, `otherId` joins `projectId`'s, or a new group starts. Throws on
   * a second member for one host.
   */
  linkProjects(projectId: string, otherId: string): ProjectGroupInfo {
    const group = groups.linkProjects(this.ctx, projectId, otherId);
    // Record the group's `origin` once a member's host reports it.
    void this.origins.rememberGroupOrigin(group.id);
    this.writeThrough(group.id);
    return group;
  }

  /**
   * Write `groupId`'s shared settings through to its remote members'
   * hosts, without waiting: a link answers at once.
   */
  private writeThrough(groupId: string): void {
    const group = this.store.state.groups?.find((g) => g.id === groupId);
    if (group) void groups.writeThroughShared(this.ctx, group);
  }

  /**
   * Set a group's shared settings (name, color, agent command, Linear).
   * Returns every member as the renderer now sees it. Throws on an unknown
   * group.
   */
  async updateGroup(groupId: string, updates: GroupUpdatableFields): Promise<ProjectInfo[]> {
    const group = groups.updateGroup(this.ctx, groupId, updates);
    await groups.writeThroughShared(this.ctx, group);
    const held = await Promise.all(
      group.memberIds
        .map((id) => this.findProject(id))
        .filter((p): p is PersistedProject => p != null)
        .map((p) => this.buildProjectInfo(p)),
    );
    const remote = this.remoteInfos()
      .filter((p) => group.memberIds.includes(p.id))
      .map((p) => this.decorateRemote(p));
    return [...held, ...remote];
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

  /**
   * "Keep separate…": dissolve `projectId`'s group as
   * `unlinkGroup` does, and dismiss every pair of its former members, so
   * `autoJoin` never joins them again. An ungrouped project is a no-op.
   */
  keepSeparate(projectId: string): void {
    const group = groups.groupOf(this.store.state, projectId);
    if (!group) return;
    const ids = [...group.memberIds];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) rememberDismissal(this.ctx, ids[i], ids[j]);
    }
    // Saves the dismissals too.
    groups.unlinkGroup(this.ctx, group.id);
  }

  /** Remember the host a group last made a workspace on (New Workspace picker). */
  setGroupLastUsedHost(groupId: string, hostId: string): void {
    groups.setGroupLastUsedHost(this.ctx, groupId, hostId);
  }

  // ── Link suggestions by `origin` (see `origin-links.ts`) ──

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

  /**
   * Join every pair `suggestLinks` finds among projects not yet in a group:
   * same-origin projects on different hosts become one project
   * set up on both, without asking. Returns the pairs joined, each as the
   * project that joined and the one it joined; undoing one is
   * `unlinkProject(joinedId)` and then `dismissLinkSuggestion(joinedId,
   * intoId)`. Saves once, when anything was joined.
   *
   * The existing side keeps its settings: a group's stay the group's, and a
   * new group takes the earlier-added project's (see `joinPair`). Each
   * project's suggestions are asked afresh, after the joins before it, and
   * a pair an earlier join made impossible (host taken, two groups) is
   * skipped.
   */
  async autoJoin(): Promise<Array<{ joinedId: string; intoId: string }>> {
    const state = this.store.state;
    const lone = this.allRecords()
      .filter((p) => !groups.groupOf(state, p.id))
      .map((p) => p.id);
    const joined: Array<{ joinedId: string; intoId: string }> = [];
    for (const projectId of lone) {
      // Removed while an earlier project's hosts were asked.
      if (!this.member(projectId)) continue;
      for (const suggestion of await this.origins.suggest(projectId)) {
        const pair = this.joinPair(projectId, suggestion.projectId);
        if (pair) joined.push(pair);
      }
    }
    if (joined.length === 0) return joined;
    this.store.save();
    const groupIds = new Set(
      joined.flatMap(({ intoId }) => groups.groupOf(state, intoId)?.id ?? []),
    );
    for (const groupId of groupIds) {
      void this.origins.rememberGroupOrigin(groupId);
      this.writeThrough(groupId);
    }
    return joined;
  }

  /**
   * Undo one `autoJoin` pair for good: take `joinedId` out of its
   * group, give it back the settings it had before it joined (unlinking
   * alone leaves it the group's), and dismiss the pair so it is never
   * joined again. Saves once. The settings are remembered in memory only,
   * so after a restart the newcomer keeps the group's, as `unlinkProject`
   * leaves them.
   */
  undoAutoJoin(joinedId: string, intoId: string): void {
    const project = this.member(joinedId);
    const groupId = groups.groupOf(this.store.state, joinedId)?.id;
    if (project && groupId) {
      // `unlinkProject` saves; the restore and the dismissal save again below.
      this.unlinkProject(joinedId);
    }
    const own = this.joinedOwn.get(joinedId);
    if (project && own) {
      restoreShared(project, own);
      // A remote project's record is its host's: the restore goes there.
      if (!this.findProject(joinedId) && this.remote) {
        void this.remote
          .call(project.hostId, "update", [joinedId, own])
          .catch((err: unknown) => {
            console.warn(`[project-manager] could not restore ${joinedId}'s settings:`, err);
          });
      }
    }
    this.joinedOwn.delete(joinedId);
    rememberDismissal(this.ctx, joinedId, intoId);
    this.store.save();
  }

  /**
   * Join `a` and `b` without saving, for `autoJoin`; null when they can't
   * be joined now. The newcomer is the side not in a group, or, when
   * neither is, the one added later (later in the project list), so the
   * project that was there first names the group and gives it its settings.
   * Two members of one group, or of two groups, are left as they are, and
   * so is a newcomer dismissed with any member of what it would join.
   */
  private joinPair(a: string, b: string): { joinedId: string; intoId: string } | null {
    const state = this.store.state;
    const projectA = this.member(a);
    const projectB = this.member(b);
    if (!projectA || !projectB) return null;
    const groupA = groups.groupOf(state, a);
    const groupB = groups.groupOf(state, b);
    if (groupA && groupB) return null;
    let joinedId: string;
    let intoId: string;
    if (groupA) [joinedId, intoId] = [b, a];
    else if (groupB) [joinedId, intoId] = [a, b];
    else if (this.orderOf(a) > this.orderOf(b)) {
      [joinedId, intoId] = [a, b];
    } else {
      [joinedId, intoId] = [b, a];
    }
    // Suggestions were asked before this batch's earlier joins, so a group
    // `intoId` is in now may hold a project the newcomer was kept apart from.
    const target = groups.groupOf(state, intoId)?.memberIds ?? [intoId];
    if (target.some((id) => isDismissed(state, joinedId, id))) return null;
    const own = snapshotShared(this.member(joinedId)!);
    try {
      groups.joinProjects(this.ctx, joinedId, intoId);
    } catch {
      // A host this batch already filled for the group.
      return null;
    }
    this.joinedOwn.set(joinedId, own);
    return { joinedId, intoId };
  }

  /** The selected project's id: `selectedProjectIndex` indexes the sidebar's list. */
  private selectedProjectId(): string | undefined {
    return this.allRecords()[this.store.state.selectedProjectIndex]?.id;
  }

  /**
   * Point `selectedProjectIndex` at `selectedId` again after the list
   * changed; when it is gone, keep the index, within the list.
   */
  private reselect(selectedId: string | undefined): void {
    const state = this.store.state;
    const index = selectedId === undefined ? -1 : this.orderOf(selectedId);
    state.selectedProjectIndex =
      index >= 0 ? index : Math.max(0, Math.min(state.selectedProjectIndex, this.allRecords().length - 1));
  }

  /** Where `projectId` sits in the sidebar's list; -1 when nowhere. */
  private orderOf(projectId: string): number {
    return this.allRecords().findIndex((p) => p.id === projectId);
  }

  // ── Workspaces and folders (see `workspace-folders.ts`) ──

  selectWorkspace(projectId: string, workspaceIndex: number): void {
    const project = this.findProject(projectId);
    const remote = project ? undefined : this.remoteInfo(projectId);
    if (!project && !remote) return;
    if (project) project.selectedWorkspaceIndex = workspaceIndex;
    const projectIndex = this.orderOf(projectId);
    if (projectIndex >= 0) this.store.state.selectedProjectIndex = projectIndex;
    this.store.save();
    // A remote project's selection is its host's record. Not
    // waited for: a host that is away keeps the one it had.
    if (remote && this.remote) {
      void this.remote
        .call(remote.hostId, "selectWorkspace", [projectId, workspaceIndex])
        .catch(() => {});
    }
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
    ending?: PaneEnding,
  ): Promise<void> {
    return worktrees.removeWorktree(this.ctx, projectId, worktreePath, deleteBranch, onProgress, ending);
  }

  canQuickMerge(
    projectId: string,
    worktreePath: string,
  ): Promise<{ canMerge: boolean; reason?: string }> {
    return worktrees.canQuickMerge(this.ctx, projectId, worktreePath);
  }

  worktreeRemovalRisk(
    projectId: string,
    worktreePath: string,
    opts?: { createdAt?: number },
  ): Promise<string | null> {
    return worktrees.worktreeRemovalRisk(this.ctx, projectId, worktreePath, opts);
  }

  runBaseRef(projectId: string): Promise<string | null> {
    return worktrees.runBaseRef(this.ctx, projectId);
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
