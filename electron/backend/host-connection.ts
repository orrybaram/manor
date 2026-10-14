/**
 * HostConnection — one registered host's connection state (ADR-160 §6,
 * ADR-183). The `BackendRegistry` keeps one per host.
 *
 * - **Status.** Each host is `disconnected` → `connecting` → `connected`,
 *   and a remote one moves to `reconnecting` / `error` as its backend
 *   reports `hostDisconnected` / `hostFailed`.
 * - **Attempts.** Concurrent `ensureConnected` callers share one attempt.
 *   Every attempt and every `disconnect()` bumps `attempt`; an attempt only
 *   touches state while it still holds the current value, so a disconnect
 *   during an in-flight connect is not overwritten by it.
 * - **Disposal.** A host that is unregistered or replaced is `disposed`: its
 *   subscriptions are dropped, it stops reporting status, and anything of
 *   its still in flight (a connect, a resume announcement) gives up.
 * - **Stream events.** The connection is the only subscriber on its
 *   backend's events, and re-publishes each with its hostId, deduped by
 *   session owner (`SessionOwners`).
 *
 * `RemoteHostConnection` adds what only a remote host has:
 *
 * - **Agent hooks** are the host server's (ADR-227 D4): it reads its own
 *   daemon's journal. The desktop hears none, and ignores any `hookEvent`
 *   its stream still carries. Reaching `connected` it claims the host's
 *   sessions, so calls for a pane reach that host's daemon.
 * - **Away and back** (ADR-178 §6). When the host comes back after a drop,
 *   the connection waits for its proxy to hold the host's state again
 *   (bounded), lists the sessions its daemon still has, and only then
 *   announces it resumed — so panes reattach (resnapshot) with their agents'
 *   status already right, and panes whose sessions are gone (the daemon
 *   restarted) can be recovered.
 * - **Its provider** (ADR-178 §1), released on disconnect and disposal.
 * - **The owner channel** to the box's host server (ADR-225 D4):
 *   `serverClient`. It dials whenever the
 *   host reaches `connected` (a connect or a resume), lets go whenever the
 *   host leaves it (a drop, a disconnect), and is disposed with the host.
 * - **The host's state** (ADR-227 D4): `proxy`, a `HostProxy` over that
 *   channel, when the registry was given somewhere to publish it. It
 *   follows the channel by itself and is disposed with the host.
 * - **Not the control relay.** A `manor` CLI on the host is answered by the
 *   host's own server (ADR-227 D8), which asks the daemon for its requests;
 *   the desktop no longer does (ADR-189 §2 had it answer them).
 */

import { errorMessage } from "../lib/errors";
import type { Emitter } from "./emitter";
import { HostServerClient, type HostServerClientOptions } from "./host-server-client";
import { HostProxy, type HostProgressEvent, type HostProxyOptions } from "./host-proxy";
import { hostCacheFile } from "../paths";
import { HostUnavailableError, hostGates, hostView, type HostGates } from "./host-view";
import type { HostProvider } from "./providers/types";
import { classifyHostFailure } from "./remote-backend";
import type { SessionOwners } from "./session-owners";
import type {
  HostConnectionEvent,
  HostFailure,
  HostSpec,
  RemoteHostBackend,
  StreamEvent,
  WorkspaceBackend,
} from "./types";

export type HostStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface HostStatusInfo {
  hostId: string;
  /** How the host is reached; null for the local host. */
  spec: HostSpec | null;
  status: HostStatus;
  /** Why the host is in `error`, suitable for display. */
  error?: string;
  /**
   * Set with `error` when it is a failure retrying cannot fix (bad
   * credentials, host key, no Node on the box) — see `HostFailure`.
   */
  failure?: HostFailure;
  /** Latest bootstrap progress line while `connecting`. */
  progress?: string;
  /** While `reconnecting`: the delay before the next attempt, if known. */
  retryInMs?: number | null;
  /**
   * While `reconnecting`: when (epoch ms, this machine's clock) the next
   * attempt is due, for a countdown. Set alongside a known `retryInMs`.
   */
  retryAt?: number;
  /**
   * Non-blocking issues the last successful bootstrap reported (e.g. an
   * agent config on the remote it could not safely parse). Cleared by the
   * next `connect()`; never fails the connection.
   */
  warnings?: string[];
  /**
   * The host server's relay room, from its last status read (ADR-228 D2):
   * what a phone that sees this host only through the desktop names it by.
   * Absent until a status has been read; null when the server has no room.
   */
  roomId?: string | null;
  /**
   * Whether the host server's last status reported the `viewer-bridge`
   * capability (ADR-228 D3, D4), so a window may open its own stream to it.
   * Absent until a status has been read; false for an older server.
   */
  viewerBridge?: boolean;
  /**
   * Whether this desktop has handed the host its records (ADR-227 D3), the
   * other half of what a window's own viewer stream needs (ADR-228 D3;
   * `electron/ipc/host-pipe.ts`). Set on a desktop's remote hosts only.
   */
  adopted?: boolean;
}

