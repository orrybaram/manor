/**
 * TerminalHostClient — used by the Electron main process to communicate with the daemon.
 *
 * - Reaches the daemon through a HostTransport (LocalTransport by default),
 *   which spawns it if it is not running
 * - Control socket: request/response (NDJSON)
 * - Stream socket: fire-and-forget writes + event subscription
 */

import type { Duplex } from "node:stream";
import type {
  ControlRequest,
  ControlResponse,
  StreamEvent,
  SessionInfo,
  TerminalSnapshot,
  AgentStatus,
  AgentKind,
  HookReplay,
} from "./types";
import { TERMINAL_HOST_PROTOCOL } from "./types";
import type { HostTransport } from "./transport";
import { LocalTransport } from "./transport-local";
import {
  EXIT_DRAIN_GRACE_MS,
  KILL_ESCALATION_MS,
  normalizeTimeout,
} from "./exec-runner";

/**
 * The wire protocol a handshake reply reports. A daemon old enough not to
 * answer the handshake, or not to carry the field, speaks 0.
 */
export function daemonProtocolOf(response: ControlResponse): number {
  return response.type === "handshake" ? (response.protocol ?? 0) : 0;
}

/**
 * Whether the daemon that sent `response` must be replaced before it can serve
 * this client.
 *
 * Two independent reasons, and checking only the first is what let ADR-159's
 * fix sit inert in a running app for days:
 *
 * - **Different app version** — the daemon binary is mismatched.
 * - **Older wire protocol at the same app version** — two builds of one
 *   release meet across a protocol bump. The client *can* degrade (see
 *   `daemonProtocol`), but degrading means doing without sequence numbers, and
 *   without those every warm restore duplicates output: precisely the bug
 *   ADR-159 exists to fix. Serving a terminal we know is broken is worse than
 *   replacing the daemon, even though replacing it ends live sessions.
 *
 * In a released build the second reason is unreachable — a protocol bump ships
 * inside a version bump, so the version check fires first. It exists for
 * development, where the version is constant across rebuilds and a daemon can
 * outlive the protocol it was built against by days.
 */
export function isDaemonStale(
  response: ControlResponse,
  clientVersion: string,
): boolean {
  if (response.type === "handshake" && response.daemonVersion !== clientVersion)
    return true;
  return daemonProtocolOf(response) < TERMINAL_HOST_PROTOCOL;
}

/** Per-request timeout for control requests that do not name their own. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Client-side timeout for `readFile` (up to 10 MiB, possibly over ssh). */
const READ_FILE_TIMEOUT_MS = 30_000;

/** Slack on top of the daemon's own exec deadline, for transport latency. */
const EXEC_RESPONSE_MARGIN_MS = 10_000;

/**
 * How long the client waits for an `exec` reply: strictly longer than the
 * daemon takes to time the command out, kill it, and answer — so a slow
 * command surfaces as the daemon's timed-out result, not as a client timeout
 * that tears down the connection. `null` when the daemon applies no timeout.
 */
function execClientTimeoutMs(timeout: number | undefined): number | null {
  const serverTimeout = normalizeTimeout(timeout);
  if (serverTimeout === null) return null;
  return Math.min(
    serverTimeout +
      KILL_ESCALATION_MS +
      EXIT_DRAIN_GRACE_MS +
      EXEC_RESPONSE_MARGIN_MS,
    2 ** 31 - 1,
  );
}

type StreamEventHandler = (event: StreamEvent) => void;

function disconnectedWhileConnecting(): Error {
  return new Error("Disconnected while connecting");
}

/**
 * How long to wait before reconnect attempt `attempt` (0-based) after the
 * connection drops unexpectedly, or `null` to give up — at which point every
 * wanted session is reported as exited.
 */
export type ReconnectPolicy = (attempt: number) => number | null;

/**
 * Observes unexpected connection loss and recovery. Never called for an
 * intentional `disconnect()`/`dispose()`.
 */
export interface ConnectionListener {
  /**
   * The connection dropped while connected. `sessionIds` are the sessions
   * the app is subscribed to; their output stops until a reconnect.
   */
  onLost?(info: { sessionIds: string[] }): void;
  /**
   * The reconnect loop got the connection back. `sessionIds` are the
   * sessions that survived and were re-subscribed — anything they printed
   * while disconnected was not delivered, so a consumer should resnapshot
   * them (`getSnapshot`).
   */
  onReconnected?(info: { sessionIds: string[]; attempts: number }): void;
  /**
   * The reconnect loop stopped on an error the reconnect policy classed as
   * permanent (see `setReconnectPolicy`). Nothing retries until something
   * calls `connect()` again; the sessions stay wanted, so a successful
   * connect re-subscribes them and reports `onReconnected`.
   */
  onFailed?(info: { error: unknown; sessionIds: string[]; attempts: number }): void;
  /**
   * The reconnect loop is about to wait `delayMs` before attempt `attempt`
   * (0-based). Attempt 0's delay is the one `onLost` precedes.
   */
  onRetryScheduled?(info: { attempt: number; delayMs: number }): void;
}

/** Callbacks for one `execStream`, mirroring `Exec.stream` in backend/exec.ts. */
export interface ExecStreamCallbacks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onExit: (result: { exitCode: number | null; error?: string }) => void;
}

