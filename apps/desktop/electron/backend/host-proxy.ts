/**
 * HostProxy — the desktop's view of one remote host's state, as that host's
 * server holds it. One per remote host, owned beside its
 * `HostServerClient` by `RemoteHostConnection`.
 *
 * - **Snapshot.** Whenever the owner channel comes up it reads the host's
 *   `projects.getAll`, `layout.getAll`, `layout.getLastActive` and
 *   `agents.getAll`. `ready` resolves at the first one.
 * - **Events.** It listens to the host's `projects.changed`,
 *   `layout.changed`, `layout.paneTitle` and `agents.updated` (the client re-sends the
 *   subscriptions on every reconnect) and republishes them into the
 *   desktop's bus. `projects.changed` carries nothing, so it re-reads the
 *   projects first and the desktop hears it once they are in.
 * - **Chat** is keyed by pane (or task), and the host's mirror only watches a
 *   pane somebody subscribed to at exactly that key. So chat is not heard by
 *   default: `watchChat(event, key)` forwards one subscription to the host
 *   and republishes what comes back through `publishKeyed`, at the same key.
 *   Pane ids are the same on both sides, so nothing in it is rewritten.
 * - **A pane's terminal** is heard the same way: `watchPty`
 *   forwards one of the pane's `pty.*` subscriptions, for a caller of the
 *   desktop's that views a remote pane through it.
 * - **Claims**. A tab a detached desktop window holds is the
 *   desktop's to know (`claimsFor`), not the host's: every layout entry this
 *   hands out or publishes carries the desktop's claims on it.
 * - **Rewriting.** To the host server its own host is `local` and its
 *   workspaces are keyed by bare path. To the desktop it is `hostId`, and
 *   its workspaces are keyed `<hostId>:<path>` (`workspaceKey`). Everything
 *   this hands out or publishes is in the desktop's form; `invoke` turns the
 *   desktop's form back into the host's on the way in, and the answer back
 *   on the way out.
 * - **Offline cache.** The host's last projects, agents and layout are kept
 *   in `~/.manor/host-cache/<hostId>.json` (written atomically, a moment
 *   after each change, in the host's own form) and read back at
 *   construction, so the reads below answer while the host is away. Writes
 *   are not queued: `invoke` refuses while the channel is down.
 * - **The host's name** is the desktop's alias for it (`label`, the user's
 *   ssh target), never the box's own hostname, which the server's hello now
 *   carries.
 *
 * **Agents** are the host's alone: the desktop no longer replays its hooks,
 * so each `agents.updated` is republished (`republishAgents`, on for the
 * desktop) and handed to `onAgentUpdate` with the agent's previous state, which
 * is where the desktop's notifications and dock badge follow a remote agent.
 * The proxy's own list is kept either way. A snapshot after an absence is
 * told the same way: an agent that is new or changed since the proxy last held
 * it is republished, and one whose status moved is handed to `onAgentUpdate`
 * once, however many hooks fired meanwhile (an agent met for the first time,
 * with nothing held before, is not news).
 *
 * **Per-connection readiness** (`synced`): `ready` is the first snapshot only.
 * `synced()` resolves once the snapshot of the current connection is in, or
 * at once when the box has no server to read.
 *
 * **Progress** the host addresses to the owner connection — a workspace's
 * setup and teardown steps, a clone's — is handed to `onProgress`, which
 * knows which of the desktop's callers asked (`HostRouting`).
 */

import fs from "node:fs";
import { writeFileAtomic } from "../lib/fs-atomic";
import { errorMessage } from "../lib/errors";
import type { AgentInfo } from "../agent-persistence";
import { HOST_LOG_KINDS, type NotificationRecord } from "../notification-store";
import type { ProjectInfo } from "../projects/types";
import type { BroadcastBus } from "../renderer-broadcast";
import type { EventArgs } from "../bridge/events";
import type { PaneAgentStatusUpdate } from "../../src/electron";
import type { LayoutBroadcast, LayoutEntry, LayoutOrigin } from "../../src/lib/layout/protocol";
import type { LayoutClaim } from "../../src/lib/layout/visible-tabs";
import type { WorkspaceLayout } from "../../src/lib/layout/workspace-layout";
import { keyFor, toDesktop, toDesktopResult, toHostArgs } from "../bridge/host-rewrite";
import { parseWorkspaceKey, type WorkspaceKey } from "../../src/lib/workspace-key";
import {
  HostServerUnavailableError,
  type HostServerClient,
} from "./host-server-client";

