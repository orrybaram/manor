/**
 * BackendRegistry — every host Manor runs workspaces on, keyed by hostId
 * (ADR-160 §6).
 *
 * `"local"` is always present and is this machine's backend
 * (`createLocalBackend`); remote hosts are registered from their persisted `HostSpec` and
 * connected lazily, in the background, never on the launch path.
 *
 * Each host is a `HostConnection` (status, connecting, hook feed, reconnect
 * handling — `host-connection.ts`), and `get(hostId)` hands out its view
 * (gated for a remote host — `host-view.ts`). The registry keeps the hosts,
 * which host owns each session (`SessionOwners`), and the listeners every
 * host's events fan out to.
 *
 * A remote host is built from its spec in two steps (ADR-178 §1): a
 * `HostProvider` (how the box is started and reached), then a backend riding
 * the provider's transport.
 */

import { Emitter } from "./emitter";
import { memoryHookSeqStore, type HookSeqStore, type HookSink } from "./hook-feed";
import {
  HostConnection,
  RemoteHostConnection,
  type ControlRelaySink,
  type HostProxyContext,
  type HostStatus,
  type HostStatusInfo,
  type RemoteHostContext,
} from "./host-connection";
import type { HostProxy } from "./host-proxy";
import type { HostServerClient, HostServerClientState } from "./host-server-client";
import { HostUnavailableError, unavailableBackend } from "./host-view";
import { createProvider } from "./providers";
import type { HostProvider } from "./providers/types";
import { RemoteBackend } from "./remote-backend";
import type { BootstrapProgress } from "./remote-bootstrap";
import { SessionOwners } from "./session-owners";
import {
  LOCAL_HOST_ID,
  type HostConnectionEvent,
  type HostSpec,
  type RemoteHostBackend,
  type StreamEvent,
  type WorkspaceBackend,
} from "./types";

export type { ControlRelaySink, HostStatus, HostStatusInfo } from "./host-connection";
export { HostUnavailableError } from "./host-view";
export { isRemoteSessionLoss } from "./session-owners";

/** Builds a remote host's provider from its spec. */
export type HostProviderFactory = (
  hostId: string,
  spec: HostSpec,
  opts: { onBootstrapProgress: (progress: BootstrapProgress) => void },
) => HostProvider;

export type RemoteBackendFactory = (
  hostId: string,
  spec: HostSpec,
  opts: {
    version: string;
    /** The host's provider; the backend rides `provider.transport()`. */
    provider: HostProvider;
    onBootstrapWarning: (warnings: string[]) => void;
    /** The host's daemon is about to be replaced (ADR-185 §A). */
    onDaemonReplacing: (sessionIds: string[]) => void;
  },
) => RemoteHostBackend;

const defaultCreateProvider: HostProviderFactory = (_hostId, spec, opts) =>
  createProvider(spec, opts);

/** A `RemoteBackend` over the provider's transport. */
const createRemoteBackend: RemoteBackendFactory = (_hostId, spec, opts) =>
  new RemoteBackend({
    target: spec.target,
    version: opts.version,
    transport: opts.provider.transport(),
    onBootstrapWarning: opts.onBootstrapWarning,
    onDaemonReplacing: opts.onDaemonReplacing,
  });

export interface BackendRegistryOptions {
  /**
   * The backend for this machine, built with the app version its daemon is
   * handshaken against.
   */
  local: WorkspaceBackend;
  /**
   * Manor's own version for remote hosts: it names the manor-host package
   * bootstrap installs and is what the remote daemon reports back. In an
   * unpackaged app this differs from the local daemon's (Electron's
   * version). Handed to each remote backend's constructor.
   */
  remoteVersion: string;
  /** Builds a remote host's backend. Defaults to `RemoteBackend`. For tests. */
  createRemote?: RemoteBackendFactory;
  /** Builds a remote host's provider. Defaults to `createProvider`. For tests. */
  createProvider?: HostProviderFactory;
  /** Each remote host's last ingested hook seq. Defaults to in-memory. */
  hookSeqStore?: HookSeqStore;
  /** Retry delay for a failed hook replay (see `HostHookFeed`). For tests. */
  hookReplayRetryDelayMs?: (attempt: number) => number;
  /** Timeouts and retry delays for each host's `HostServerClient`. For tests. */
  hostServerClient?: RemoteHostContext["hostServerClient"];
  /**
   * Gives every remote host a `HostProxy` publishing here (ADR-227 D4). The
   * desktop passes its bus; without it (a host server, most tests) there
   * are none, and nothing is cached.
   */
  hostProxy?: HostProxyContext;
}

