/**
 * TerminalHostClient — used by the Electron main process to communicate with the daemon.
 *
 * - Reaches the daemon through a HostTransport (LocalTransport by default),
 *   which spawns it if it is not running
 * - Control socket: request/response (NDJSON), see `RpcChannel`
 * - Stream socket: fire-and-forget writes + event subscription, see `StreamChannel`
 * - Unexpected loss: reconnects on its own, see `ReconnectSupervisor`
 */

import type {
  SessionInfo,
  TerminalSnapshot,
  HookReplay,
  PaneFacts,
  StreamCommand,
} from "./types";
import { isDaemonStale } from "./types";
import type { HostTransport } from "./transport";
import { LocalTransport } from "./transport-local";
import { execReplyTimeoutMs } from "./exec-runner";
import { errorMessage } from "../lib/errors";
import { DEFAULT_REQUEST_TIMEOUT_MS, RpcChannel } from "./rpc-channel";
import { StreamChannel, type StreamEventHandler } from "./stream-channel";
import { SessionSubscriptions } from "./session-subscriptions";
import {
  ReconnectSupervisor,
  type ConnectionListener,
  type ReconnectPolicy,
} from "./reconnect-supervisor";
import {
  ExecStreamRegistry,
  type ExecStreamCallbacks,
} from "./exec-stream-registry";

export type { ConnectionListener, ReconnectPolicy } from "./reconnect-supervisor";
export type { ExecStreamCallbacks } from "./exec-stream-registry";

/** Client-side timeout for `readFile` (up to 10 MiB, possibly over ssh). */
const READ_FILE_TIMEOUT_MS = 30_000;

/** Client-side timeout for `writeFile` (up to 20 MiB, possibly over ssh). */
const WRITE_FILE_TIMEOUT_MS = 60_000;

/**
 * Timeout for listing a stale daemon's sessions before replacing it
 * (ADR-185 §A). Short on purpose: a daemon too old to answer at all must
 * never hold up the restart it is about to get anyway.
 */
const STALE_DAEMON_SESSIONS_TIMEOUT_MS = 2_000;

/** This process's env pushed to the daemon on every connect. */
const LOCAL_ENV_KEYS = [
  "MANOR_HOOK_PORT",
  "MANOR_WEBVIEW_PORT",
  "MANOR_PORTLESS_PORT",
] as const;

/**
 * The env to push to the daemon on connect, so new PTY sessions inherit fresh
 * values (e.g. MANOR_HOOK_PORT may have changed since the daemon spawned).
 * The `LOCAL_ENV_KEYS` are ports on this machine; a remote daemon's role drops
 * them (ADR-178 §2), so the client does not need to know which kind it has.
 *
 * Explicit `updateEnv` values win over inherited ones in general, but for the
 * MANOR_* port keys the live process.env value must win: a remembered override
 * from a previous connect can hold a now-stale port (e.g. MANOR_HOOK_PORT from
 * before this process's hook server was recreated on a later port).
 */