/** What a host server's last status said about it (ADR-228 D2, D3). */
export type HostServerFacts = Required<Pick<HostStatusInfo, "roomId" | "viewerBridge">>;

type HostState = Omit<
  HostStatusInfo,
  "hostId" | "spec" | "warnings" | "roomId" | "viewerBridge" | "adopted"
>;

/**
 * How long a reconnect waits for the host's proxy to read its state before
 * announcing the host resumed anyway. Panes stay frozen until then, so a
 * slow read must not hold them for long.
 */
const RESUME_SYNC_WAIT_MS = 5_000;

/** What every host's connection reports to: the registry's shared state. */
export interface HostConnectionContext {
  sessions: SessionOwners;
  /** Stream events, tagged with the host they came from. */
  streamEvents: Emitter<[hostId: string, event: StreamEvent]>;
  /** Some host's status changed. */
  statusChanged: () => void;
  /**
   * A host's daemon is about to be replaced (a protocol bump, `kill_daemon`,
   * a crash respawn — ADR-185 §A) and these are its still-live sessions.
   * Local and remote alike: any host's daemon can be replaced, not only a
   * remote one recovering from a drop. See `BackendRegistry.onDaemonReplacing`.
   */
  daemonReplacing: Emitter<[hostId: string, sessionIds: string[]]>;
}

export interface RemoteHostContext extends HostConnectionContext {
  hostEvents: Emitter<[hostId: string, event: HostConnectionEvent]>;
  /** A host is back after a drop; see `BackendRegistry.onHostResumed`. */
  resumed: Emitter<[hostId: string, sessionIds: string[]]>;
  /** Timeouts and retry delays for each host's `HostServerClient`. For tests. */
  hostServerClient?: Pick<HostServerClientOptions, "requestTimeoutMs" | "retryDelayMs" | "log">;
  /** Where each host's `HostProxy` publishes; no proxies without it. */
  hostProxy?: HostProxyContext;
}

/** What every remote host's `HostProxy` is built with (ADR-227 D4). */
export interface HostProxyContext
  extends Pick<
    HostProxyOptions,
    "bus" | "republishAgents" | "onAgentUpdate" | "onUnseenRead" | "publishKeyed" | "claimsFor" | "saveDelayMs" | "log"
  > {
  /** The desktop's name for a host (`HostRecords.label`), read at use. */
  label(hostId: string): string;
  /** A host's progress events for its owner (`HostProxyOptions.onProgress`). */
  onProgress?(hostId: string, event: HostProgressEvent, args: unknown[]): void;
  /** Where the cache files go. Defaults to `hostCacheDir()`. */
  cacheDir?: string;
}

export class HostConnection<B extends WorkspaceBackend = WorkspaceBackend> {
  /** Set once the host is unregistered or replaced. Never cleared. */
  disposed = false;
  /**
   * Whether a git/shell/ports call may start a background connect. Cleared
   * by an explicit `disconnect()` so a poller does not undo it.
   */
  autoConnect = true;
  protected state: HostState = { status: "disconnected" };
  /** Kept apart from `state`: they outlive reconnects (see `setState`). */
  private warnings: string[] | undefined;
  /** Kept apart from `state` too: the last status read, across reconnects. */
  private serverFacts: HostServerFacts | undefined;
  private connecting: Promise<void> | null = null;
  private attempt = 0;
  protected readonly unsubscribes: Array<() => void> = [];
  private cachedView: WorkspaceBackend | null = null;

  constructor(
    readonly hostId: string,
    readonly spec: HostSpec | null,
    readonly backend: B,
    protected readonly ctx: HostConnectionContext,
  ) {
    this.unsubscribes.push(backend.pty.onEvent((event) => this.onStreamEvent(event)));
  }

  get status(): HostStatus {
    return this.state.status;
  }

  /** Why the host is in `error`. */
  get error(): string | undefined {
    return this.state.error;
  }