const LOG = "[backend-registry]";

export class BackendRegistry {
  /** Which host owns each session we have seen created, listed or streaming. */
  readonly sessions = new SessionOwners();
  private readonly hosts = new Map<string, HostConnection>();
  private readonly unknownViews = new Map<string, WorkspaceBackend>();
  private readonly streamEvents = new Emitter<[string, StreamEvent]>(`${LOG} stream event listener`);
  private readonly hostEvents = new Emitter<[string, HostConnectionEvent]>(`${LOG} host event listener`);
  private readonly resumed = new Emitter<[string, string[]]>(`${LOG} host resumed listener`);
  private readonly daemonReplacing = new Emitter<[string, string[]]>(
    `${LOG} daemon replacing listener`,
  );
  private readonly statusChanges = new Emitter<[HostStatusInfo[]]>(`${LOG} status listener`);
  private readonly createRemote: RemoteBackendFactory;
  private readonly createProvider: HostProviderFactory;
  private readonly remoteVersion: string;
  /** What every remote host's connection reports to. */
  private readonly ctx: RemoteHostContext;
  private hookSink: HookSink | null = null;
  private controlRelaySink: ControlRelaySink | null = null;
  private readonly serverStates = new Emitter<[string, HostServerClientState]>(
    `${LOG} host server state listener`,
  );

  constructor(opts: BackendRegistryOptions) {
    this.remoteVersion = opts.remoteVersion;
    this.createRemote = opts.createRemote ?? createRemoteBackend;
    this.createProvider = opts.createProvider ?? defaultCreateProvider;
    this.ctx = {
      sessions: this.sessions,
      streamEvents: this.streamEvents,
      statusChanged: () => this.emitStatus(),
      hostEvents: this.hostEvents,
      resumed: this.resumed,
      daemonReplacing: this.daemonReplacing,
      hookSeqStore: opts.hookSeqStore ?? memoryHookSeqStore(),
      hookSink: () => this.hookSink,
      hookReplayRetryDelayMs: opts.hookReplayRetryDelayMs,
      controlRelaySink: () => this.controlRelaySink,
      hostServerClient: opts.hostServerClient,
      hostProxy: opts.hostProxy,
    };
    this.add(new HostConnection(LOCAL_HOST_ID, null, opts.local, this.ctx));
  }

  // ── Hosts ──

  /**
   * The backend for `hostId`. Local: the local backend itself. Remote: a
   * gated view (see `host-view.ts`). Unregistered: a backend whose every
   * call fails with `HostUnavailableError`, so a project pointing at a host
   * that was removed degrades instead of throwing synchronously.
   */
  get(hostId: string): WorkspaceBackend {
    const conn = this.hosts.get(hostId);
    if (conn) return conn.view;
    let view = this.unknownViews.get(hostId);
    if (!view) {
      view = unavailableBackend(hostId);
      this.unknownViews.set(hostId, view);
    }
    return view;
  }

  has(hostId: string): boolean {
    return this.hosts.has(hostId);
  }

  /** A remote host's provider; undefined for the local host or an unknown one. */
  provider(hostId: string): HostProvider | undefined {
    const conn = this.hosts.get(hostId);
    return conn instanceof RemoteHostConnection ? conn.provider : undefined;
  }