/** What the proxy needs of its host's owner channel. */
export type HostProxyChannel = Pick<
  HostServerClient,
  "hostId" | "state" | "invoke" | "subscribe" | "onStateChange"
>;

/** The keyed chat events `watchChat` forwards. */
export type HostChatEvent = "entry" | "taskEntry";

/** A pane's terminal events `watchPty` forwards, keyed by pane. */
export const HOST_PTY_EVENTS = ["output", "resized", "exit", "cwd", "error", "winsizeOwner"] as const;
export type HostPtyEvent = (typeof HOST_PTY_EVENTS)[number];

/** The `projects` progress events a host addresses to its owner. */
export type HostProgressEvent = "worktreeProgress" | "removeWorktreeProgress" | "cloneProgress";

const PROGRESS_EVENTS: readonly HostProgressEvent[] = [
  "worktreeProgress",
  "removeWorktreeProgress",
  "cloneProgress",
];

export interface HostProxyOptions {
  client: HostProxyChannel;
  /** The desktop's bus: what renderers and paired devices hear. */
  bus: Pick<BroadcastBus, "publish">;
  /** The desktop's name for the host (`HostRecords.label`), read at use. */
  label: () => string;
  /** Where the offline cache lives (`hostCacheFile(hostId)`). */
  cacheFile: string;
  /** Republish the host's `agents.updated` and `agents.status` into the bus (off by default). */
  republishAgents?: boolean;
  /**
   * A live `agents.updated` from the host, in the desktop's form, with the
   * agent as the proxy held it before (undefined for a new one). Not called
   * for a snapshot, which is not news.
   */
  onAgentUpdate?: (
    agent: AgentInfo,
    unseen: EventArgs<"agents", "updated">[1],
    previous: AgentInfo | undefined,
  ) => void;
  /**
   * The host's unseen flags as a snapshot read them, with every agent id the
   * host holds: the desktop's own flags for those agents follow the host's.
   */
  onUnseenRead?: (
    agentIds: readonly string[],
    unseen: { responded: string[]; requires_input: string[] },
  ) => void;
  /**
   * A `projects.*Progress` event the host sent its owner, args as sent.
   * Paths in them are the host's, which are the workspaces' own.
   */
  onProgress?: (event: HostProgressEvent, args: unknown[]) => void;
  /**
   * Where a forwarded chat or terminal event goes, at its key: the desktop's
   * `BridgeServer.publish`, since the bus carries no key. Without it,
   * `watchChat` and `watchPty` hear nothing.
   */
  publishKeyed?: (
    ns: "chat" | "pty",
    event: HostChatEvent | HostPtyEvent,
    args: unknown[],
    key: string,
  ) => void;
  /**
   * The desktop windows' claims on a workspace of this host's, by its key.
   * Read at use; none without it.
   */
  claimsFor?: (key: WorkspaceKey) => LayoutClaim[];
  /**
   * A workspace's layout is about to be published, moving from `before` to
   * `after` (`null`: the workspace was removed). Lets the desktop drop claims
   * on tabs that left, so the publish carries that.
   */
  onLayoutMoved?: (
    key: WorkspaceKey,
    before: WorkspaceLayout | undefined,
    after: WorkspaceLayout | null,
  ) => void;
  /**
   * The host's notification log changed (`notifications()`): a snapshot read
   * it, or the host said so.
   */
  onNotificationsChanged?: () => void;
  /** How long a change waits before the cache file is written. */
  saveDelayMs?: number;
  log?: Pick<Console, "info" | "warn">;
}

/** Bumped when the cache file's shape changes; any other version is ignored. */
const CACHE_VERSION = 1;

const DEFAULT_SAVE_DELAY_MS = 500;

/** The cache file, in the host's own form. */
interface HostCache {
  version: number;
  hostId: string;
  savedAt: string;
  projects: ProjectInfo[];
  agents: AgentInfo[];
  layout: {
    /** Keyed by bare path. Claims are live state and are not kept. */
    workspaces: Record<string, LayoutEntry>;
    lastActiveWorkspacePath: string | null;
  };
}