  info(): HostStatusInfo {
    return {
      hostId: this.hostId,
      spec: this.spec,
      ...this.state,
      ...(this.warnings ? { warnings: this.warnings } : {}),
      ...(this.serverFacts ?? {}),
    };
  }

  /**
   * What the host server's last status said (ADR-228 D2, D3), or null to
   * forget it — the box has no host server. Announced like any other change.
   */
  setServerFacts(facts: HostServerFacts | null): void {
    this.announcing(() => {
      this.serverFacts = facts ?? undefined;
    });
  }

  /** What `BackendRegistry.get` hands out for this host (see `host-view.ts`). */
  get view(): WorkspaceBackend {
    this.cachedView ??= hostView(this, this.gates());
    return this.cachedView;
  }

  /**
   * Connect if not already. Concurrent callers share one attempt. Rejects
   * with the connect error, which `info()` also reports. Always tries —
   * including after `error` — so this is the retry.
   */
  ensureConnected(): Promise<void> {
    this.autoConnect = true;
    if (this.state.status === "connected") return Promise.resolve();
    if (!this.connecting) {
      const attempt = this.connect(++this.attempt).finally(() => {
        if (this.connecting === attempt) this.connecting = null;
      });
      this.connecting = attempt;
    }
    return this.connecting;
  }

  /** `ensureConnected` without waiting; failures land in `info()`. */
  connectInBackground(): void {
    this.ensureConnected().catch(() => {
      // Reported through status.
    });
  }

  /** The user's "Retry now" (see `BackendRegistry.retryNow`). */
  retryNow(): void {
    this.connectInBackground();
  }

  /** Drop the connection. The local host's is never dropped. */
  async disconnect(): Promise<void> {}

  /**
   * This host's daemon is about to be replaced and `sessionIds` are what it
   * is about to lose (ADR-185 §A). Whoever builds this host's client wires
   * its `onDaemonReplacing` callback to this, the same way a remote host's
   * connect events reach `onHostEvent` above. Forwarded as a registry event
   * (`BackendRegistry.onDaemonReplacing`), modelled on how `resumed` is
   * exposed.
   */
  reportDaemonReplacing(sessionIds: string[]): void {
    this.ctx.daemonReplacing.emit(this.hostId, sessionIds);
  }

  /** The host was unregistered or replaced: let go of it for good. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const off of this.unsubscribes.splice(0)) off();
    await this.release();
  }

  /** The gates `view` puts in front of the backend; none for the local host. */
  protected gates(): HostGates | null {
    return null;
  }

  /** The host reached `connected` by a connect (a resume is `onHostEvent`'s). */
  protected onConnected(): void {}

  /** Release what the connection holds, after `dispose()`; never throws. */
  protected async release(): Promise<void> {
    try {
      await this.backend.disconnect();
    } catch (err) {
      console.warn(`[host-connection] disconnecting ${this.hostId} failed:`, err);
    }
  }

  /** Invalidate any in-flight connect so it cannot land after this. */
  protected cancelConnect(): void {
    this.connecting = null;
    this.attempt++;
  }

  /**
   * Move to `state`, announcing it if anything visible changed. Bootstrap
   * warnings are kept unless `warnings` is "clear": auto-reconnect does not
   * rerun bootstrap, so nothing would re-report them across a blip
   * (connected → reconnecting → connected), and one reported mid-connect
   * must survive the move to "connected".
   */
  protected setState(state: HostState, warnings: "keep" | "clear" = "keep"): void {
    this.announcing(() => {
      this.state = state;
      if (warnings === "clear") this.warnings = undefined;
    });
  }

  /** The last bootstrap's warnings; see `HostStatusInfo.warnings`. */
  protected setWarnings(warnings: string[]): void {
    this.announcing(() => {
      this.warnings = warnings.length > 0 ? warnings : undefined;
    });
  }

  private announcing(change: () => void): void {
    const before = JSON.stringify(this.info());
    change();
    if (this.disposed || JSON.stringify(this.info()) === before) return;
    this.ctx.statusChanged();
  }

  private async connect(token: number): Promise<void> {
    const current = () => !this.disposed && this.attempt === token;
    // A disconnect (or replacing / removing the host) cancelled this attempt.
    const superseded = () =>
      new HostUnavailableError(
        this.hostId,
        this.disposed ? "unknown" : this.state.status,
        "connect was cancelled",
      );
    this.setState({ status: "connecting" }, "clear");
    try {
      await this.backend.connect();
    } catch (err) {
      if (!current()) throw superseded();
      const failure = classifyHostFailure(err);
      this.setState(
        {
          status: "error",
          error: failure?.message ?? errorMessage(err),
          ...(failure ? { failure } : {}),
        },
        "clear",
      );
      throw err;
    }
    // Resolving now would hand a pty call a client that was disposed.
    if (!current()) throw superseded();
    this.setState({ status: "connected" });
    this.onConnected();
  }

