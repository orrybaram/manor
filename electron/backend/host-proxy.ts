/**
 * HostProxy — the desktop's view of one remote host's state, as that host's
 * server holds it (ADR-227 D4). One per remote host, owned beside its
 * `HostServerClient` by `RemoteHostConnection`.
 *
 * - **Snapshot.** Whenever the owner channel comes up it reads the host's
 *   `projects.getAll`, `layout.getAll`, `layout.getLastActive` and
 *   `agents.getAll`. `ready` resolves at the first one.
 * - **Events.** It listens to the host's `projects.changed`,
 *   `layout.changed` and `agents.updated` (the client re-sends the
 *   subscriptions on every reconnect) and republishes them into the
 *   desktop's bus. `projects.changed` carries nothing, so it re-reads the
 *   projects first and the desktop hears it once they are in.
 * - **Chat** is keyed by pane (or task), and the host's mirror only watches a
 *   pane somebody subscribed to at exactly that key. So chat is not heard by
 *   default: `watchChat(event, key)` forwards one subscription to the host
 *   and republishes what comes back through `publishKeyed`, at the same key.
 *   Pane ids are the same on both sides, so nothing in it is rewritten.
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
 * **Agents republish only when asked** (`republishAgents`). Until the desktop
 * stops replaying a remote host's hook journal into its own agent store
 * (ADR-227 ticket 9), it already publishes an `agents.updated` for every
 * remote agent; the host's would be a second copy. The proxy's own list is
 * kept either way.
 */

import fs from "node:fs";
import { writeFileAtomic } from "../lib/fs-atomic";
import { errorMessage } from "../lib/errors";
import type { AgentInfo } from "../agent-persistence";
import type { ProjectInfo } from "../projects/types";
import type { BroadcastBus } from "../renderer-broadcast";
import type { EventArgs } from "../bridge/events";
import type { LayoutBroadcast, LayoutEntry } from "../../src/lib/layout/protocol";
import {
  parseWorkspaceKey,
  workspaceKey,
  type WorkspaceKey,
} from "../../src/lib/workspace-key";
import {
  HostServerUnavailableError,
  type HostServerClient,
} from "./host-server-client";
import { LOCAL_HOST_ID } from "./types";

/** What the proxy needs of its host's owner channel. */
export type HostProxyChannel = Pick<
  HostServerClient,
  "hostId" | "state" | "invoke" | "subscribe" | "onStateChange"
>;

/** The keyed chat events `watchChat` forwards. */
export type HostChatEvent = "entry" | "taskEntry";

export interface HostProxyOptions {
  client: HostProxyChannel;
  /** The desktop's bus: what renderers and paired devices hear. */
  bus: Pick<BroadcastBus, "publish">;
  /** The desktop's name for the host (`HostRecords.label`), read at use. */
  label: () => string;
  /** Where the offline cache lives (`hostCacheFile(hostId)`). */
  cacheFile: string;
  /**
   * Republish the host's `agents.updated`. Off until the desktop no longer
   * produces its own copy for remote agents (see the header).
   */
  republishAgents?: boolean;
  /**
   * Where a forwarded chat event goes, at its key: the desktop's
   * `BridgeServer.publish`, since the bus carries no key. Without it,
   * `watchChat` hears nothing.
   */
  publishKeyed?: (ns: "chat", event: HostChatEvent, args: unknown[], key: string) => void;
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

