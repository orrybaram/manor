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
 * - **Agent hooks** (ADR-178 §2). A remote daemon journals its host's agent
 *   hooks and streams them as `hookEvent`s. Those are not re-published: the
 *   host's `HostHookFeed` replays the journal after every (re)connect, then
 *   feeds live events, in order, to the hook sink. Before each replay it
 *   claims the host's sessions, so status relayed for a replayed hook reaches
 *   that host's daemon.
 * - **Away and back** (ADR-178 §6). When the host comes back after a drop,
 *   the connection waits for its hook replay, lists the sessions its daemon
 *   still has, and only then announces it resumed — so panes reattach
 *   (resnapshot) with their agents' status already right, and panes whose
 *   sessions are gone (the daemon restarted) can be recovered.
 * - **Its provider** (ADR-178 §1), released on disconnect and disposal.
 */

import { errorMessage } from "../lib/errors";
import type { Emitter } from "./emitter";
import { HostHookFeed, type HookSeqStore, type HookSink } from "./hook-feed";
import { HostUnavailableError, hostGates, hostView, type HostGates } from "./host-view";
import type { HostProvider } from "./providers/types";
import { classifyHostFailure } from "./remote-backend";
import type { SessionOwners } from "./session-owners";
import type { HookPayload } from "../terminal-host/types";
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
}

type HostState = Omit<HostStatusInfo, "hostId" | "spec" | "warnings">;

/**
 * How long a reconnect waits for the host's hook replay before announcing
 * it resumed anyway. Panes stay frozen until then, so a replay that is slow
 * (a huge journal) or retrying must not hold them for long.
 */
const RESUME_REPLAY_WAIT_MS = 5_000;

/** What every host's connection reports to: the registry's shared state. */
export interface HostConnectionContext {
  sessions: SessionOwners;
  /** Stream events, tagged with the host they came from. */
  streamEvents: Emitter<[hostId: string, event: StreamEvent]>;
  /** Some host's status changed. */
  statusChanged: () => void;
}

export interface RemoteHostContext extends HostConnectionContext {
  hostEvents: Emitter<[hostId: string, event: HostConnectionEvent]>;
  /** A host is back after a drop; see `BackendRegistry.onHostResumed`. */
  resumed: Emitter<[hostId: string, sessionIds: string[]]>;
  hookSeqStore: HookSeqStore;
  /** Where agent hooks go; null until the app wires it up. */
  hookSink: () => HookSink | null;
  /** Retry delay for a failed hook replay (see `HostHookFeed`). For tests. */
  hookReplayRetryDelayMs?: (attempt: number) => number;
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
  private connecting: Promise<void> | null = null;
  private attempt = 0;
  protected readonly unsubscribes: Array<() => void> = [];
  private cachedView: WorkspaceBackend | null = null;

  constructor(
    readonly hostId: string,
    readonly spec: HostSpec | null,
    readonly backend: B,
    /** Handed to every `backend.connect()`. */
    private readonly version: string,
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
    };
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

  /** Catch up on the host's agent hooks; the local host has no journal. */
  catchUpHooks(): Promise<void> {
    return Promise.resolve();
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

  /** A `hookEvent` from the host's daemon. The local daemon sends none. */
  protected onHookEvent(_seq: number, _payload: HookPayload): void {}

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
      await this.backend.connect({ version: this.version });
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
    void this.catchUpHooks();
  }

  private onStreamEvent(event: StreamEvent): void {
    if (event.type === "hookEvent") {
      this.onHookEvent(event.seq, event.payload);
      return;
    }
    if (this.ctx.sessions.accept(this.hostId, event)) {
      this.ctx.streamEvents.emit(this.hostId, event);
    }
  }
}

export class RemoteHostConnection extends HostConnection<RemoteHostBackend> {
  readonly hookFeed: HostHookFeed;
  /**
   * Bumped by every host event, so a resume announcement still waiting on
   * its replay is dropped when the host drops again meanwhile.
   */
  private resumeToken = 0;

  constructor(
    hostId: string,
    spec: HostSpec,
    readonly provider: HostProvider,
    backend: RemoteHostBackend,
    version: string,
    protected readonly ctx: RemoteHostContext,
  ) {
    super(hostId, spec, backend, version, ctx);
    this.hookFeed = new HostHookFeed({
      hostId,
      replay: backend.pty.replayHooks.bind(backend.pty),
      store: ctx.hookSeqStore,
      sink: ctx.hookSink,
      // Replayed hooks relay status to their pane's session through
      // `RoutedBackend`, which routes by session owner. Right after launch
      // no remote session is known yet, so without this the relay would
      // fall through to the local daemon.
      beforeCatchUp: () => this.claimHostSessions(),
      ...(ctx.hookReplayRetryDelayMs ? { retryDelayMs: ctx.hookReplayRetryDelayMs } : {}),
    });
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
   */
  override retryNow(): void {
    if (this.status === "reconnecting") {
      this.backend.retryNow();
      return;
    }
    super.retryNow();
  }

  /** Drop the connection. The remote sessions keep running. */
  override async disconnect(): Promise<void> {
    this.autoConnect = false;
    this.cancelConnect();
    this.hookFeed.pause();
    this.setState({ status: "disconnected" }, "clear");
    await this.disposeProvider();
    await this.backend.disconnect();
  }

  override catchUpHooks(): Promise<void> {
    return this.hookFeed.catchUp();
  }

  protected override gates(): HostGates {
    return hostGates(this);
  }

  protected override onHookEvent(seq: number, payload: HookPayload): void {
    this.hookFeed.onLiveEvent(seq, payload);
  }

  protected override async release(): Promise<void> {
    this.hookFeed.pause();
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

  /** Claim every session the host's daemon reports. */
  private async claimHostSessions(): Promise<void> {
    const sessions = await this.backend.pty.listSessions();
    if (this.disposed) return;
    for (const { sessionId } of sessions) this.ctx.sessions.claim(sessionId, this.hostId);
  }

  private onHostEvent(event: HostConnectionEvent): void {
    for (const sessionId of event.sessionIds) {
      this.ctx.sessions.claim(sessionId, this.hostId);
    }
    const token = ++this.resumeToken;
    switch (event.type) {
      case "hostDisconnected":
        this.hookFeed.pause();
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
        // Panes reattach only once the replay is in, so their agent dots
        // are right on first paint (ADR-178 §6).
        void this.announceResumed(token, this.hookFeed.catchUp());
        break;
      case "hostFailed": {
        const failure: HostFailure = {
          reason: event.reason,
          message: event.message,
          ...(event.code !== undefined ? { code: event.code } : {}),
        };
        this.hookFeed.pause();
        this.setState({ status: "error", error: event.message, failure }, "clear");
        break;
      }
    }
    this.ctx.hostEvents.emit(this.hostId, event);
  }

  /**
   * Announce the host resumed once its hook replay has settled (bounded by
   * `RESUME_REPLAY_WAIT_MS`) and its daemon has said which sessions it still
   * has. Dropped if the host moves on meanwhile; a failed listing is dropped
   * too — the connection went again, and the next reconnect announces.
   */
  private async announceResumed(token: number, replayed: Promise<void>): Promise<void> {
    const current = () =>
      !this.disposed && this.resumeToken === token && this.status === "connected";
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      replayed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RESUME_REPLAY_WAIT_MS);
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