  /**
   * Add a remote host. Registering the same spec again is a no-op; a
   * different spec replaces the host (the old connection is dropped).
   * Does not connect.
   */
  register(hostId: string, spec: HostSpec): void {
    if (hostId === LOCAL_HOST_ID) {
      throw new Error(`"${LOCAL_HOST_ID}" is reserved for this machine`);
    }
    const existing = this.hosts.get(hostId);
    if (existing && JSON.stringify(existing.spec) === JSON.stringify(spec)) return;
    // The provider and backend report through the connection built from
    // them, which does not exist yet when they are made.
    const built: { conn?: RemoteHostConnection } = {};
    const provider = this.createProvider(hostId, spec, {
      onBootstrapProgress: (progress) => built.conn?.reportProgress(progress.message),
    });
    const backend = this.createRemote(hostId, spec, {
      version: this.remoteVersion,
      provider,
      onBootstrapWarning: (warnings) => built.conn?.reportWarnings(warnings),
      onDaemonReplacing: (sessionIds) => built.conn?.reportDaemonReplacing(sessionIds),
    });
    built.conn = new RemoteHostConnection(hostId, spec, provider, backend, this.ctx);
    built.conn.serverClient.onStateChange((state) => this.serverStates.emit(hostId, state));
    this.add(built.conn);
    if (existing) void existing.dispose();
  }

  /** Remove a remote host and drop its connection. */
  async unregister(hostId: string): Promise<void> {
    if (hostId === LOCAL_HOST_ID) {
      throw new Error(`"${LOCAL_HOST_ID}" cannot be unregistered`);
    }
    const conn = this.hosts.get(hostId);
    if (!conn) return;
    this.hosts.delete(hostId);
    this.emitStatus();
    await conn.dispose();
  }

  /** Every host and its connection status, local first. */
  list(): HostStatusInfo[] {
    return Array.from(this.hosts.values(), (conn) => conn.info());
  }

  /**
   * How the user names a remote host: its ssh target, as the sidebar does.
   * Undefined for the local host and unknown ids.
   */
  hostDisplayName(hostId: string): string | undefined {
    if (hostId === LOCAL_HOST_ID) return undefined;
    const target = this.hosts.get(hostId)?.info().spec?.target;
    return target || undefined;
  }

  status(hostId: string): HostStatus | undefined {
    return this.hosts.get(hostId)?.status;
  }

  /** Registered remote host ids, in registration order. */
  remoteHostIds(): string[] {
    return Array.from(this.hosts.keys()).filter((id) => id !== LOCAL_HOST_ID);
  }

  // ── Connecting ──

  /**
   * Connect `hostId` if it is not already. Concurrent callers share one
   * attempt. Rejects with the connect error, which `list()` also reports.
   * Always tries — including after `error` — so this is the retry.
   */
  async ensureConnected(hostId: string): Promise<void> {
    const conn = this.hosts.get(hostId);
    if (!conn) throw new HostUnavailableError(hostId, "unknown");
    return conn.ensureConnected();
  }

  /**
   * The user's "Retry now". A host its backend is already reconnecting
   * attempts at once instead of waiting out the backoff; any other host that
   * is not connected gets a fresh `connect()` (`connectInBackground`).
   */
  retryNow(hostId: string): void {
    const conn = this.hosts.get(hostId);
    if (conn) conn.retryNow();
    else this.connectInBackground(hostId);
  }

  /** `ensureConnected` without waiting; failures land in `list()`. */
  connectInBackground(hostId: string): void {
    this.ensureConnected(hostId).catch(() => {
      // Reported through status.
    });
  }

  /**
   * Check every remote host is still there (ADR-188 §3) — called on the
   * machine waking from sleep or unlocking, when a connection may be up but
   * wedged, or a reconnect may be sitting mid-backoff on a delay that did not
   * advance while asleep.
   */
  checkRemoteHosts(): void {
    for (const conn of this.hosts.values()) {
      if (conn instanceof RemoteHostConnection) conn.checkLiveness();
    }
  }

  /** Drop a remote host's connection. Its remote sessions keep running. */
  async disconnect(hostId: string): Promise<void> {
    await this.hosts.get(hostId)?.disconnect();
  }