  // The host's state, in its own form (bare paths, `hostId: "local"`).
  private projectList: ProjectInfo[] = [];
  private agentList = new Map<string, AgentInfo>();
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
      client.subscribe("agents", "updated", undefined, (agent, unseen) =>
        this.onAgentUpdated(
          agent as AgentInfo,
          unseen as EventArgs<"agents", "updated">[1],
        ),
      ),
      client.onStateChange((state) => {
        if (state === "connected") void this.snapshot();
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

  // ── reads, in the desktop's form; the cache's while the host is away ──

  /** The host's projects, `hostId` stamped. */
  projects(): ProjectInfo[] {
    return this.projectList.map((project) => this.toDesktop(project));
  }

  /** The host's agents, `hostId` stamped. */
  agents(): AgentInfo[] {
    return [...this.agentList.values()].map((agent) => this.toDesktop(agent));
  }

  /** The host's layout, keyed `<hostId>:<path>`. */
  layout(): Record<WorkspaceKey, LayoutEntry> {
    const out: Record<WorkspaceKey, LayoutEntry> = {};
    for (const [bare, entry] of Object.entries(this.workspaces)) {
      const key = this.keyFor(bare);
      if (key) out[key] = entry;
    }
    return out;
  }

  /** The host's last active workspace, as a key; null when it has none. */
  lastActiveWorkspace(): WorkspaceKey | null {
    return this.lastActive === null ? null : this.keyFor(this.lastActive);
  }

  // ── calls ──

  /**
   * `ns.method(...args)` on the host's server, with the arguments in the
   * host's form and the answer in the desktop's (see `toHostArgs` and
   * `toDesktopResult`). Rejects with `HostServerUnavailableError`, naming the
   * host by its alias, while the host is away.
   */
  async invoke(ns: string, methodName: string, args: unknown[]): Promise<unknown> {
    if (this.away) {
      throw new HostServerUnavailableError(this.hostId, this.client.state, `${this.label} is offline`);
    }
    const result = await this.client.invoke(ns, methodName, this.toHostArgs(args));
    return this.toDesktopResult(ns, methodName, result);
  }

  /**
   * Hear the host's `chat.<event>` at `key` (a pane id, or a `chatTaskKey`),
   * republished through `publishKeyed`. The host's mirror watches that pane
   * (or task) while this holds. Returns the release.
   */
  watchChat(event: HostChatEvent, key: string): () => void {
    // A keyed listener hears only frames sent at its key.
    const release = this.client.subscribe("chat", event, key, (...args) => {
      if (!this.disposed) this.opts.publishKeyed?.("chat", event, args, key);
    });
    this.releases.push(release);
    return release;
  }

  /** Let go: stop listening and write the cache now. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of this.releases.splice(0)) release();
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
    let read: [ProjectInfo[], Record<string, LayoutEntry>, string | null, AgentInfo[]];
    this.startLayoutRead();
    try {
      read = await Promise.all([
        this.client.invoke("projects", "getAll", []) as Promise<ProjectInfo[]>,
        this.client.invoke("layout", "getAll", []) as Promise<Record<string, LayoutEntry>>,
        this.client.invoke("layout", "getLastActive", []) as Promise<string | null>,
        this.client.invoke("agents", "getAll", []) as Promise<AgentInfo[]>,
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
    const [projects, layout, lastActive, agents] = read;
    this.projectList = Array.isArray(projects) ? projects : [];
    this.applyLayoutRead(isPlainObject(layout) ? layout : {});
    this.lastActive = typeof lastActive === "string" ? lastActive : null;
    this.applyAgentRead(Array.isArray(agents) ? agents : []);
    this.saveSoon();
    this.resolveReady();
    this.opts.bus.publish("projects", "changed");
    this.publishLayoutDiff(before);
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
   * After a snapshot, a `layout.changed` for each workspace that moved while
   * the desktop was not hearing, and a removal for each one that went.
   */
  private publishLayoutDiff(before: Record<string, LayoutEntry>): void {
    for (const [bare, entry] of Object.entries(this.workspaces)) {
      const was = before[bare];
      if (was && was.version === entry.version) continue;
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
    this.agentList.set(agent.id, agent);
    this.saveSoon();
    if (this.opts.republishAgents) {
      this.opts.bus.publish("agents", "updated", this.toDesktop(agent), unseen);
    }
  }

  private publishLayout(payload: LayoutBroadcast): void {
    const key = this.keyFor(payload.workspacePath);
    if (!key) return;
    this.opts.bus.publish("layout", "changed", { ...payload, workspacePath: key });
  }

  // ── rewriting ──

  /**
   * A bare path on the host as the desktop's key for it. Null for one that
   * cannot be keyed (not POSIX-absolute), which the desktop never sees.
   */
  private keyFor(bare: string): WorkspaceKey | null {
    try {
      return workspaceKey(this.hostId, bare);
    } catch {
      return null;
    }
  }

  /** A record with the host's `local` as this host's id. */
  private toDesktop<T>(value: T): T {
    if (isPlainObject(value) && value.hostId === LOCAL_HOST_ID) {
      return { ...value, hostId: this.hostId };
    }
    return value;
  }

  /**
   * The desktop's arguments in the host's form: a string that is one of
   * this host's keys becomes its bare path, and this host's id becomes
   * `local` — at the top level and one level into a plain object (a
   * command's `workspacePath`, a context's `hostId`). Host ids are UUIDs, so
   * a string that merely looks like `<hostId>:/path` is not a worry.
   */
  private toHostArgs(args: unknown[]): unknown[] {
    const value = (v: unknown): unknown => {
      if (typeof v !== "string") return v;
      if (v === this.hostId) return LOCAL_HOST_ID;
      const parsed = parseWorkspaceKey(v);
      return parsed.hostId === this.hostId ? parsed.path : v;
    };
    return args.map((arg) => {
      if (!isPlainObject(arg)) return value(arg);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(arg)) out[k] = value(v);
      return out;
    });
  }

  /**
   * The host's answer in the desktop's form: `layout.getAll` rekeyed,
   * `layout.getLastActive` keyed, and anything else with `hostId: "local"`
   * stamped — a record, or each record of a list.
   */
  private toDesktopResult(ns: string, methodName: string, result: unknown): unknown {
    if (ns === "layout" && methodName === "getAll" && isPlainObject(result)) {
      const out: Record<string, unknown> = {};
      for (const [bare, entry] of Object.entries(result)) {
        const key = this.keyFor(bare);
        if (key) out[key] = entry;
      }
      return out;
    }
    if (ns === "layout" && methodName === "getLastActive") {
      return typeof result === "string" ? this.keyFor(result) : result;
    }
    if (Array.isArray(result)) return result.map((item) => this.toDesktop(item));
    return this.toDesktop(result);
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