/** The origin a layout broadcast the proxy made up itself carries. */
function proxyOrigin(hostId: string): LayoutBroadcast["origin"] {
  return { kind: "route", id: `host-proxy:${hostId}` };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class HostProxy {
  readonly hostId: string;
  /** Resolves when the first snapshot from the host is in. Never rejects. */
  readonly ready: Promise<void>;
  private readonly client: HostProxyChannel;
  private readonly opts: HostProxyOptions;
  private readonly log: Pick<Console, "info" | "warn">;
  private resolveReady!: () => void;
  /** Whether the current connection's snapshot is in. */
  private inSync = false;
  private readonly syncWaiters = new Set<() => void>();

  // The host's state, in its own form (bare paths, `hostId: "local"`).
  private projectList: ProjectInfo[] = [];
  private agentList = new Map<string, AgentInfo>();
  /**
   * The host's notification log, its automation records only: a remote
   * agent's own notifications are the desktop's, recorded as it hears them.
   * Read after each snapshot; not cached on disk.
   */
  private notificationList: NotificationRecord[] = [];
  /** Each pane's last published Agent status; live, so never cached on disk. */
  private paneStatusList = new Map<string, PaneAgentStatusUpdate>();
  private workspaces: Record<string, LayoutEntry> = {};
  private lastActive: string | null = null;

  /** Bumped per snapshot; a snapshot that is no longer current lands nothing. */
  private snapshotGeneration = 0;
  /** Layout reads in flight (a snapshot's, a re-read's). */
  private layoutReads = 0;
  /**
   * Workspaces removed (by event) while a layout read was in flight, with
   * the version they were removed at: the read may predate the removal.
   */
  private readonly removedDuringRead = new Map<string, number>();
  /** Re-read the projects (`projects.changed` carries nothing). */
  private readonly rereadProjects = coalesced(() => this.readProjects());
  /** Re-read the layout, for a workspace an event named that this lacks. */
  private readonly rereadLayout = coalesced(() => this.readLayout());

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly releases: Array<() => void> = [];

  constructor(opts: HostProxyOptions) {
    this.opts = opts;
    this.client = opts.client;
    this.hostId = opts.client.hostId;
    this.log = opts.log ?? console;
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.loadCache();

    const { client } = this;
    this.releases.push(
      client.subscribe("projects", "changed", undefined, () => this.onProjectsChanged()),
      client.subscribe("layout", "changed", undefined, (payload) =>
        this.onLayoutChanged(payload as LayoutBroadcast),
      ),
      // A title set over the command channel (a phone's edit, a forwarded
      // `layout.setPaneTitle`): only the host's store hears it. Pane ids are
      // the same on both sides.
      client.subscribe("layout", "paneTitle", undefined, (payload) => {
        if (!this.disposed && isPlainObject(payload)) {
          this.opts.bus.publish("layout", "paneTitle", payload as unknown as EventArgs<"layout", "paneTitle">[0]);
        }
      }),
      client.subscribe("agents", "updated", undefined, (agent, unseen) =>
        this.onAgentUpdated(
          agent as AgentInfo,
          unseen as EventArgs<"agents", "updated">[1],
        ),
      ),
      // Each pane's Agent status is the host's reconciler's; the
      // desktop derives none for a pane on an adopted host.
      client.subscribe("agents", "status", undefined, (update) => {
        if (this.disposed || !isPlainObject(update) || typeof update.paneId !== "string") return;
        this.paneStatusList.set(update.paneId, update as unknown as PaneAgentStatusUpdate);
        if (this.opts.republishAgents) {
          this.opts.bus.publish("agents", "status", update as unknown as PaneAgentStatusUpdate);
        }
      }),
      // The host's log, whole on every change.
      client.subscribe("notifications", "changed", undefined, (list) => {
        if (this.disposed || !Array.isArray(list)) return;
        this.applyNotifications(list);
      }),
      // The host's automations are its server's alone: the desktop keeps no
      // copy, and tells its renderers which host to re-read.
      client.subscribe("automations", "changed", undefined, (info) => {
        if (this.disposed || !isPlainObject(info) || typeof info.automationId !== "string") return;
        this.opts.bus.publish("automations", "changed", {
          hostId: this.hostId,
          automationId: info.automationId,
        });
      }),
      ...PROGRESS_EVENTS.map((event) =>
        client.subscribe("projects", event, undefined, (...args) => {
          if (!this.disposed) this.opts.onProgress?.(event, args);
        }),
      ),
      client.onStateChange((state) => {
        if (state !== "connected") this.inSync = false;
        if (state === "connected") void this.snapshot();
        else if (state === "unsupported") this.releaseSyncWaiters();
      }),
    );
    if (client.state === "connected") void this.snapshot();
  }

  /** How the desktop names this host: its alias, not the box's hostname. */
  get label(): string {
    return this.opts.label();
  }

  /** Whether the host's server is out of reach: reads are the cache's. */
  get away(): boolean {
    return this.client.state !== "connected";
  }

  /**
   * Resolves once this connection's snapshot is in — the host's state is
   * current — or the box is known to have no server to read. Waits through
   * a connection that is still coming up. Never rejects; callers bound it.
   */
  synced(): Promise<void> {
    if (this.disposed || this.inSync || this.client.state === "unsupported") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.syncWaiters.add(resolve);
    });
  }

  private releaseSyncWaiters(): void {
    for (const resolve of this.syncWaiters) resolve();
    this.syncWaiters.clear();
  }

  // ── reads, in the desktop's form; the cache's while the host is away ──

  /** The host's projects, `hostId` stamped. */
  projects(): ProjectInfo[] {
    return this.projectList.map((project) => toDesktop(this.hostId, project));
  }

  /** The host's agents, `hostId` stamped. */
  agents(): AgentInfo[] {
    return [...this.agentList.values()].map((agent) => toDesktop(this.hostId, agent));
  }

  /** The host's automation notifications, `hostId` stamped, newest first. */
  notifications(): NotificationRecord[] {
    return this.notificationList.map((record) => toDesktop(this.hostId, record));
  }

  /** The host's panes' last Agent statuses. */
  paneStatuses(): PaneAgentStatusUpdate[] {
    return [...this.paneStatusList.values()];
  }

  /** The host's layout, keyed `<hostId>:<path>`, with the desktop's claims. */
  layout(): Record<WorkspaceKey, LayoutEntry> {
    const out: Record<WorkspaceKey, LayoutEntry> = {};
    for (const [bare, entry] of Object.entries(this.workspaces)) {
      const key = keyFor(this.hostId, bare);
      if (key) out[key] = { ...entry, claims: this.claimsOf(key) };
    }
    return out;
  }

  /** The desktop's claims on `key`: a host server has no windows to hold one. */
  private claimsOf(key: WorkspaceKey): LayoutClaim[] {
    return this.opts.claimsFor?.(key) ?? [];
  }

  /** The host's last active workspace, as a key; null when it has none. */
  lastActiveWorkspace(): WorkspaceKey | null {
    return this.lastActive === null ? null : keyFor(this.hostId, this.lastActive);
  }

  // ── calls ──

  /**
   * `ns.method(...args)` on the host's server, with the arguments in the
   * host's form and the answer in the desktop's (see `toHostArgs` and
   * `toDesktopResult`). Rejects with `HostServerUnavailableError`, naming the
   * host by its alias, while the host is away.
   */
  async invoke(
    ns: string,
    methodName: string,
    args: unknown[],
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.away) {
      throw new HostServerUnavailableError(this.hostId, this.client.state, `${this.label} is offline`);
    }
    const result = await this.client.invoke(ns, methodName, toHostArgs(this.hostId, args), opts);
    return toDesktopResult(this.hostId, ns, methodName, result);
  }

  /**
   * Hear the host's `chat.<event>` at `key` (a pane id, or a `chatTaskKey`),
   * republished through `publishKeyed`. The host's mirror watches that pane
   * (or task) while this holds. Returns the release.
   */
  watchChat(event: HostChatEvent, key: string): () => void {
    return this.watchKeyed("chat", event, key);
  }

  /**
   * Hear the host's `pty.<event>` for `paneId`, republished through
   * `publishKeyed` at the pane. The host's `winsizeOwner` says
   * whether the desktop's owner channel owns the pane's grid, which is what
   * a caller viewing the pane through the desktop is told. Returns the
   * release.
   */
  watchPty(event: HostPtyEvent, paneId: string): () => void {
    return this.watchKeyed("pty", event, paneId);
  }

  /**
   * Tell the desktop's renderers a workspace's claims again: a
   * desktop window took or let go of one of its tabs, which the host never
   * hears of. At the version the proxy holds; nothing for one it lacks.
   */
  republishClaims(key: WorkspaceKey, origin: LayoutOrigin): void {
    const bare = parseWorkspaceKey(key);
    if (bare.hostId !== this.hostId) return;
    const entry = this.workspaces[bare.path];
    if (!entry || this.disposed) return;
    this.publishLayout({
      workspacePath: bare.path,
      version: entry.version,
      layout: entry.layout,
      claims: [],
      origin,
    });
  }

  private watchKeyed(
    ns: "chat" | "pty",
    event: HostChatEvent | HostPtyEvent,
    key: string,
  ): () => void {
    // A keyed listener hears only frames sent at its key.
    const release = this.client.subscribe(ns, event, key, (...args) => {
      if (!this.disposed) this.opts.publishKeyed?.(ns, event, args, key);
    });
    this.releases.push(release);
    return () => {
      const at = this.releases.indexOf(release);
      if (at >= 0) this.releases.splice(at, 1);
      release();
    };
  }

  /**
   * Read the host's projects again now, for a caller that just changed one
   * and reads next: the host's `projects.changed` would get there too, a
   * moment later. Never rejects.
   */
  async refreshProjects(): Promise<void> {
    if (this.disposed || this.away) return;
    await this.readProjects();
  }

  /**
   * Take a workspace selection the desktop just sent the host into the
   * cached list, quietly: a selection is not worth reading every project
   * on the box back for.
   */
  noteSelectedWorkspace(projectId: string, workspaceIndex: number): void {
    const project = this.projectList.find((p) => p.id === projectId);
    if (!project || project.selectedWorkspaceIndex === workspaceIndex) return;
    project.selectedWorkspaceIndex = workspaceIndex;
    this.saveSoon();
  }

  /**
   * The host was removed from Manor: tell every renderer each of its
   * workspaces is gone, as `publishLayoutDiff` does for one the host itself
   * dropped, so no tab keeps pointing at a host that no longer exists. Then
   * let go. Not for a replace, whose new proxy publishes the same
   * workspaces again: the renderers would only drop and re-adopt them.
   */
  forget(): void {
    if (this.disposed) return;
    for (const [bare, was] of Object.entries(this.workspaces)) {
      this.layoutMoved(bare, was.layout, null);
      this.publishLayout({
        workspacePath: bare,
        version: was.version,
        layout: was.layout,
        claims: [],
        origin: proxyOrigin(this.hostId),
        removed: true,
      });
    }
    // Its log leaves the bell with it.
    if (this.notificationList.length > 0) {
      this.notificationList = [];
      this.opts.onNotificationsChanged?.();
    }
    this.dispose();
  }

  /** Let go: stop listening and write the cache now. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of this.releases.splice(0)) release();
    this.releaseSyncWaiters();
    this.flush();
  }

  /** Write a pending cache save now. */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saveCache();
  }

  // ── the host's state ──

  /** Read everything; on success the cache, `ready` and the desktop follow. */
  private async snapshot(): Promise<void> {
    const generation = ++this.snapshotGeneration;
    const current = () => !this.disposed && generation === this.snapshotGeneration;
    const before = { ...this.workspaces };
    let read: [
      ProjectInfo[],
      Record<string, LayoutEntry>,
      string | null,
      AgentInfo[],
      PaneAgentStatusUpdate[],
      { responded: string[]; requires_input: string[] },
    ];
    this.startLayoutRead();
    try {
      read = await Promise.all([
        this.client.invoke("projects", "getAll", []) as Promise<ProjectInfo[]>,
        this.client.invoke("layout", "getAll", []) as Promise<Record<string, LayoutEntry>>,
        this.client.invoke("layout", "getLastActive", []) as Promise<string | null>,
        this.client.invoke("agents", "getAll", []) as Promise<AgentInfo[]>,
        this.client.invoke("agents", "getPaneStatuses", []) as Promise<PaneAgentStatusUpdate[]>,
        this.client.invoke("agents", "getUnseen", []) as Promise<{
          responded: string[];
          requires_input: string[];
        }>,
      ]);
    } catch (err) {
      // The channel dropped mid-read; the next `connected` reads again.
      if (current()) {
        this.log.warn(`[host-proxy] reading ${this.hostId}'s state failed: ${errorMessage(err)}`);
      }
      return;
    } finally {
      this.endLayoutRead();
    }
    if (!current()) return;
    const [projects, layout, lastActive, agents, paneStatuses, unseenRead] = read;
    const agentsBefore = new Map(this.agentList);
    this.projectList = Array.isArray(projects) ? projects : [];
    this.applyLayoutRead(isPlainObject(layout) ? layout : {});
    this.lastActive = typeof lastActive === "string" ? lastActive : null;
    this.applyAgentRead(Array.isArray(agents) ? agents : []);
    this.applyPaneStatusRead(Array.isArray(paneStatuses) ? paneStatuses : []);
    this.saveSoon();
    this.inSync = true;
    this.resolveReady();
    this.releaseSyncWaiters();
    this.opts.bus.publish("projects", "changed");
    this.publishLayoutDiff(before);
    this.publishAgentDiff(agentsBefore, unseenRead);
    void this.readNotifications(current);
  }

  /**
   * The host's log, read apart from the snapshot: a host server older
   * than the host logs answers `unavailable:host`, which must not cost the
   * rest of the snapshot.
   */
  private async readNotifications(current: () => boolean): Promise<void> {
    let list: unknown;
    try {
      list = await this.client.invoke("notifications", "getAll", []);
    } catch {
      return;
    }
    if (current() && Array.isArray(list)) this.applyNotifications(list);
  }

  private applyNotifications(list: unknown[]): void {
    this.notificationList = list.filter(
      (record): record is NotificationRecord =>
        isPlainObject(record) &&
        typeof record.id === "string" &&
        typeof record.kind === "string" &&
        HOST_LOG_KINDS.has(record.kind as NotificationRecord["kind"]),
    );
    this.opts.onNotificationsChanged?.();
  }

  private startLayoutRead(): void {
    if (this.layoutReads++ === 0) this.removedDuringRead.clear();
  }

  /** Called before the read is applied, so its removals still count. */
  private endLayoutRead(): void {
    this.layoutReads--;
  }

  /**
   * The read's layout, except where an event that arrived while it was in
   * flight is newer: an entry at a later version, or a workspace removed.
   */
  private applyLayoutRead(read: Record<string, LayoutEntry>): void {
    const next: Record<string, LayoutEntry> = {};
    for (const [bare, entry] of Object.entries(read)) {
      const removedAt = this.removedDuringRead.get(bare);
      if (removedAt !== undefined && removedAt >= entry.version) continue;
      const live = this.workspaces[bare];
      next[bare] = live && live.version > entry.version ? live : entry;
    }
    this.workspaces = next;
    if (this.layoutReads === 0) this.removedDuringRead.clear();
  }

  /** The read's agents, except one updated by an event since. */
  private applyAgentRead(read: AgentInfo[]): void {
    const next = new Map<string, AgentInfo>();
    for (const agent of read) {
      const live = this.agentList.get(agent.id);
      next.set(agent.id, live && live.updatedAt > agent.updatedAt ? live : agent);
    }
    this.agentList = next;
  }

  /**
   * After a snapshot, what moved while the desktop was not hearing: each agent
   * new or changed since `before` goes to the bus, and each one whose status
   * moved to `onAgentUpdate`. The host's unseen flags come with them.
   */
  private publishAgentDiff(
    before: ReadonlyMap<string, AgentInfo>,
    unseenRead: { responded: string[]; requires_input: string[] } | undefined,
  ): void {
    const responded = new Set(Array.isArray(unseenRead?.responded) ? unseenRead.responded : []);
    const input = new Set(Array.isArray(unseenRead?.requires_input) ? unseenRead.requires_input : []);
    this.opts.onUnseenRead?.([...this.agentList.keys()], {
      responded: [...responded],
      requires_input: [...input],
    });
    for (const agent of this.agentList.values()) {
      const was = before.get(agent.id);
      if (was && was.updatedAt === agent.updatedAt) continue;
      const desktop = toDesktop(this.hostId, agent);
      const flags = { responded: responded.has(agent.id), requires_input: input.has(agent.id) };
      if (this.opts.republishAgents) this.opts.bus.publish("agents", "updated", desktop, flags);
      if (was && was.lastAgentStatus !== agent.lastAgentStatus) {
        this.opts.onAgentUpdate?.(desktop, flags, toDesktop(this.hostId, was));
      }
    }
  }

  /**
   * The read's pane statuses, published for each that differs from what was
   * held: statuses set while the desktop was not hearing reach renderers now.
   */
  private applyPaneStatusRead(read: PaneAgentStatusUpdate[]): void {
    const next = new Map<string, PaneAgentStatusUpdate>();
    for (const update of read) {
      if (!isPlainObject(update) || typeof update.paneId !== "string") continue;
      next.set(update.paneId, update);
      if (
        this.opts.republishAgents &&
        JSON.stringify(this.paneStatusList.get(update.paneId)) !== JSON.stringify(update)
      ) {
        this.opts.bus.publish("agents", "status", update);
      }
    }
    this.paneStatusList = next;
  }

  /**
   * After a snapshot, a `layout.changed` for each workspace that moved while
   * the desktop was not hearing, and a removal for each one that went.
   */
  private publishLayoutDiff(before: Record<string, LayoutEntry>): void {
    for (const [bare, entry] of Object.entries(this.workspaces)) {
      const was = before[bare];
      if (was && was.version === entry.version) continue;
      this.layoutMoved(bare, was?.layout, entry.layout);
      this.publishLayout({
        workspacePath: bare,
        version: entry.version,
        layout: entry.layout,
        claims: entry.claims ?? [],
        origin: proxyOrigin(this.hostId),
      });
    }
    for (const [bare, was] of Object.entries(before)) {
      if (this.workspaces[bare]) continue;
      this.layoutMoved(bare, was.layout, null);
      this.publishLayout({
        workspacePath: bare,
        version: was.version,
        layout: was.layout,
        claims: [],
        origin: proxyOrigin(this.hostId),
        removed: true,
      });
    }
  }

  private onProjectsChanged(): void {
    if (!this.disposed) this.rereadProjects();
  }

  private async readProjects(): Promise<void> {
    let projects: unknown;
    try {
      projects = await this.client.invoke("projects", "getAll", []);
    } catch (err) {
      // The channel dropped; the snapshot on reconnect reads them again.
      this.log.warn(`[host-proxy] re-reading ${this.hostId}'s projects failed: ${errorMessage(err)}`);
      return;
    }
    if (this.disposed || !Array.isArray(projects)) return;
    this.projectList = projects as ProjectInfo[];
    this.saveSoon();
    this.opts.bus.publish("projects", "changed");
  }

  /** The layout again, quietly: its events were published as they came. */
  private async readLayout(): Promise<void> {
    let layout: unknown;
    this.startLayoutRead();
    try {
      layout = await this.client.invoke("layout", "getAll", []);
    } catch (err) {
      this.log.warn(`[host-proxy] re-reading ${this.hostId}'s layout failed: ${errorMessage(err)}`);
      return;
    } finally {
      this.endLayoutRead();
    }
    if (this.disposed || !isPlainObject(layout)) return;
    this.applyLayoutRead(layout as Record<string, LayoutEntry>);
    this.saveSoon();
  }

  /**
   * One workspace's new layout. A broadcast carries the tree and claims but
   * not the default viewport or pane sessions, so a workspace this has no
   * entry for yet is read whole (`rereadLayout`); the event is passed on at
   * once either way.
   */
  private onLayoutChanged(payload: LayoutBroadcast): void {
    if (this.disposed || !isPlainObject(payload)) return;
    const bare = payload.workspacePath;
    if (typeof bare !== "string") return;
    const live = this.workspaces[bare];
    if (payload.removed) {
      this.layoutMoved(bare, live?.layout, null);
      delete this.workspaces[bare];
      if (this.layoutReads > 0) {
        this.removedDuringRead.set(
          bare,
          Math.max(payload.version, this.removedDuringRead.get(bare) ?? -1),
        );
      }
      this.saveSoon();
    } else if (live) {
      // Claims move at the same version, so only an older one is stale.
      if (live.version > payload.version) return;
      this.layoutMoved(bare, live.layout, payload.layout);
      this.workspaces[bare] = {
        ...live,
        version: payload.version,
        layout: payload.layout,
        paneSessions: { ...live.paneSessions, ...payload.restored },
        claims: payload.claims ?? [],
      };
      this.saveSoon();
    } else {
      this.rereadLayout();
    }
    this.publishLayout(payload);
  }

  private onAgentUpdated(
    agent: AgentInfo,
    unseen: EventArgs<"agents", "updated">[1],
  ): void {
    if (this.disposed || !isPlainObject(agent) || typeof agent.id !== "string") return;
    const previous = this.agentList.get(agent.id);
    this.agentList.set(agent.id, agent);
    this.saveSoon();
    const desktop = toDesktop(this.hostId, agent);
    if (this.opts.republishAgents) this.opts.bus.publish("agents", "updated", desktop, unseen);
    this.opts.onAgentUpdate?.(desktop, unseen, previous && toDesktop(this.hostId, previous));
  }

  private layoutMoved(
    bare: string,
    before: WorkspaceLayout | undefined,
    after: WorkspaceLayout | null,
  ): void {
    const key = keyFor(this.hostId, bare);
    if (key) this.opts.onLayoutMoved?.(key, before, after);
  }

  private publishLayout(payload: LayoutBroadcast): void {
    const key = keyFor(this.hostId, payload.workspacePath);
    if (!key) return;
    const claims = payload.removed ? [] : this.claimsOf(key);
    this.opts.bus.publish("layout", "changed", { ...payload, workspacePath: key, claims });
  }

  // ── the cache ──

  private loadCache(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.opts.cacheFile, "utf-8");
    } catch {
      return; // None yet.
    }
    try {
      const cache = JSON.parse(raw) as Partial<HostCache>;
      if (cache.version !== CACHE_VERSION || cache.hostId !== this.hostId) return;
      this.projectList = Array.isArray(cache.projects) ? cache.projects : [];
      this.agentList = new Map(
        (Array.isArray(cache.agents) ? cache.agents : []).map((agent) => [agent.id, agent]),
      );
      const layout = isPlainObject(cache.layout) ? cache.layout : null;
      this.workspaces = isPlainObject(layout?.workspaces)
        ? (layout.workspaces as Record<string, LayoutEntry>)
        : {};
      this.lastActive =
        typeof layout?.lastActiveWorkspacePath === "string" ? layout.lastActiveWorkspacePath : null;
    } catch (err) {
      this.log.warn(`[host-proxy] ignoring ${this.hostId}'s unreadable cache: ${errorMessage(err)}`);
    }
  }

  private saveSoon(): void {
    if (this.disposed || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveCache();
    }, this.opts.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private saveCache(): void {
    const workspaces: Record<string, LayoutEntry> = {};
    for (const [bare, entry] of Object.entries(this.workspaces)) {
      workspaces[bare] = { ...entry, claims: [] };
    }
    const cache: HostCache = {
      version: CACHE_VERSION,
      hostId: this.hostId,
      savedAt: new Date().toISOString(),
      projects: this.projectList,
      agents: [...this.agentList.values()],
      layout: { workspaces, lastActiveWorkspacePath: this.lastActive },
    };
    try {
      writeFileAtomic(this.opts.cacheFile, JSON.stringify(cache), { mode: 0o600, dirMode: 0o700 });
    } catch (err) {
      this.log.warn(`[host-proxy] writing ${this.hostId}'s cache failed: ${errorMessage(err)}`);
    }
  }
}

/**
 * `run`, never twice at once: a call while it runs owes exactly one more run
 * after it, however many calls there were.
 */
function coalesced(run: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  const go = (): void => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void run().finally(() => {
      running = false;
      if (again) {
        again = false;
        go();
      }
    });
  };
  return go;
}
