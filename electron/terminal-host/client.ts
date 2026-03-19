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
} from "./types";

const MANOR_DIR = path.join(os.homedir(), ".manor");
const SOCKET_PATH = path.join(MANOR_DIR, "terminal-host.sock");
const TOKEN_PATH = path.join(MANOR_DIR, "terminal-host.token");
const PID_PATH = path.join(MANOR_DIR, "terminal-host.pid");

type StreamEventHandler = (event: StreamEvent) => void;

export class TerminalHostClient {
  private controlSocket: net.Socket | null = null;
  private streamSocket: net.Socket | null = null;
  private connected = false;
  private connecting = false;
  private pendingRequests: Array<{
    resolve: (resp: ControlResponse) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  private controlBuffer = "";
  private streamBuffer = "";
  private eventHandler: StreamEventHandler | null = null;
  private daemonProcess: ChildProcess | null = null;

  /** Set a handler for stream events (data, exit, cwd, error) */
  onEvent(handler: StreamEventHandler): void {
    this.eventHandler = handler;
  }

  /** Connect to the daemon, spawning it if necessary */
  async connect(): Promise<void> {
    if (this.connected || this.connecting) return;
    this.connecting = true;

    try {
      // Check if daemon is running
      if (!this.isDaemonRunning()) {
        await this.spawnDaemon();
      }

      // Connect control socket
      await this.connectControlSocket();

      // Authenticate
      const token = fs.readFileSync(TOKEN_PATH, "utf-8").trim();
      const authResp = await this.request({ type: "auth", token });
      if (authResp.type !== "authOk") {
        throw new Error(`Auth failed: ${authResp.type === "error" ? authResp.message : "unknown"}`);
      }

      // Connect stream socket
      await this.connectStreamSocket(token);

      this.connected = true;
    } finally {
      this.connecting = false;
    }
  }

  /** Disconnect from the daemon */
  disconnect(): void {
    this.connected = false;
    this.controlSocket?.destroy();
    this.streamSocket?.destroy();
    this.controlSocket = null;
    this.streamSocket = null;

    // Reject pending requests
    for (const req of this.pendingRequests) {
      clearTimeout(req.timeout);
      req.reject(new Error("Disconnected"));
    }
    this.pendingRequests = [];
  }

  /** Create a new session or attach to existing one */
  async createOrAttach(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    shellArgs?: string[],
  ): Promise<{ session: SessionInfo; snapshot: TerminalSnapshot | null }> {
    await this.ensureConnected();

    // Try to attach first
    const attachResp = await this.request({ type: "attach", sessionId });
    if (attachResp.type === "attached") {
      // Subscribe on stream socket
      this.streamWrite({ type: "subscribe", sessionId });
      return { session: { sessionId, cwd, cols: 0, rows: 0, alive: true }, snapshot: attachResp.snapshot };
    }

    // Create new session
    const createResp = await this.request({ type: "create", sessionId, cwd, cols, rows, shellArgs });
    if (createResp.type !== "created") {
      throw new Error(`Create failed: ${createResp.type === "error" ? createResp.message : "unknown"}`);
    }

    // Attach for stream events
    await this.request({ type: "attach", sessionId });
    this.streamWrite({ type: "subscribe", sessionId });

    return { session: createResp.session, snapshot: null };
  }

  /** Write terminal input — fire-and-forget via stream socket */
  writeNoAck(sessionId: string, data: string): void {
    this.streamWrite({ type: "write", sessionId, data });
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
      const pid = parseInt(fs.readFileSync(PID_PATH, "utf-8").trim(), 10);
      process.kill(pid, 0); // Check if process exists
      // Also check socket exists
      return fs.existsSync(SOCKET_PATH);
    } catch {
      return false;
    }
  }

  private async spawnDaemon(): Promise<void> {
    fs.mkdirSync(MANOR_DIR, { recursive: true });

    const daemonScript = path.join(__dirname, "terminal-host-index.js");

    this.daemonProcess = spawn(process.execPath, [daemonScript], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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
      if (fs.existsSync(SOCKET_PATH)) {
        // Small extra delay for the server to be ready
        await new Promise((r) => setTimeout(r, 100));
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Daemon failed to start: socket not created within timeout");
  }

  private connectControlSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.controlSocket = net.createConnection(SOCKET_PATH, () => {
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
            const pending = this.pendingRequests.shift();
            if (pending) {
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
      this.streamSocket = net.createConnection(SOCKET_PATH, () => {
        // Send init message identifying this as a stream connection
        this.streamSocket!.write(JSON.stringify({ connectionType: "stream", token }) + "\n");
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

  private request(req: ControlRequest, timeoutMs = 10_000): Promise<ControlResponse> {
    return new Promise((resolve, reject) => {
      if (!this.controlSocket?.writable) {
        reject(new Error("Control socket not writable"));
        return;
      }

      const timeout = setTimeout(() => {
        const idx = this.pendingRequests.findIndex((p) => p.timeout === timeout);
        if (idx >= 0) this.pendingRequests.splice(idx, 1);
        reject(new Error(`Request timed out: ${req.type}`));
      }, timeoutMs);

      this.pendingRequests.push({ resolve, reject, timeout });
      this.controlSocket.write(JSON.stringify(req) + "\n");
    });
  }

  private streamWrite(cmd: unknown): void {
    if (this.streamSocket?.writable) {
      this.streamSocket.write(JSON.stringify(cmd) + "\n");
    }
  }

  private handleDisconnect(): void {
    if (!this.connected) return;
    this.connected = false;

    // Reject pending requests
    for (const req of this.pendingRequests) {
      clearTimeout(req.timeout);
      req.reject(new Error("Disconnected"));
    }
    this.pendingRequests = [];
  }
}