interface ExecStreamEntry {
  callbacks: ExecStreamCallbacks;
  /** True once the `execStream` command was written to the stream socket. */
  started: boolean;
  finish: (result: { exitCode: number | null; error?: string }) => void;
}

export interface TerminalHostClientOptions {
  /**
   * Push this process's `MANOR_HOOK_PORT`, `MANOR_WEBVIEW_PORT` and
   * `MANOR_PORTLESS_PORT` to the daemon on every connect (default true).
   * Those are ports on *this* machine; a remote daemon must not get them —
   * its PTYs use the daemon's own hook listener (ADR-178 §2) — so
   * `RemoteBackend` passes false. Explicit `updateEnv` values are still
   * re-sent either way.
   */
  pushLocalEnv?: boolean;
}

export class TerminalHostClient {
  private controlSocket: Duplex | null = null;
  private streamSocket: Duplex | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (resp: ControlResponse) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  private requestIdCounter = 0;
  /** Serializes ordinary control requests so only one is in flight at a
   *  time — terminal operations depend on the daemon seeing them in order.
   *  `exec`/`readFile` bypass it (see `requestConcurrent`); responses are
   *  matched by `requestId`, so they may arrive in any order. */
  private requestMutex: Promise<void> = Promise.resolve();
  private controlBuffer = "";
  private streamBuffer = "";
  private eventHandler: StreamEventHandler | null = null;
  private clientVersion: string | undefined;
  /** Env set through `updateEnv`, re-sent to the daemon on every connect. */
  private envOverrides: Record<string, string> = {};
  /**
   * Wire protocol the connected daemon speaks; 0 means it is old enough not to
   * report one. Re-read on every connect, since reconnecting can land on a
   * different daemon.
   */
  private daemonProtocol = 0;
  /**
   * Sessions the app wants a stream subscription for. Filled by
   * `createOrAttach`, emptied by `kill`/`detach`. Deliberately survives
   * `cleanup()`: after the daemon goes away this is the list of terminals the
   * renderer still believes are alive, and `reconcileSubscriptions` turns it
   * into re-subscribes or synthetic `exit` events (ADR-169).
   */
  private wanted = new Set<string>();
  /** True while `reconnectAfterLoss` is running, so a second socket close
   *  during the retry loop does not start a competing loop. */
  private reconnecting = false;
  /** Backoff between reconnect attempts after an unexpected disconnect.
   *  Overridable so tests do not have to wait it out. */
  private reconnectDelaysMs: number[] = [250, 1_000, 2_000];
  /** Replaces `reconnectDelaysMs` when set (see `setReconnectPolicy`). */
  private reconnectPolicy: ReconnectPolicy | null = null;
  /** Errors the reconnect loop must not retry (see `setReconnectPolicy`). */
  private isPermanentFailure: ((err: unknown) => boolean) | null = null;
  /**
   * The reconnect loop stopped on a permanent failure with sessions still
   * wanted. The next successful connect reports them via `onReconnected`.
   */
  private recoveryPending = false;
  private connectionListener: ConnectionListener | null = null;
  /**
   * Bumped by every intentional `disconnect()`, so a reconnect loop started
   * before it stops instead of reconnecting behind the caller's back.
   */
  private generation = 0;
  /** The `generation` the in-flight `connectPromise` was started under. */
  private connectGeneration = 0;
  /** Wakes a reconnect loop sleeping between attempts (on `disconnect()`). */
  private wakeReconnect: (() => void) | null = null;
  /** Live `execStream`s by execId; their events never reach `eventHandler`. */
  private execStreams = new Map<string, ExecStreamEntry>();
  private execIdCounter = 0;

  private readonly transport: HostTransport;