  private onStreamEvent(event: StreamEvent): void {
    // The host server reads the journal; the desktop has no use for hooks.
    if (event.type === "hookEvent") return;
    // A box's CLI requests are its host server's to answer (ADR-227 D8);
    // on a host server, it hears them on its own daemon client.
    if (event.type === "controlRequest") return;
    if (this.ctx.sessions.accept(this.hostId, event)) {
      this.ctx.streamEvents.emit(this.hostId, event);
    }
  }
}

export class RemoteHostConnection extends HostConnection<RemoteHostBackend> {
  /** The owner channel to the box's host server (ADR-225 D4). */
  readonly serverClient: HostServerClient;
  /** The host's state through that channel (ADR-227 D4); see `HostProxyContext`. */
  readonly proxy: HostProxy | null;
  /**
   * Bumped by every host event, so a resume announcement still waiting on
   * the proxy is dropped when the host drops again meanwhile.
   */
  private resumeToken = 0;

  constructor(
    hostId: string,
    spec: HostSpec,
    readonly provider: HostProvider,
    backend: RemoteHostBackend,
    protected readonly ctx: RemoteHostContext,
  ) {
    super(hostId, spec, backend, ctx);
    this.serverClient = new HostServerClient({
      hostId,
      open: provider.openServerChannel?.bind(provider) ?? null,
      ...ctx.hostServerClient,
    });
    const proxyCtx = ctx.hostProxy;
    this.proxy = proxyCtx
      ? new HostProxy({
          client: this.serverClient,
          bus: proxyCtx.bus,
          label: () => proxyCtx.label(hostId),
          cacheFile: hostCacheFile(hostId, proxyCtx.cacheDir),
          republishAgents: proxyCtx.republishAgents,
          onAgentUpdate: (agent, unseen, prev) =>
            proxyCtx.onAgentUpdate?.(agent, unseen, prev),
          onUnseenRead: (ids, unseen) => proxyCtx.onUnseenRead?.(ids, unseen),
          publishKeyed: proxyCtx.publishKeyed,
          claimsFor: proxyCtx.claimsFor,
          onProgress: (event, args) => proxyCtx.onProgress?.(hostId, event, args),
          saveDelayMs: proxyCtx.saveDelayMs,
          log: proxyCtx.log,
        })
      : null;
    this.unsubscribes.push(backend.onHostEvent((event) => this.onHostEvent(event)));
  }

  /** Latest bootstrap progress, shown while `connecting`. */
  reportProgress(message: string): void {
    if (this.status !== "connecting") return;
    this.setState({ status: "connecting", progress: message });
  }

  reportWarnings(warnings: string[]): void {
    this.setWarnings(warnings);
  }

  /**
   * A host its backend is already reconnecting attempts at once instead of
   * waiting out the backoff; any other gets a fresh connect.
   *
   * A reconnecting backend whose loop has no wait to cut short is
   * mid-attempt already: that is left alone. A second `connect()` alongside
   * the loop's own attempt would race it for the same host.
   *
   * A woken loop attempts at once, so its countdown is moved to now: the
   * UI reads a reconnecting host whose attempt is due as one mid-attempt,
   * and the click shows. The loop's next `hostRetrying` resets it.
   */
  override retryNow(): void {
    if (this.status === "reconnecting") {
      if (this.backend.retryNow()) {
        this.setState({ ...this.state, retryInMs: 0, retryAt: Date.now() });
      }
      return;
    }
    super.retryNow();
  }

  /**
   * Check the host is still there (ADR-188 §3), e.g. after the machine
   * wakes: a connected host is pinged, which catches a connection that is up
   * but has stopped delivering — a socket close never reports that. A host
   * mid-backoff is retried now instead of waiting out the rest of its delay,
   * since libuv timers do not advance while asleep, so the wait may still
   * have most of itself left. Anything else (not yet connected, `error`) is
   * left alone.
   */
  checkLiveness(): void {
    if (this.status === "connected") {
      void this.backend.checkLiveness();
    } else if (this.status === "reconnecting") {
      this.backend.retryNow();
    }
  }

