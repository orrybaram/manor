/**
 * TerminalHostClient — used by the Electron main process to communicate with the daemon.
 *
 * - Spawns daemon if not running
 * - Control socket: request/response (NDJSON)
 * - Stream socket: fire-and-forget writes + event subscription
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import type {
  ControlRequest,
  ControlResponse,
  StreamEvent,
  SessionInfo,
  TerminalSnapshot,
  AgentStatus,
  AgentKind,
} from "./types";

const MANOR_DIR = path.join(os.homedir(), ".manor");

type StreamEventHandler = (event: StreamEvent) => void;

export class TerminalHostClient {
  private controlSocket: net.Socket | null = null;
  private streamSocket: net.Socket | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (resp: ControlResponse) => void;
      reject: (err: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private requestIdCounter = 0;
  /** Serializes control requests so only one is in-flight at a time,
   *  preventing FIFO response mismatch from concurrent callers. */
  private requestMutex: Promise<void> = Promise.resolve();
  private controlBuffer = "";
  private streamBuffer = "";
  private eventHandler: StreamEventHandler | null = null;
  private daemonProcess: ChildProcess | null = null;
  private clientVersion: string | undefined;

  constructor(version?: string) {
    this.clientVersion = version;
  }

  setVersion(version: string): void {
    this.clientVersion = version;
  }

  private get daemonDir(): string {
    return path.join(MANOR_DIR, "daemons", this.clientVersion || "unknown");
  }

  private get SOCKET_PATH(): string {
    return path.join(this.daemonDir, "terminal-host.sock");
  }

  private get TOKEN_PATH(): string {
    return path.join(this.daemonDir, "terminal-host.token");
  }

  private get PID_PATH(): string {
    return path.join(this.daemonDir, "terminal-host.pid");
  }

  /** Set a handler for stream events (data, exit, cwd, error) */
  onEvent(handler: StreamEventHandler): void {
    this.eventHandler = handler;
  }

  /** Connect to the daemon, spawning it if necessary */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    // Check if daemon is running
    if (!this.isDaemonRunning()) {
      await this.spawnDaemon();
    }

    // Connect control socket
    await this.connectControlSocket();

    // Authenticate
    const token = fs.readFileSync(this.TOKEN_PATH, "utf-8").trim();
    const authResp = await this.request({ type: "auth", token });
    if (authResp.type !== "authOk") {
      throw new Error(
        `Auth failed: ${authResp.type === "error" ? authResp.message : "unknown"}`,
      );
    }

    // Push current env vars to the daemon so new PTY sessions inherit fresh
    // values (e.g. MANOR_HOOK_PORT may have changed since the daemon spawned).
    const envKeys = [
      "MANOR_HOOK_PORT",
      "MANOR_WEBVIEW_PORT",
      "MANOR_PORTLESS_PORT",
    ];
    const envUpdate: Record<string, string> = {};
    for (const key of envKeys) {
      if (process.env[key]) {
        envUpdate[key] = process.env[key]!;
      }
    }
    if (Object.keys(envUpdate).length > 0) {
      await this.request({ type: "updateEnv", env: envUpdate });
    }

    // Connect stream socket
    await this.connectStreamSocket(token);

    this.connected = true;
  }

  /** Disconnect from the daemon */
  disconnect(): void {
    this.cleanup();
  }

  /** Create a new session or attach to existing one */
  async createOrAttach(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    shellArgs?: string[],
  ): Promise<{ session: SessionInfo; snapshot: TerminalSnapshot | null }> {
    return this.doCreateOrAttach(sessionId, cwd, cols, rows, shellArgs, true);
  }

  private async doCreateOrAttach(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    shellArgs?: string[],
    canRetry = true,
  ): Promise<{ session: SessionInfo; snapshot: TerminalSnapshot | null }> {
    await this.ensureConnected();

    try {
      // Check if the daemon already has this session (warm restore).
      // Use getSnapshot instead of attach to avoid adding the control socket
      // to the session's broadcast list (which would corrupt the control protocol).
      const snapshotResp = await this.request({
        type: "getSnapshot",
        sessionId,
      });
      if (snapshotResp.type === "snapshot") {
        // Session exists — resize to match new terminal dimensions before subscribing,
        // so we don't receive a SIGWINCH-triggered prompt redraw as a stream event.
        await this.request({ type: "resize", sessionId, cols, rows });
        // Subscribe on stream socket for ongoing events
        this.streamWrite({ type: "subscribe", sessionId });
        return {
          session: { sessionId, cwd, cols, rows, alive: true },
          snapshot: snapshotResp.snapshot,
        };
      }

      // Create new session
      const createResp = await this.request({
        type: "create",
        sessionId,
        cwd,
        cols,
        rows,
        shellArgs,
      });
      if (createResp.type !== "created") {
        throw new Error(
          `Create failed: ${createResp.type === "error" ? createResp.message : `unexpected response type: ${createResp.type}`}`,
        );
      }

      // Subscribe for stream events immediately (no control socket attach needed)
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
  ): Promise<SessionInfo> {
    await this.ensureConnected();
    const resp = await this.request({
      type: "create",
      sessionId,
      cwd,
      cols,
      rows,
      prewarmed,
    });
    if (resp.type !== "created") {
      throw new Error(
        `Create failed: ${resp.type === "error" ? resp.message : resp.type}`,
      );
    }
    return resp.session;
  }

  /** Write terminal input — fire-and-forget via stream socket */
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

  /** Resize a session's terminal */
  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.ensureConnected();
    await this.request({ type: "resize", sessionId, cols, rows });
  }

  /** Kill a session */
  async kill(sessionId: string): Promise<void> {
    await this.ensureConnected();
    this.streamWrite({ type: "unsubscribe", sessionId });
    await this.request({ type: "kill", sessionId });
  }

  /** Detach from a session (keep it alive in daemon) */
  async detach(sessionId: string): Promise<void> {
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

  // ── Internal ──

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  private isDaemonRunning(): boolean {
    try {
      const pid = parseInt(fs.readFileSync(this.PID_PATH, "utf-8").trim(), 10);
      process.kill(pid, 0); // Check if process exists
      // Also check socket exists
      return fs.existsSync(this.SOCKET_PATH);
    } catch {
      return false;
    }
  }

  private async killDaemonByPid(): Promise<void> {
    try {
      const pid = parseInt(fs.readFileSync(this.PID_PATH, "utf-8").trim(), 10);
      process.kill(pid, "SIGTERM");
    } catch {
      // PID file missing or process already gone — ignore
    }
  }

  private async spawnDaemon(): Promise<void> {
    fs.mkdirSync(this.daemonDir, { recursive: true });

    // Clean up stale socket so waitForSocket waits for the NEW daemon's socket
    try {
      fs.unlinkSync(this.SOCKET_PATH);
    } catch {
      // doesn't exist
    }

    const daemonScript = path.join(__dirname, "terminal-host-index.js");

    const env: Record<string, string | undefined> = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    };
    if (this.clientVersion) {
      env.MANOR_VERSION = this.clientVersion;
    }

    this.daemonProcess = spawn(process.execPath, [daemonScript], {
      env,
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    });

    this.daemonProcess.unref();

    // Wait for socket to appear
    await this.waitForSocket(5000);
  }

  private async waitForSocket(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(this.SOCKET_PATH)) {
        // Small extra delay for the server to be ready
        await new Promise((r) => setTimeout(r, 100));
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      "Daemon failed to start: socket not created within timeout",
    );
  }

  private connectControlSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.controlSocket = net.createConnection(this.SOCKET_PATH, () => {
        resolve();
      });

      this.controlSocket.on("data", (chunk) => {
        this.controlBuffer += chunk.toString("utf-8");
        const lines = this.controlBuffer.split("\n");
        this.controlBuffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const resp = JSON.parse(line) as ControlResponse;
            // Mutex guarantees at most one pending request
            const firstKey = this.pendingRequests.keys().next().value;
            if (firstKey !== undefined) {
              const pending = this.pendingRequests.get(firstKey)!;
              this.pendingRequests.delete(firstKey);
              clearTimeout(pending.timeout);
              pending.resolve(resp);
            }
          } catch {
            // invalid JSON, skip
          }
        }
      });

      this.controlSocket.on("error", (err) => {
        if (!this.connected) {
          reject(err);
        } else {
          this.handleDisconnect();
        }
      });

      this.controlSocket.on("close", () => {
        this.handleDisconnect();
      });
    });
  }

  private connectStreamSocket(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.streamSocket = net.createConnection(this.SOCKET_PATH, () => {
        // Send init message identifying this as a stream connection
        this.streamSocket!.write(
          JSON.stringify({ connectionType: "stream", token }) + "\n",
        );
        resolve();
      });

      this.streamSocket.on("data", (chunk) => {
        this.streamBuffer += chunk.toString("utf-8");
        const lines = this.streamBuffer.split("\n");
        this.streamBuffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as StreamEvent;
            this.eventHandler?.(event);
          } catch {
            // invalid JSON, skip
          }
        }
      });

      this.streamSocket.on("error", (err) => {
        if (!this.connected) reject(err);
      });

      this.streamSocket.on("close", () => {
        this.handleDisconnect();
      });
    });
  }

  private request(
    req: ControlRequest,
    timeoutMs = 10_000,
  ): Promise<ControlResponse> {
    const result = this.requestMutex.then(() =>
      this.doRequest(req, timeoutMs),
    );
    this.requestMutex = result.then(() => {}, () => {});
    return result;
  }

  private doRequest(
    req: ControlRequest,
    timeoutMs: number,
  ): Promise<ControlResponse> {
    return new Promise((resolve, reject) => {
      if (!this.controlSocket?.writable) {
        reject(new Error("Control socket not writable"));
        return;
      }

      const requestId = String(++this.requestIdCounter);

      const timeout = setTimeout(() => {
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

  private handleDisconnect(): void {
    if (!this.connected) return;
    this.cleanup();
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
      clearTimeout(req.timeout);
      req.reject(new Error("Disconnected"));
    }
    this.pendingRequests.clear();
  }
}