  /** Timeout for auth + handshake; the transport decides (see `HostTransport`). */
  private get handshakeTimeoutMs(): number {
    return this.transport.handshakeTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** See `TerminalHostClientOptions.pushLocalEnv`. */
  private readonly pushLocalEnv: boolean;

  constructor(
    version?: string,
    transport: HostTransport = new LocalTransport(),
    opts: TerminalHostClientOptions = {},
  ) {
    this.clientVersion = version;
    this.transport = transport;
    this.pushLocalEnv = opts.pushLocalEnv ?? true;
  }

  setVersion(version: string): void {
    this.clientVersion = version;
  }

  /**
   * Replace the default reconnect schedule (three quick attempts, then give
   * up). A remote host uses an unbounded capped backoff instead: its sessions
   * outlive the connection, so giving up would close panes that are fine.
   *
   * `isPermanentFailure` marks errors no amount of retrying will fix (bad
   * credentials, a changed host key, a host that cannot run the daemon). On
   * one the loop stops and reports `onFailed` instead of retrying, and —
   * unlike running out of attempts — does not report sessions as exited.
   */
  setReconnectPolicy(
    policy: ReconnectPolicy,
    opts: { isPermanentFailure?: (err: unknown) => boolean } = {},
  ): void {
    this.reconnectPolicy = policy;
    this.isPermanentFailure = opts.isPermanentFailure ?? null;
  }

  /** Observe unexpected connection loss and recovery. */
  setConnectionListener(listener: ConnectionListener | null): void {
    this.connectionListener = listener;
  }

  /** Set a handler for stream events (data, exit, cwd, error) */
  onEvent(handler: StreamEventHandler): void {
    this.eventHandler = handler;
  }

  /** Connect to the daemon, spawning it if necessary */
  async connect(): Promise<void> {
    for (;;) {
      if (this.connected) return;
      const pending = this.connectPromise;
      if (!pending) break;
      if (this.connectGeneration === this.generation) return pending;
      // An attempt from before a `disconnect()` is still unwinding. It will
      // fail at its next await; let it, so it cannot tear down ours.
      await pending.catch(() => {});
    }

    const generation = this.generation;
    // A failed attempt may have opened the control socket before failing
    // (e.g. on the stream socket). Tear it down here, or the next attempt
    // would overwrite it while it is still open. A superseded attempt has
    // already cleaned up after itself (see `doConnect`), and must not touch
    // what a newer one may have opened since.
    const attempt = this.doConnect(generation).catch((err: unknown) => {
      if (generation === this.generation) this.cleanup();
      throw err;
    });
    this.connectPromise = attempt;
    this.connectGeneration = generation;
    try {
      await attempt;
    } finally {
      if (this.connectPromise === attempt) this.connectPromise = null;
    }

    // Every (re)connect ends by squaring the daemon's session table with what
    // the app thinks it has. Lives here rather than in `doConnect()` so it
    // also covers the stale-daemon respawn inside `doConnect()` and any
    // alternative connect path.
    await this.reconcileSubscriptions();
    if (generation !== this.generation) throw disconnectedWhileConnecting();

    if (this.recoveryPending && this.connected && !this.reconnecting) {
      this.recoveryPending = false;
      this.notifyListener("onReconnected", {
        sessionIds: [...this.wanted],
        attempts: 1,
      });
    }
  }

  /**
   * After a (re)connect: re-subscribe to every wanted session the daemon
   * still has, and emit a synthetic `exit` for every one it does not.
   *
   * Before ADR-169 a lost daemon left the client silent — no reconnect, no
   * events — and the renderer kept showing terminals whose PTYs were gone.
   * The `exit` here is what turns that freeze into the same closed-pane state
   * a shell exit produces, which the renderer already knows how to handle.
   */
  private async reconcileSubscriptions(): Promise<void> {
    if (this.wanted.size === 0) return;
    let alive: Set<string>;
    try {
      // Straight to the wire, not `listSessions()`: if the connection is
      // already gone that would start a nested connect behind the caller's
      // back. The caller sees `connected` false and deals with it.
      const resp = await this.request({ type: "listSessions" });
      if (resp.type !== "sessions") {
        throw new Error(`unexpected response type: ${resp.type}`);
      }
      alive = new Set(resp.sessions.map((s) => s.sessionId));
    } catch (err) {
      // The connection died again mid-reconcile. The wanted set is intact, so
      // the next successful connect will pick this up.
      console.warn(
        `[terminal-host] could not list sessions after reconnect: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    for (const sessionId of [...this.wanted]) {
      if (alive.has(sessionId)) {
        this.streamWrite({ type: "subscribe", sessionId });
      } else {
        this.wanted.delete(sessionId);
        this.emitSyntheticExit(sessionId);
      }
    }
  }

  /** Tell the app a session is gone, on the same channel a real exit uses. */
  private emitSyntheticExit(sessionId: string): void {
    const handler = this.eventHandler;
    if (!handler) return;
    // Deliver off the current stack so a throwing handler cannot unwind a
    // connect() or reconnect loop that is still in progress.
    queueMicrotask(() => {
      try {
        handler({ type: "exit", sessionId, exitCode: -1, lost: true });
      } catch (err) {
        console.error("[terminal-host] exit handler threw:", err);
      }
    });
  }

  /**
   * The daemon dropped both sockets under us. Get a daemon back — spawning
   * one if the old one is gone — and let `connect()` reconcile sessions. If
   * that keeps failing, the sessions are unreachable for good as far as this
   * client can tell, so report every wanted one as exited rather than leaving
   * the renderer waiting on output that will never come.
   */
  private async reconnectAfterLoss(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    const generation = this.generation;
    try {
      for (let attempt = 0; ; attempt++) {
        const delay = this.reconnectDelay(attempt);
        if (delay === null) break;
        this.notifyListener("onRetryScheduled", { attempt, delayMs: delay });
        await this.sleepBeforeReconnect(delay);
        // disconnect() was called while we slept: the caller is done with us.
        if (generation !== this.generation) return;
        try {
          await this.connect();
          // disconnect() landed after connect() finished. It already tore
          // down what connect() opened (sockets opened under an older
          // generation never outlive a disconnect — see `doConnect`).
          if (generation !== this.generation) return;
          // The connection dropped again while re-subscribing. connect()
          // swallows that (the session list is best-effort), and the loss
          // handler deferred to this loop — so this loop must go round again,
          // or nothing ever re-subscribes those sessions.
          if (!this.connected) {
            throw new Error("connection lost while re-subscribing sessions");
          }
          console.warn(
            `[terminal-host] reconnected to daemon after unexpected disconnect (attempt ${attempt + 1})`,
          );
          this.recoveryPending = false;
          this.notifyListener("onReconnected", {
            sessionIds: [...this.wanted],
            attempts: attempt + 1,
          });
          return;
        } catch (err) {
          if (generation !== this.generation) return;
          if (this.isPermanentFailure?.(err)) {
            console.error(
              `[terminal-host] reconnect attempt ${attempt + 1} failed permanently; not retrying: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            this.recoveryPending = this.wanted.size > 0;
            this.notifyListener("onFailed", {
              error: err,
              sessionIds: [...this.wanted],
              attempts: attempt + 1,
            });
            return;
          }
          console.warn(
            `[terminal-host] reconnect attempt ${attempt + 1} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      console.error(
        `[terminal-host] giving up on the daemon; reporting ${this.wanted.size} session(s) as exited`,
      );
      for (const sessionId of [...this.wanted]) {
        this.wanted.delete(sessionId);
        this.emitSyntheticExit(sessionId);
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private reconnectDelay(attempt: number): number | null {
    if (this.reconnectPolicy) return this.reconnectPolicy(attempt);
    return this.reconnectDelaysMs[attempt] ?? null;
  }

  /**
   * Cut the reconnect loop's current wait short and attempt now ("Retry
   * now"). Returns false when the loop is not waiting — not reconnecting,
   * or mid-attempt already.
   */
  retryReconnectNow(): boolean {
    if (!this.reconnecting || !this.wakeReconnect) return false;
    this.wakeReconnect();
    return true;
  }

  /** Wait `ms`, or less if `disconnect()` is called meanwhile. */
  private sleepBeforeReconnect(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer: { id?: ReturnType<typeof setTimeout> } = {};
      const done = (): void => {
        clearTimeout(timer.id);
        if (this.wakeReconnect === done) this.wakeReconnect = null;
        resolve();
      };
      timer.id = setTimeout(done, ms);
      this.wakeReconnect = done;
    });
  }

  /** Call a connection-listener hook without letting it throw into us. */
  private notifyListener(
    ...call:
      | ["onLost", Parameters<NonNullable<ConnectionListener["onLost"]>>[0]]
      | [
          "onReconnected",
          Parameters<NonNullable<ConnectionListener["onReconnected"]>>[0],
        ]
      | ["onFailed", Parameters<NonNullable<ConnectionListener["onFailed"]>>[0]]
      | [
          "onRetryScheduled",
          Parameters<NonNullable<ConnectionListener["onRetryScheduled"]>>[0],
        ]
  ): void {
    const listener = this.connectionListener;
    if (!listener) return;
    try {
      if (call[0] === "onLost") listener.onLost?.(call[1]);
      else if (call[0] === "onReconnected") listener.onReconnected?.(call[1]);
      else if (call[0] === "onFailed") listener.onFailed?.(call[1]);
      else listener.onRetryScheduled?.(call[1]);
    } catch (err) {
      console.error(`[terminal-host] connection listener ${call[0]} threw:`, err);
    }
  }

  /**
   * Open and authenticate both sockets. `generation` is the one `connect()`
   * started under: a `disconnect()` at any await point below bumps it, and
   * the attempt then closes whatever it opened and fails rather than leave
   * the client connected behind the caller's back.
   */
  private async doConnect(generation: number): Promise<void> {
    const stillWanted = (): void => {
      if (generation === this.generation) return;
      this.cleanup();
      throw disconnectedWhileConnecting();
    };

    // Make sure a daemon is there to talk to, starting one if necessary
    await this.transport.ensureRunning(this.clientVersion);
    stillWanted();

    // Connect control socket
    await this.connectControlSocket();
    stillWanted();

    // Authenticate
    let token = await this.transport.authToken();
    stillWanted();
    const authResp = await this.request(
      { type: "auth", token },
      this.handshakeTimeoutMs,
    );
    stillWanted();
    if (authResp.type !== "authOk") {
      throw new Error(
        `Auth failed: ${authResp.type === "error" ? authResp.message : "unknown"}`,
      );
    }

    // Version handshake: replace the running daemon when it cannot serve this
    // client. Two independent ways that happens, and checking only the first
    // is what let this bug ship.
    //
    // - **Different app version** — the daemon binary is simply mismatched.
    // - **Older wire protocol at the same app version** — two builds of one
    //   release meet across a protocol bump. The client *can* degrade here
    //   (`daemonProtocol` gates the reads that need it), but degrading means
    //   doing without sequence numbers, and without those every warm restore
    //   duplicates output: precisely the bug ADR-159 exists to fix. Serving a
    //   terminal we know is broken is worse than replacing the daemon.
    //
    // In a released build the second branch is unreachable — a protocol bump
    // ships inside a version bump, so the version check fires first. It exists
    // for development, where the version is constant across rebuilds and a
    // daemon can outlive the protocol it was built against by days.
    const clientVer = this.clientVersion ?? "unknown";
    const hsResp = await this.request(
      { type: "handshake", clientVersion: clientVer },
      this.handshakeTimeoutMs,
    );
    stillWanted();
    this.daemonProtocol = daemonProtocolOf(hsResp);
    if (isDaemonStale(hsResp, clientVer)) {
      // Stale daemon — replace it
      this.cleanup();
      await this.transport.restart(this.clientVersion);
      stillWanted();
      // Reconnect to the fresh daemon
      await this.connectControlSocket();
      stillWanted();
      token = await this.transport.authToken();
      stillWanted();
      const authResp2 = await this.request(
        { type: "auth", token },
        this.handshakeTimeoutMs,
      );
      stillWanted();
      if (authResp2.type !== "authOk") {
        throw new Error(
          `Auth failed after daemon respawn: ${authResp2.type === "error" ? authResp2.message : "unknown"}`,
        );
      }
      // The daemon we just spawned is built from this client's source, so it
      // speaks this protocol by construction. Recording it here keeps the
      // field describing the daemon we are actually talking to rather than
      // the one we replaced.
      this.daemonProtocol = TERMINAL_HOST_PROTOCOL;
    }

    // Push current env vars to the daemon so new PTY sessions inherit fresh
    // values (e.g. MANOR_HOOK_PORT may have changed since the daemon spawned).
    const envKeys = [
      "MANOR_HOOK_PORT",
      "MANOR_WEBVIEW_PORT",
      "MANOR_PORTLESS_PORT",
    ];
    const inherited: Record<string, string> = {};
    for (const key of this.pushLocalEnv ? envKeys : []) {
      if (process.env[key]) {
        inherited[key] = process.env[key]!;
      }
    }
    // Explicit `updateEnv` values win over inherited ones in general, but for
    // the MANOR_* port keys specifically the live process.env value must win:
    // a remembered `envOverrides` from a previous connect can hold a now-stale
    // port (e.g. MANOR_HOOK_PORT from before this process's hook server was
    // recreated on a later port), and that stale value must not beat the
    // current one on reconnect.
    const envUpdate: Record<string, string> = { ...this.envOverrides, ...inherited };
    if (Object.keys(envUpdate).length > 0) {
      await this.request({ type: "updateEnv", env: envUpdate });
      stillWanted();
    }

    // Connect stream socket
    await this.connectStreamSocket(token);
    stillWanted();

    this.connected = true;
  }

  /**
   * Disconnect from the daemon on purpose. The caller is walking away from
   * its subscriptions too — it will `createOrAttach` again if it wants them —
   * so a later connect must not re-subscribe or report them as exited.
   */
  disconnect(): void {
    this.generation++;
    this.wakeReconnect?.();
    this.wanted.clear();
    this.recoveryPending = false;
    this.cleanup();
  }

  /**
   * Disconnect and release whatever the transport holds (for `SshTransport`,
   * its ssh children and ControlMaster). Does not stop the daemon. The client
   * should not be reused afterwards.
   */
  async dispose(): Promise<void> {
    this.disconnect();
    await this.transport.dispose();
  }

  /** Create a new session or attach to existing one */
  async createOrAttach(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    shellArgs?: string[],
    env?: Record<string, string>,
  ): Promise<{ session: SessionInfo; snapshot: TerminalSnapshot | null }> {
    return this.doCreateOrAttach(sessionId, cwd, cols, rows, shellArgs, true, env);
  }

  private async doCreateOrAttach(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    shellArgs?: string[],
    canRetry = true,
    env?: Record<string, string>,
  ): Promise<{ session: SessionInfo; snapshot: TerminalSnapshot | null }> {
    await this.ensureConnected();

    try {
      // Warm restore, in the order that makes the handshake lossless.
      //
      // 1. Resize first. A resize raises SIGWINCH and a full-screen TUI answers
      //    by repainting — output we want either already inside the snapshot or
      //    arriving afterwards with a higher seq, never straddling the two.
      // 2. Subscribe second. From here on nothing the PTY produces is lost;
      //    before this point there is no one listening.
      // 3. Snapshot last. It reports the stream position it reflects, so the
      //    renderer can drop the events from (2) that it also contains.
      //    Duplicates are expected and filtered by seq; losing output is the
      //    failure mode worth avoiding, since nothing downstream can rebuild it.
      //
      // Steps 1 and 2 are no-ops against a session the daemon does not have, so
      // they are safe to send before knowing whether this is a restore. Probing
      // first with `listSessions` would be wrong anyway: it hides prewarmed
      // sessions, and `attach` would add the *control* socket to the session's
      // broadcast list and corrupt the control protocol.
      await this.request({ type: "resize", sessionId, cols, rows });
      this.wanted.add(sessionId);
      this.streamWrite({ type: "subscribe", sessionId });

      const snapshotResp = await this.request({
        type: "getSnapshot",
        sessionId,
      });
      if (snapshotResp.type === "snapshot") {
        return {
          session: { sessionId, cwd, cols, rows, alive: true },
          snapshot: snapshotResp.snapshot,
        };
      }
      // Only a definite "no such session" means spawn a fresh shell. Treating
      // any failure that way would hand a live session to a terminal that
      // thinks it is new — which drops the snapshot, and with it the dedupe
      // that keeps a reattach from repeating output.
      //
      // A daemon below protocol 1 cannot make that distinction: it answers a
      // missing session with a plain `error`. Reading every error as absence is
      // what that daemon's own client did, so it is the right reading here — and
      // it keeps a daemon that is already running working across an in-place
      // upgrade, instead of failing every new terminal until someone kills it.
      const sessionIsAbsent =
        snapshotResp.type === "notFound" ||
        (this.daemonProtocol < 1 && snapshotResp.type === "error");
      if (!sessionIsAbsent) {
        throw new Error(
          `Snapshot failed for ${sessionId}: ${
            snapshotResp.type === "error"
              ? snapshotResp.message
              : `unexpected response type: ${snapshotResp.type}`
          }`,
        );
      }

      // Create new session
      const createResp = await this.request({
        type: "create",
        sessionId,
        cwd,
        cols,
        rows,
        shellArgs,
        ...(env ? { env } : {}),
      });
      if (createResp.type !== "created") {
        throw new Error(
          `Create failed: ${createResp.type === "error" ? createResp.message : `unexpected response type: ${createResp.type}`}`,
        );
      }

      // Subscribe for stream events immediately (no control socket attach needed)
      this.wanted.add(sessionId);
      this.streamWrite({ type: "subscribe", sessionId });

      return { session: createResp.session, snapshot: null };
    } catch (err) {
      // If the connection broke mid-request, reconnect and retry once
      if (canRetry && !this.connected) {
        return this.doCreateOrAttach(
          sessionId,
          cwd,
          cols,
          rows,
          shellArgs,
          false,
          env,
        );
      }
      throw err;
    }
  }

  /** Create a session without subscribing to its stream (boots silently) */
  async createNoSubscribe(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    prewarmed = false,
    env?: Record<string, string>,
  ): Promise<SessionInfo> {
    await this.ensureConnected();
    const resp = await this.request({
      type: "create",
      sessionId,
      cwd,
      cols,
      rows,
      prewarmed,
      ...(env ? { env } : {}),
    });
    if (resp.type !== "created") {
      throw new Error(
        `Create failed: ${resp.type === "error" ? resp.message : resp.type}`,
      );
    }
    return resp.session;
  }

  /**
   * Write terminal input — fire-and-forget via stream socket.
   *
   * While the daemon is gone the bytes are dropped. There is nothing to
   * deliver them to: the PTY died with the daemon, and `reconnectAfterLoss`
   * is already on its way to reporting the session as exited.
   */
  writeNoAck(sessionId: string, data: string): void {
    this.streamWrite({ type: "write", sessionId, data });
  }

  /** Queue a write that fires after the session's first output (shell prompt).
   *  Uses a control request so the caller gets confirmation the write was queued.
   *  Short timeout (2s) so a stale daemon doesn't block the mutex. */
  async writeAfterReady(sessionId: string, data: string): Promise<void> {
    await this.ensureConnected();
    const resp = await this.request({ type: "writeAfterReady", sessionId, data }, 2_000);
    if (resp.type === "error") {
      throw new Error(resp.message);
    }
  }

  /** Relay an agent hook event to the daemon (fire-and-forget) */
  relayAgentHook(
    sessionId: string,
    status: AgentStatus,
    kind: AgentKind,
  ): void {
    console.debug(
      `[agent-status] client relay: session=${sessionId} status=${status} kind=${kind}`,
    );
    this.streamWrite({ type: "agentHook", sessionId, status, kind });
  }

  /**
   * Resize a session's terminal, resolving once the pty is actually at that
   * size — the ioctl has landed, not merely been sent towards it.
   */
  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.ensureConnected();
    await this.request({ type: "resize", sessionId, cols, rows });
  }

  /** Kill a session */
  async kill(sessionId: string): Promise<void> {
    // Forget it before connecting: a reconnect inside ensureConnected must not
    // report a session the app is closing on purpose as unexpectedly exited.
    this.wanted.delete(sessionId);
    await this.ensureConnected();
    this.streamWrite({ type: "unsubscribe", sessionId });
    await this.request({ type: "kill", sessionId });
  }

  /** Detach from a session (keep it alive in daemon) */
  async detach(sessionId: string): Promise<void> {
    this.wanted.delete(sessionId);
    await this.ensureConnected();
    this.streamWrite({ type: "unsubscribe", sessionId });
    await this.request({ type: "detach", sessionId });
  }

  /** Dispose all dead sessions */
  async disposeDead(): Promise<void> {
    await this.ensureConnected();
    await this.request({ type: "disposeDead" });
  }

  /** Get a session snapshot */
  async getSnapshot(sessionId: string): Promise<TerminalSnapshot | null> {
    await this.ensureConnected();
    const resp = await this.request({ type: "getSnapshot", sessionId });
    if (resp.type === "snapshot") return resp.snapshot;
    return null;
  }

  /** List all sessions */
  async listSessions(): Promise<SessionInfo[]> {
    await this.ensureConnected();
    const resp = await this.request({ type: "listSessions" });
    if (resp.type === "sessions") return resp.sessions;
    return [];
  }

  /** Ping the daemon */
  async ping(): Promise<boolean> {
    try {
      await this.ensureConnected();
      const resp = await this.request({ type: "ping" });
      return resp.type === "pong";
    } catch {
      return false;
    }
  }

  /**
   * Run a command on the daemon's host and collect its output. Resolves with
   * the exit code whatever it is; rejects only if the daemon could not be
   * asked. Does not wait behind other control requests, and does not hold
   * them up.
   */
  async exec(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeout?: number; maxBuffer?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    await this.ensureConnected();
    const resp = await this.requestConcurrent(
      {
        type: "exec",
        cmd,
        args,
        cwd: opts.cwd,
        timeout: opts.timeout,
        maxBuffer: opts.maxBuffer,
      },
      execClientTimeoutMs(opts.timeout),
    );
    if (resp.type === "execResult") {
      return {
        stdout: resp.stdout,
        stderr: resp.stderr,
        exitCode: resp.exitCode,
      };
    }
    throw new Error(
      resp.type === "error"
        ? resp.message
        : `unexpected response type: ${resp.type}`,
    );
  }

  /** Read a UTF-8 file (at most 10 MiB) on the daemon's host. */
  async readFile(filePath: string): Promise<string> {
    await this.ensureConnected();
    const resp = await this.requestConcurrent(
      { type: "readFile", path: filePath },
      READ_FILE_TIMEOUT_MS,
    );
    if (resp.type === "fileContents") return resp.contents;
    throw new Error(
      resp.type === "error"
        ? resp.message
        : `unexpected response type: ${resp.type}`,
    );
  }

  /**
   * Bootstrap the daemon's host for shell integration and agent hooks
   * (ADR-160 ticket 10). Resolves the agent kinds the daemon registered
   * (plus any warnings for connectors it skipped rather than risk
   * clobbering a config it couldn't parse), or `null` when the daemon
   * predates the request and answered `unknown request type`; throws on
   * any other failure.
   */
  async bootstrap(): Promise<{ agents: string[]; warnings: string[] } | null> {
    await this.ensureConnected();
    const resp = await this.request({ type: "bootstrap" });
    if (resp.type === "bootstrapped") {
      return { agents: resp.agents, warnings: resp.warnings ?? [] };
    }
    if (resp.type === "error") {
      if (resp.message.startsWith("unknown request type")) return null;
      throw new Error(`bootstrap failed: ${resp.message}`);
    }
    throw new Error(`bootstrap failed: unexpected response type: ${resp.type}`);
  }

  /**
   * Hook journal entries after `sinceSeq` from the daemon (ADR-178 §2), or
   * `null` when the daemon predates `replayHooks` and has no journal. With
   * `headOnly`, just the journal's position (no entries).
   */
  async replayHooks(
    sinceSeq: number,
    opts: { headOnly?: boolean } = {},
  ): Promise<HookReplay | null> {
    await this.ensureConnected();
    const resp = await this.request({
      type: "replayHooks",
      sinceSeq,
      ...(opts.headOnly ? { headOnly: true } : {}),
    });
    if (resp.type === "hookReplay") {
      return {
        entries: opts.headOnly ? [] : resp.entries,
        lastSeq: resp.lastSeq,
        ...(resp.epoch ? { epoch: resp.epoch } : {}),
      };
    }
    if (resp.type === "error") {
      if (resp.message.startsWith("unknown request type")) return null;
      throw new Error(`replayHooks failed: ${resp.message}`);
    }
    throw new Error(`replayHooks failed: unexpected response type: ${resp.type}`);
  }

  /**
   * Set environment variables on the daemon so PTY sessions spawned from now
   * on inherit them. Remembered, and pushed again on every (re)connect, so a
   * respawned daemon gets them too. Sessions already running keep their env.
   */
  async updateEnv(env: Record<string, string>): Promise<void> {
    Object.assign(this.envOverrides, env);
    await this.ensureConnected();
    const resp = await this.request({ type: "updateEnv", env });
    if (resp.type !== "envUpdated") {
      throw new Error(
        `updateEnv failed: ${resp.type === "error" ? resp.message : `unexpected response type: ${resp.type}`}`,
      );
    }
  }

  /**
   * Run a command on the daemon's host and stream its output (the daemon's
   * `execStream`). Returns synchronously; the command is sent once the
   * client is connected. `env` holds overrides merged onto the daemon's own
   * environment. `onExit` fires exactly once — with `error` set when the
   * client could not start the command or lost the connection while it ran
   * (the daemon kills a disconnected socket's children).
   *
   * The daemon reports its own spawn failures as a stderr chunk followed by
   * a `null` exit code, so those arrive through `onStderr`, not `error`.
   */
  execStream(
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: Record<string, string> },
    callbacks: ExecStreamCallbacks,
  ): { cancel: () => void } {
    const execId = `exec-${++this.execIdCounter}`;
    let done = false;
    const entry: ExecStreamEntry = {
      callbacks,
      started: false,
      finish: (result) => {
        if (done) return;
        done = true;
        this.execStreams.delete(execId);
        callbacks.onExit(result);
      },
    };
    this.execStreams.set(execId, entry);

    this.ensureConnected().then(
      () => {
        if (done) return;
        if (!this.streamSocket?.writable) {
          entry.finish({ exitCode: null, error: "Disconnected" });
          return;
        }
        entry.started = true;
        this.streamWrite({
          type: "execStream",
          execId,
          cmd,
          args,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts.env ? { env: opts.env } : {}),
        });
      },
      (err: unknown) => {
        entry.finish({
          exitCode: null,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );

    return {
      cancel: () => {
        if (done) return;
        if (!entry.started) {
          // Never reached the daemon: nothing to kill, report it as killed.
          entry.finish({ exitCode: null });
          return;
        }
        // The daemon answers with an `execExit` once the child is gone.
        this.streamWrite({ type: "execCancel", execId });
      },
    };
  }

  // ── Internal ──

  /** Route an exec stream event to its `execStream` caller. */
  private dispatchExecEvent(event: StreamEvent): boolean {
    if (
      event.type !== "execStdout" &&
      event.type !== "execStderr" &&
      event.type !== "execExit"
    ) {
      return false;
    }
    const entry = this.execStreams.get(event.execId);
    if (!entry) return true;
    if (event.type === "execExit") entry.finish({ exitCode: event.exitCode });
    else if (event.type === "execStdout") entry.callbacks.onStdout?.(event.data);
    else entry.callbacks.onStderr?.(event.data);
    return true;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  private async connectControlSocket(): Promise<void> {
    const socket = await this.transport.connectControl();
    this.controlSocket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.controlBuffer += chunk.toString("utf-8");
      const lines = this.controlBuffer.split("\n");
      this.controlBuffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line) as ControlResponse & {
            requestId?: string;
          };
          // Match by requestId: exec/readFile replies can overtake others.
          // A reply without one (e.g. "Invalid JSON") goes to the oldest.
          const key =
            resp.requestId !== undefined &&
            this.pendingRequests.has(resp.requestId)
              ? resp.requestId
              : resp.requestId === undefined
                ? this.pendingRequests.keys().next().value
                : undefined;
          if (key !== undefined) {
            const pending = this.pendingRequests.get(key)!;
            this.pendingRequests.delete(key);
            if (pending.timeout) clearTimeout(pending.timeout);
            pending.resolve(resp);
          }
        } catch {
          // invalid JSON, skip
        }
      }
    });

    socket.on("error", () => {
      // Connection failures surface from the transport; once connected, an
      // error here means the daemon went away.
      if (this.connected && socket === this.controlSocket) {
        this.handleDisconnect();
      }
    });

    socket.on("close", () => {
      // A socket from an earlier, abandoned attempt must not tear down the
      // connection that replaced it.
      if (socket === this.controlSocket) this.handleDisconnect();
    });
  }

  private async connectStreamSocket(token: string): Promise<void> {
    const socket = await this.transport.connectStream();
    this.streamSocket = socket;
    // Send init message identifying this as a stream connection
    socket.write(JSON.stringify({ connectionType: "stream", token }) + "\n");
    socket.on("data", (chunk: Buffer) => {
      this.streamBuffer += chunk.toString("utf-8");
      const lines = this.streamBuffer.split("\n");
      this.streamBuffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as StreamEvent;
          if (!this.dispatchExecEvent(event)) this.eventHandler?.(event);
        } catch {
          // invalid JSON, skip
        }
      }
    });

    socket.on("error", () => {
      // Errors are followed by `close`, which is where loss is handled.
    });

    socket.on("close", () => {
      if (socket === this.streamSocket) this.handleDisconnect();
    });
  }

  private request(
    req: ControlRequest,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<ControlResponse> {
    const result = this.requestMutex.then(() =>
      this.doRequest(req, timeoutMs),
    );
    this.requestMutex = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Send a request without queueing behind the mutex. Only for request types
   * the daemon answers out of order (`exec`, `readFile`); anything else
   * relies on the daemon seeing requests in order. `timeoutMs: null` waits
   * until the reply or a disconnect.
   */
  private requestConcurrent(
    req: Extract<ControlRequest, { type: "exec" | "readFile" }>,
    timeoutMs: number | null,
  ): Promise<ControlResponse> {
    return this.doRequest(req, timeoutMs);
  }

  private doRequest(
    req: ControlRequest,
    timeoutMs: number | null,
  ): Promise<ControlResponse> {
    return new Promise((resolve, reject) => {
      if (!this.controlSocket?.writable) {
        reject(new Error("Control socket not writable"));
        return;
      }

      const requestId = String(++this.requestIdCounter);

      const timeout =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pendingRequests.delete(requestId);
              reject(new Error(`Request timed out: ${req.type}`));
              this.cleanup();
            }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      this.controlSocket.write(
        JSON.stringify({ ...req, requestId }) + "\n",
      );
    });
  }

  private streamWrite(cmd: unknown): void {
    if (this.streamSocket?.writable) {
      this.streamSocket.write(JSON.stringify(cmd) + "\n");
    }
  }

  /**
   * A socket closed while we were connected — the daemon exited, crashed, or
   * was killed. `disconnect()` never lands here: it clears `connected` before
   * destroying the sockets, so their close events return at the guard.
   */
  private handleDisconnect(): void {
    if (!this.connected) return;
    this.cleanup();
    console.warn("[terminal-host] lost connection to daemon; reconnecting");
    // Mid-loop (the connection died while being re-established) the loss
    // was already reported, and the running loop carries on retrying.
    if (!this.reconnecting) {
      this.notifyListener("onLost", { sessionIds: [...this.wanted] });
    }
    void this.reconnectAfterLoss();
  }

  /** Shared teardown for both intentional disconnect and unexpected connection loss */
  private cleanup(): void {
    this.connected = false;
    this.controlSocket?.destroy();
    this.streamSocket?.destroy();
    this.controlSocket = null;
    this.streamSocket = null;

    // Reset buffers and mutex so stale state doesn't corrupt the next connection
    this.controlBuffer = "";
    this.streamBuffer = "";
    this.requestMutex = Promise.resolve();

    // Reject pending requests
    for (const [, req] of this.pendingRequests) {
      if (req.timeout) clearTimeout(req.timeout);
      req.reject(new Error("Disconnected"));
    }
    this.pendingRequests.clear();

    // The daemon kills a closed stream socket's exec children, so every
    // stream already sent is over — say so rather than leave it hanging.
    for (const entry of [...this.execStreams.values()]) {
      if (entry.started) {
        entry.finish({
          exitCode: null,
          error: "Lost connection to the terminal host",
        });
      }
    }
  }
}