  /** Drop the connection. The remote sessions keep running. */
  override async disconnect(): Promise<void> {
    this.autoConnect = false;
    this.cancelConnect();
    this.setState({ status: "disconnected" }, "clear");
    await this.disposeProvider();
    await this.backend.disconnect();
  }

  protected override onConnected(): void {
    this.claimHostSessionsInBackground();
  }

  /** The host was unregistered or replaced: its owner channel goes with it. */
  override async dispose(): Promise<void> {
    this.proxy?.dispose();
    this.serverClient.dispose();
    await super.dispose();
  }

  /**
   * Every status move passes here, so the owner channel follows the host:
   * reaching `connected` (the first connect, or a resume) dials it, leaving
   * `connected` (a drop, an error, a disconnect) lets it go.
   */
  protected override setState(state: HostState, warnings: "keep" | "clear" = "keep"): void {
    const was = this.status;
    super.setState(state, warnings);
    if (this.disposed || was === state.status) return;
    if (state.status === "connected") this.serverClient.hostConnected();
    else if (was === "connected") this.serverClient.hostLost();
  }

  protected override gates(): HostGates {
    return hostGates(this);
  }

  protected override async release(): Promise<void> {
    await this.disposeProvider();
    await super.release();
  }

  /** Release the provider's own resources (port forwards); never throws. */
  private async disposeProvider(): Promise<void> {
    try {
      await this.provider.dispose();
    } catch (err) {
      console.warn(`[host-connection] disposing ${this.hostId}'s provider failed:`, err);
    }
  }

  /** Claim every session the host's daemon reports, so calls for a pane reach it. */
  private claimHostSessionsInBackground(): void {
    void (async () => {
      try {
        const sessions = await this.backend.pty.listSessions();
        if (this.disposed) return;
        for (const { sessionId } of sessions) this.ctx.sessions.claim(sessionId, this.hostId);
      } catch (err) {
        console.debug(`[host-connection] claiming ${this.hostId}'s sessions failed:`, err);
      }
    })();
  }

  private onHostEvent(event: HostConnectionEvent): void {
    for (const sessionId of event.sessionIds) {
      this.ctx.sessions.claim(sessionId, this.hostId);
    }
    const token = ++this.resumeToken;
    switch (event.type) {
      case "hostDisconnected":
        this.setState({
          status: "reconnecting",
          retryInMs: event.retryInMs,
          ...(event.retryInMs != null ? { retryAt: Date.now() + event.retryInMs } : {}),
        });
        break;
      case "hostRetrying":
        // Only a still-reconnecting host has an attempt to count down to.
        if (this.status !== "reconnecting") break;
        this.setState({
          ...this.state,
          retryInMs: event.retryInMs,
          retryAt: Date.now() + event.retryInMs,
        });
        break;
      case "hostReconnected":
        this.setState({ status: "connected" });
        // Panes reattach only once the host's server is back and the proxy
        // has read its state, so their agent dots are right on first paint
        // (ADR-178 §6) and a lost pane's fresh session can start and type its
        // resume command (ADR-227 D4).
        void this.announceResumed(token, this.proxy?.synced() ?? Promise.resolve());
        break;
      case "hostFailed": {
        const failure: HostFailure = {
          reason: event.reason,
          message: event.message,
          ...(event.code !== undefined ? { code: event.code } : {}),
        };
        this.setState({ status: "error", error: event.message, failure }, "clear");
        break;
      }
    }
    this.ctx.hostEvents.emit(this.hostId, event);
  }

  /**
   * Announce the host resumed once its proxy holds the host's state (bounded
   * by `RESUME_SYNC_WAIT_MS`) and its daemon has said which sessions it still
   * has. Dropped if the host moves on meanwhile; a failed listing is dropped
   * too — the connection went again, and the next reconnect announces.
   */
  private async announceResumed(token: number, synced: Promise<void>): Promise<void> {
    const current = () =>
      !this.disposed && this.resumeToken === token && this.status === "connected";
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      synced,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RESUME_SYNC_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!current()) return;
    let sessionIds: string[];
    try {
      const sessions = await this.backend.pty.listSessions();
      sessionIds = sessions.map((s) => s.sessionId);
    } catch (err) {
      console.warn(
        `[host-connection] listing ${this.hostId}'s sessions after reconnect failed:`,
        errorMessage(err),
      );
      return;
    }
    if (!current()) return;
    for (const sessionId of sessionIds) this.ctx.sessions.claim(sessionId, this.hostId);
    this.ctx.resumed.emit(this.hostId, sessionIds);
  }
}