function envForConnect(overrides: Record<string, string>): Record<string, string> {
  const env = { ...overrides };
  for (const key of LOCAL_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

/**
 * How often to ping a connected daemon, and how long to wait for its pong
 * before presuming the connection dead (ADR-188 §2).
 */
export interface HeartbeatOptions {
  intervalMs: number;
  timeoutMs: number;
}

function disconnectedWhileConnecting(): Error {
  return new Error("Disconnected while connecting");
}

export class TerminalHostClient {
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  /**
   * A request timed out. Before `connected` it is a failed attempt, which
   * `connect()` already reports. With a heartbeat (a remote host), one slow
   * request is not proof the connection is gone: ask the daemon for a pong
   * (joining a liveness ping already in flight — the one that just timed
   * out, possibly), and only an unanswered one goes through
   * `handleDisconnect` and the reconnect loop (ADR-188 §1). Without a
   * heartbeat (the local daemon) the connection is dropped quietly as
   * before, and the next call reconnects: routing it through the loss path
   * would let a busy daemon run the local policy out of attempts and report
   * every pane's session as exited.
   */
  private readonly rpc = new RpcChannel((type) => {
    // The liveness ping reports its own failure as a loss.
    if (this.connected && type === "ping" && this.livenessPing) return;
    if (this.connected && this.heartbeat) {
      console.warn(`[terminal-host] request timed out: ${type}; checking the daemon is alive`);
      void this.checkLiveness();
      return;
    }
    this.cleanup();
  });
  private readonly stream: StreamChannel = new StreamChannel((event) =>
    this.execStreams.dispatch(event),
  );
  /**
   * Told each time a stream socket is attached and the client connected —
   * the first connect and every reconnect, however it happened (the
   * supervisor's loop, or a call reconnecting on its own). For per-socket
   * daemon state a caller has to set up again, like the control relay.
   */
  private readonly streamConnectedHandlers = new Set<() => void>();
  /** Env set through `updateEnv`, re-sent to the daemon on every connect. */
  private envOverrides: Record<string, string> = {};
  /** Filled by `createOrAttach`, emptied by `kill`/`detach`; survives `cleanup()`. */
  private readonly subscriptions = new SessionSubscriptions({
    listAlive: async () => {
      // Straight to the wire, not `listSessions()`: if the connection is
      // already gone that would start a nested connect behind the caller's
      // back. The caller sees `connected` false and deals with it.
      const { sessions } = await this.rpc.call({ type: "listSessions" });
      return sessions.map((s) => s.sessionId);
    },
    subscribe: (sessionId) => this.stream.write({ type: "subscribe", sessionId }),
    reportExit: (sessionId) =>
      this.stream.emit({ type: "exit", sessionId, exitCode: -1, lost: true }),
  });
  /**
   * Bumped by every intentional `disconnect()`, so a reconnect loop started
   * before it stops instead of reconnecting behind the caller's back.
   */
  private generation = 0;
  /** The `generation` the in-flight `connectPromise` was started under. */
  private connectGeneration = 0;
  /**
   * Bumped by every successful connect, so a ping that fails can tell
   * whether the connection it was sent on is still the current one.
   */
  private connectionId = 0;
  /** Set through `setHeartbeat`; null means no heartbeat (the default). */
  private heartbeat: HeartbeatOptions | null = null;
  /** Runs `heartbeatTick` while connected with a heartbeat set. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** The ping in flight, shared by heartbeat ticks and `checkLiveness`. */
  private livenessPing: Promise<boolean> | null = null;
  private readonly supervisor = new ReconnectSupervisor({
    connect: () => this.connect(),
    isConnected: () => this.connected,
    generation: () => this.generation,
    wantedSessions: () => this.subscriptions.ids(),
    giveUp: () => this.subscriptions.loseAll(),
  });
  private readonly execStreams: ExecStreamRegistry = new ExecStreamRegistry({
    ready: () => this.ensureConnected(),
    send: (cmd) => this.stream.write(cmd),
  });

  /** Timeout for auth + handshake; the transport decides (see `HostTransport`). */
  private get handshakeTimeoutMs(): number {
    return this.transport.handshakeTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  constructor(
    private readonly clientVersion?: string,
    private readonly transport: HostTransport = new LocalTransport(),
    /**
     * Reports the live sessions a stale daemon is about to lose, just before
     * it is replaced (ADR-185 §A) — so the caller can tell its owner an
     * Agent's pty exit is a daemon replacement, not the Agent finishing.
     * Never called with an empty list.
     */
    private readonly onDaemonReplacing?: (sessionIds: string[]) => void,
  ) {}

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
    this.supervisor.setPolicy(policy, opts);
  }

  /**
   * Ping the daemon every `intervalMs` while connected, and treat a ping not
   * answered within `timeoutMs` as a lost connection (ADR-188 §2). Catches a
   * connection that is up but no longer delivering, which a socket close
   * never reports. `null` turns it off, the default.
   */
  setHeartbeat(opts: HeartbeatOptions | null): void {
    this.heartbeat = opts;
    this.stopHeartbeat();
    if (this.connected) this.startHeartbeat();
  }

  /**
   * Ping the daemon now (sharing a ping already in flight) and resolve
   * whether it answered. A failure is handled as a lost connection, exactly
   * as for a heartbeat tick. Resolves false without sending anything when
   * not connected; never starts a connect.
   */
  checkLiveness(): Promise<boolean> {
    if (!this.connected) return Promise.resolve(false);
    return this.sendLivenessPing();
  }

  /** Observe unexpected connection loss and recovery. */
  setConnectionListener(listener: ConnectionListener | null): void {
    this.supervisor.setListener(listener);
  }

  /** Subscribe to stream events (data, exit, cwd, error). Returns an unsubscribe. */
  onEvent(handler: StreamEventHandler): () => void {
    return this.stream.subscribe(handler);
  }

  /**
   * Called after every (re)connect's stream socket is up (see
   * `streamConnectedHandlers`). Returns an unsubscribe.
   */
  onStreamConnected(handler: () => void): () => void {
    this.streamConnectedHandlers.add(handler);
    return () => {
      this.streamConnectedHandlers.delete(handler);
    };
  }

  /**
   * Send a stream command on the current stream socket; false (nothing
   * sent) when there is none. For commands whose answer belongs to that
   * socket, like a `controlResponse` (ADR-189 §1).
   */
  sendStreamCommand(cmd: StreamCommand): boolean {
    return this.stream.write(cmd);
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
    await this.subscriptions.reconcile();
    if (generation !== this.generation) throw disconnectedWhileConnecting();

    if (this.connected) this.supervisor.connectedOutsideLoop();
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
    let token = await this.authenticate(stillWanted);

    // Handshake: replace the running daemon when it cannot serve this client
    // (see `isDaemonStale`) — a protocol mismatch, not merely a different app
    // version (ADR-185 §B).
    const clientVer = this.clientVersion ?? "unknown";
    const hsResp = await this.rpc.request(
      { type: "handshake", clientVersion: clientVer },
      this.handshakeTimeoutMs,
    );
    stillWanted();
    if (isDaemonStale(hsResp)) {
      const sessionIds = await this.staleDaemonSessions();
      stillWanted();
      if (sessionIds.length > 0) this.onDaemonReplacing?.(sessionIds);
      this.cleanup();
      await this.transport.restart(this.clientVersion);
      stillWanted();
      token = await this.authenticate(stillWanted);
    }

    const envUpdate = envForConnect(this.envOverrides);
    if (Object.keys(envUpdate).length > 0) {
      await this.rpc.request({ type: "updateEnv", env: envUpdate });
      stillWanted();
    }

    await this.connectStreamSocket(token);
    stillWanted();

    this.connected = true;
    this.connectionId++;
    this.startHeartbeat();
    for (const handler of [...this.streamConnectedHandlers]) {
      try {
        handler();
      } catch (err) {
        console.error("[terminal-host] stream-connected handler threw:", err);
      }
    }
  }

  /**
   * The stale daemon's live session ids, asked over the control socket
   * that is about to be torn down (ADR-185 §A). A short timeout, and any
   * failure at all, both mean an empty list: a daemon old enough to be
   * replaced may not answer `listSessions` the way this client expects
   * (or at all), and that must never block the restart it is already
   * committed to.
   */
  private async staleDaemonSessions(): Promise<string[]> {
    try {
      const { sessions } = await this.rpc.call(
        { type: "listSessions" },
        STALE_DAEMON_SESSIONS_TIMEOUT_MS,
      );
      return sessions.filter((s) => s.alive).map((s) => s.sessionId);
    } catch {
      return [];
    }
  }

  /**
   * Open the control socket and authenticate on it. Resolves with the token,
   * which the stream socket presents too.
   */
  private async authenticate(stillWanted: () => void): Promise<string> {
    await this.connectControlSocket();
    stillWanted();
    const token = await this.transport.authToken();
    stillWanted();
    const resp = await this.rpc.request(
      { type: "auth", token },
      this.handshakeTimeoutMs,
    );
    stillWanted();
    if (resp.type !== "authOk") {
      throw new Error(
        `Auth failed: ${resp.type === "error" ? resp.message : "unknown"}`,
      );
    }
    return token;
  }

  /**
   * Disconnect from the daemon on purpose. The caller is walking away from
   * its subscriptions too — it will `createOrAttach` again if it wants them —
   * so a later connect must not re-subscribe or report them as exited.
   */
  disconnect(): void {
    this.generation++;
    this.supervisor.cancel();
    this.subscriptions.forgetAll();
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

  /**
   * Cut the reconnect loop's current wait short and attempt now ("Retry
   * now"). Returns false when the loop is not waiting — not reconnecting,
   * or mid-attempt already.
   */
  retryReconnectNow(): boolean {
    return this.supervisor.retryNow();
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
    await this.ensureConnected();
    try {
      return await this.doCreateOrAttach(sessionId, cwd, cols, rows, shellArgs, env);
    } catch (err) {
      // If the connection broke mid-request, reconnect and retry once
      if (this.connected) throw err;
      await this.ensureConnected();
      return this.doCreateOrAttach(sessionId, cwd, cols, rows, shellArgs, env);
    }
  }

  private async doCreateOrAttach(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    shellArgs?: string[],
    env?: Record<string, string>,
  ): Promise<{ session: SessionInfo; snapshot: TerminalSnapshot | null }> {
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
    await this.rpc.call({ type: "resize", sessionId, cols, rows });
    this.subscriptions.want(sessionId);

    // Only a definite `notFound` means spawn a fresh shell. Treating any
    // failure that way would hand a live session to a terminal that thinks
    // it is new — which drops the snapshot, and with it the dedupe that keeps
    // a reattach from repeating output. So an `error` reply throws here.
    const snapshot = await this.rpc.call({ type: "getSnapshot", sessionId });
    if (snapshot.type === "snapshot") {
      return {
        session: { sessionId, cwd, cols, rows, alive: true },
        snapshot: snapshot.snapshot,
      };
    }

    const { session } = await this.rpc.call({
      type: "create", sessionId, cwd, cols, rows, shellArgs, ...(env ? { env } : {}),
    });
    // Subscribe for stream events immediately (no control socket attach needed)
    this.subscriptions.want(sessionId);
    return { session, snapshot: null };
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
    const { session } = await this.rpc.call({
      type: "create", sessionId, cwd, cols, rows, prewarmed, ...(env ? { env } : {}),
    });
    return session;
  }

  /**
   * Write terminal input — fire-and-forget via stream socket.
   *
   * While the daemon is gone the bytes are dropped. There is nothing to
   * deliver them to: the PTY died with the daemon, and the reconnect loop
   * is already on its way to reporting the session as exited.
   */
  writeNoAck(sessionId: string, data: string): void {
    this.stream.write({ type: "write", sessionId, data });
  }

  /** Queue a write that fires after the session's first output (shell prompt).
   *  Uses a control request so the caller gets confirmation the write was queued.
   *  Short timeout (2s) so a stale daemon doesn't block the mutex. */
  async writeAfterReady(sessionId: string, data: string): Promise<void> {
    await this.ensureConnected();
    await this.rpc.call({ type: "writeAfterReady", sessionId, data }, 2_000);
  }

  /**
   * Resize a session's terminal, resolving once the pty is actually at that
   * size — the ioctl has landed, not merely been sent towards it.
   */
  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.ensureConnected();
    await this.rpc.call({ type: "resize", sessionId, cols, rows });
  }

  /** Kill a session */
  kill(sessionId: string): Promise<void> {
    return this.release("kill", sessionId);
  }

  /** Detach from a session (keep it alive in daemon) */
  detach(sessionId: string): Promise<void> {
    return this.release("detach", sessionId);
  }

  private async release(type: "kill" | "detach", sessionId: string): Promise<void> {
    // Forget it before connecting: a reconnect inside ensureConnected must not
    // report a session the app is closing on purpose as unexpectedly exited.
    this.subscriptions.forget(sessionId);
    await this.ensureConnected();
    this.stream.write({ type: "unsubscribe", sessionId });
    await this.rpc.call({ type, sessionId });
  }

  /** Dispose all dead sessions */
  async disposeDead(): Promise<void> {
    await this.ensureConnected();
    await this.rpc.call({ type: "disposeDead" });
  }

  /** Get a session snapshot; null when the daemon has no such session. */
  async getSnapshot(sessionId: string): Promise<TerminalSnapshot | null> {
    await this.ensureConnected();
    const resp = await this.rpc.call({ type: "getSnapshot", sessionId });
    return resp.type === "snapshot" ? resp.snapshot : null;
  }

  /**
   * A session's current Pane facts (ADR-184 §3); null when the daemon has no
   * such session. Lets main resync after a reconnect, when the `paneFacts`
   * events it missed are not replayed.
   */
  async getPaneFacts(sessionId: string): Promise<PaneFacts | null> {
    await this.ensureConnected();
    return (await this.rpc.call({ type: "getPaneFacts", sessionId })).facts;
  }

  /** List all sessions */
  async listSessions(): Promise<SessionInfo[]> {
    await this.ensureConnected();
    return (await this.rpc.call({ type: "listSessions" })).sessions;
  }

  /**
   * Ping the daemon, connecting first if needed. The heartbeat must never
   * trigger a connect, so it does not use this (see `sendLivenessPing`).
   */
  async ping(): Promise<boolean> {
    try {
      await this.ensureConnected();
      await this.rpc.call({ type: "ping" });
      return true;
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
    const { stdout, stderr, exitCode } = await this.rpc.callConcurrent(
      { type: "exec", cmd, args, ...opts },
      execReplyTimeoutMs(opts.timeout),
    );
    return { stdout, stderr, exitCode };
  }

  /** Read a UTF-8 file (at most 10 MiB) on the daemon's host. */
  async readFile(filePath: string): Promise<string> {
    await this.ensureConnected();
    const request = { type: "readFile", path: filePath } as const;
    return (await this.rpc.callConcurrent(request, READ_FILE_TIMEOUT_MS)).contents;
  }

  /**
   * Write `data` to `filePath` on the daemon's host, atomically (ADR-187 §1).
   * Creates the parent directory if needed.
   */
  async writeFile(filePath: string, data: Buffer): Promise<void> {
    await this.ensureConnected();
    const request = {
      type: "writeFile",
      path: filePath,
      base64: data.toString("base64"),
    } as const;
    await this.rpc.callConcurrent(request, WRITE_FILE_TIMEOUT_MS);
  }

  /**
   * How the daemon's host was set up for shell integration and agent hooks
   * (ADR-160 ticket 10): the agent kinds it registered, plus any warnings
   * for connectors it skipped rather than risk clobbering a config it
   * couldn't parse. Throws if the daemon could not bootstrap.
   */
  async bootstrap(): Promise<{ agents: string[]; warnings: string[] }> {
    await this.ensureConnected();
    const resp = await this.rpc.call({ type: "bootstrap" });
    return { agents: resp.agents, warnings: resp.warnings ?? [] };
  }

  /**
   * Hook journal entries after `sinceSeq` from the daemon (ADR-178 §2). With
   * `headOnly`, just the journal's position (no entries). Throws if the
   * daemon has no journal.
   */
  async replayHooks(
    sinceSeq: number,
    opts: { headOnly?: boolean } = {},
  ): Promise<HookReplay> {
    await this.ensureConnected();
    const { entries, lastSeq, epoch } = await this.rpc.call({
      type: "replayHooks", sinceSeq, ...(opts.headOnly ? { headOnly: true } : {}),
    });
    return { entries: opts.headOnly ? [] : entries, lastSeq, epoch };
  }

  /**
   * Set environment variables on the daemon so PTY sessions spawned from now
   * on inherit them. Remembered, and pushed again on every (re)connect, so a
   * respawned daemon gets them too. Sessions already running keep their env.
   */
  async updateEnv(env: Record<string, string>): Promise<void> {
    Object.assign(this.envOverrides, env);
    await this.ensureConnected();
    await this.rpc.call({ type: "updateEnv", env });
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
    return this.execStreams.start(cmd, args, opts, callbacks);
  }

  // ── Internal ──

  private async ensureConnected(): Promise<void> {
    if (!this.connected) await this.connect();
  }

  private async connectControlSocket(): Promise<void> {
    const socket = await this.transport.connectControl();
    this.rpc.attach(socket);

    socket.on("error", () => {
      // Connection failures surface from the transport; once connected, an
      // error here means the daemon went away.
      if (this.connected && this.rpc.owns(socket)) this.handleDisconnect();
    });

    socket.on("close", () => {
      // A socket from an earlier, abandoned attempt must not tear down the
      // connection that replaced it.
      if (this.rpc.owns(socket)) this.handleDisconnect();
    });
  }

  private async connectStreamSocket(token: string): Promise<void> {
    const socket = await this.transport.connectStream();
    this.stream.attach(socket, token);
    socket.on("error", () => {
      // Errors are followed by `close`, which is where loss is handled.
    });
    socket.on("close", () => {
      if (this.stream.owns(socket)) this.handleDisconnect();
    });
  }

  /**
   * The connection was lost while we were connected — a socket closed (the
   * daemon exited, crashed, or was killed), a request timed out, or the
   * heartbeat went unanswered. `reason` goes into the log line.
   * `disconnect()` never lands here: it clears `connected` before destroying
   * the sockets, so their close events return at the guard.
   */
  private handleDisconnect(reason?: string): void {
    if (!this.connected) return;
    this.cleanup();
    const detail = reason ? ` (${reason})` : "";
    console.warn(`[terminal-host] lost connection to daemon${detail}; reconnecting`);
    this.supervisor.connectionLost();
  }

  /** Start pinging on the configured interval, if a heartbeat is set. */
  private startHeartbeat(): void {
    if (!this.heartbeat || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(
      () => this.heartbeatTick(),
      this.heartbeat.intervalMs,
    );
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** One heartbeat: skipped while disconnected or while a ping is pending. */
  private heartbeatTick(): void {
    if (!this.connected || this.livenessPing) return;
    void this.sendLivenessPing();
  }

  /**
   * Send one `ping` straight to the wire (never through `ensureConnected`)
   * and resolve whether it was answered. On failure, report the loss — unless
   * the connection it went out on is already gone, e.g. because its timeout
   * went through `handleDisconnect` already, so it is never reported twice.
   */
  private sendLivenessPing(): Promise<boolean> {
    if (this.livenessPing) return this.livenessPing;
    const connection = this.connectionId;
    const timeoutMs = this.heartbeat?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const ping: Promise<boolean> = this.rpc
      .call({ type: "ping" }, timeoutMs)
      .then(
        () => true,
        (err: unknown) => {
          if (this.connected && connection === this.connectionId) {
            this.handleDisconnect(`heartbeat failed: ${errorMessage(err)}`);
          }
          return false;
        },
      )
      .finally(() => {
        if (this.livenessPing === ping) this.livenessPing = null;
      });
    this.livenessPing = ping;
    return ping;
  }

  /** Shared teardown for both intentional disconnect and unexpected connection loss */
  private cleanup(): void {
    this.connected = false;
    this.stopHeartbeat();
    this.rpc.close();
    this.stream.close();
    this.execStreams.failAll("Lost connection to the terminal host");
  }
}