  /** Drop every remote connection (app quit), owner channels included. */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled(this.remoteHostIds().map((id) => this.disconnect(id)));
  }

  // ── Host servers (ADR-225 D4) ──

  /**
   * `hostId`'s owner channel to its host server: one per remote host, on its
   * `RemoteHostConnection`. It connects whenever the host does and lets go
   * when the host drops; `state` says whether the box has a host server at
   * all. Undefined for the local host or an unknown one.
   */
  hostServer(hostId: string): HostServerClient | undefined {
    const conn = this.hosts.get(hostId);
    return conn instanceof RemoteHostConnection ? conn.serverClient : undefined;
  }

  /**
   * `hostId`'s state as its host server holds it (ADR-227 D4): reads that
   * answer from the cache while it is away, and calls in the desktop's
   * form. Undefined for the local host, an unknown one, or a registry built
   * without `hostProxy`.
   */
  hostProxy(hostId: string): HostProxy | undefined {
    const conn = this.hosts.get(hostId);
    return conn instanceof RemoteHostConnection ? (conn.proxy ?? undefined) : undefined;
  }

  /** Every remote host's owner channel, in registration order. */
  hostServers(): HostServerClient[] {
    const clients: HostServerClient[] = [];
    for (const conn of this.hosts.values()) {
      if (conn instanceof RemoteHostConnection) clients.push(conn.serverClient);
    }
    return clients;
  }

  /**
   * Told whenever any host's owner channel changes state — `connected` after
   * every (re)connect, which is when the desktop re-sends what the server
   * holds (`host-server-sync.ts`). Returns the unsubscribe.
   */
  onHostServerStateChange(
    listener: (hostId: string, state: HostServerClientState) => void,
  ): () => void {
    return this.serverStates.on(listener);
  }

  // ── Events ──

  /**
   * Where remote hosts' agent hooks go (ADR-178 §2). Hosts already connected
   * catch up from their journals now; the rest do on connect.
   */
  setHookSink(sink: HookSink): void {
    this.hookSink = sink;
    for (const conn of this.hosts.values()) {
      if (conn.status === "connected") void conn.catchUpHooks();
    }
  }

  /**
   * Where control requests relayed from remote hosts' `manor` CLIs go
   * (ADR-189 §2). Until it is set they are answered 503.
   */
  setControlRelaySink(sink: ControlRelaySink): void {
    this.controlRelaySink = sink;
  }

  /** Stream events from every host, tagged with the host they came from. */
  onEvent(handler: (hostId: string, event: StreamEvent) => void): () => void {
    return this.streamEvents.on(handler);
  }

  /** Connection loss / recovery / failure on any remote host. */
  onHostEvent(handler: (hostId: string, event: HostConnectionEvent) => void): () => void {
    return this.hostEvents.on(handler);
  }

  /**
   * A remote host came back after a drop and its hook replay is done (or
   * took too long). `sessionIds` are every session its daemon has now: a
   * pane the app had on that host whose session is not among them was lost
   * (the daemon restarted); the rest should reattach, having missed output.
   */
  onHostResumed(handler: (hostId: string, sessionIds: string[]) => void): () => void {
    return this.resumed.on(handler);
  }

  /**
   * A host's daemon is about to be replaced (ADR-185 §A) — a protocol bump,
   * `kill_daemon`, a crash respawn — and `sessionIds` are its still-live
   * sessions, about to be lost. Local and remote alike. Lets a listener tell
   * the difference between an Agent's pty exiting because the Agent finished
   * and one exiting because its daemon was swapped out from under it.
   */
  onDaemonReplacing(handler: (hostId: string, sessionIds: string[]) => void): () => void {
    return this.daemonReplacing.on(handler);
  }

  /**
   * Report that `hostId`'s daemon is about to be replaced (see
   * `onDaemonReplacing`). For the local host's client, which is built before
   * the registry and so cannot be handed its connection the way a remote
   * host's backend is in `register`. An unknown host is ignored.
   */
  reportDaemonReplacing(hostId: string, sessionIds: string[]): void {
    this.hosts.get(hostId)?.reportDaemonReplacing(sessionIds);
  }

  /** Called with the full `list()` whenever any host's status changes. */
  onStatusChange(handler: (hosts: HostStatusInfo[]) => void): () => void {
    return this.statusChanges.on(handler);
  }

  // ── Internals ──

  private add(conn: HostConnection): void {
    this.hosts.set(conn.hostId, conn);
    this.emitStatus();
  }

  private emitStatus(): void {
    if (this.statusChanges.size === 0) return;
    this.statusChanges.emit(this.list());
  }
}
