/**
 * LocalTransport — reaches the terminal-host daemon on this machine.
 *
 * - Spawns the daemon as a detached child process if it is not running
 * - Connects over the unix socket in its namespace's daemon directory
 *   (~/.manor/daemon/ for Manor desktop, ~/.manor/remote/daemon/ for
 *   `manor-host remote-bridge` — see `DaemonNamespace` in electron/paths.ts)
 * - Reads the auth token from the 0600 token file beside it
 *
 * In the `remote` namespace, a box whose daemon is under a supervisor
 * (`supervisor.json`, ADR-229 D4) starts, stops and restarts it through that
 * supervisor, never spawning a detached copy beside it; one that fails falls
 * back to the detached spawn with a warning. The `local` namespace (Manor
 * desktop's own daemon) never looks.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import {
  daemonDir,
  daemonLogFile,
  daemonPidFile,
  daemonSocketFile,
  daemonTokenFile,
  manorHomeDir,
  type DaemonNamespace,
} from "../paths";
import type { HostTransport } from "./transport";
import { loadSupervisor, type Supervisor } from "../host-server/supervisor";
import { errorMessage } from "../lib/errors";

const MANOR_DIR = manorHomeDir();

/** How long a supervisor gets to bring the daemon up before the detached fallback. */
const SUPERVISED_WAIT_MS = 8000;

/** Past this size the daemon log is rotated to `.log.1` at the next spawn. */
const MAX_DAEMON_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Open the daemon's log for appending, first rotating it (one generation) if
 * it has grown past `MAX_DAEMON_LOG_BYTES`. Returns an fd for the child's
 * stderr, or "ignore" if the log cannot be opened.
 */
function openDaemonLog(logPath: string): number | "ignore" {
  try {
    if (fs.statSync(logPath).size > MAX_DAEMON_LOG_BYTES) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // No log yet.
  }
  try {
    return fs.openSync(logPath, "a", 0o600);
  } catch {
    return "ignore";
  }
}

export interface LocalTransportOptions {
  /**
   * Which of this machine's daemons to reach (and spawn). Defaults to
   * `local`, Manor desktop's own; `manor-host remote-bridge` uses `remote`.
   */
  namespace?: DaemonNamespace;
  /**
   * The `remote` namespace's supervisor, asked on every start, stop and
   * restart (ADR-229 D4). Defaults to the one `supervisor.json` names; never
   * consulted for `local`. For tests.
   */
  supervisor?: () => Supervisor | null;
}

export class LocalTransport implements HostTransport {
  private daemonProcess: ChildProcess | null = null;
  private _migratedOldDaemons = false;
  private readonly namespace: DaemonNamespace;
  private readonly loadSupervisor: () => Supervisor | null;

  constructor(opts: LocalTransportOptions = {}) {
    this.namespace = opts.namespace ?? "local";
    this.loadSupervisor = opts.supervisor ?? loadSupervisor;
  }

  /** This daemon's supervisor; always null for the desktop's own (`local`). */
  private supervisor(): Supervisor | null {
    return this.namespace === "remote" ? this.loadSupervisor() : null;
  }

  private get daemonDir(): string {
    return daemonDir(this.namespace);
  }

  private get SOCKET_PATH(): string {
    return daemonSocketFile(this.namespace);
  }

  private get TOKEN_PATH(): string {
    return daemonTokenFile(this.namespace);
  }

  private get PID_PATH(): string {
    return daemonPidFile(this.namespace);
  }

  private get LOG_PATH(): string {
    return daemonLogFile(this.namespace);
  }

  async ensureRunning(version?: string): Promise<void> {
    // One-time cleanup of old versioned daemons from the previous path scheme
    await this.migrateOldDaemons();

    // Check if daemon is running
    if (!this.isDaemonRunning()) {
      await this.startDaemon(version);
    }
  }

  async restart(version?: string): Promise<void> {
    await this.killAndRespawn(version);
  }

  /**
   * SIGTERM the running daemon (if any) and clear its socket and pid file,
   * without spawning a replacement. The next `ensureRunning` starts a fresh
   * one. Backs `manor-host restart`, which a client on another machine runs over ssh.
   */
  async stop(): Promise<void> {
    const killed = this.readPid();
    const supervisor = this.supervisor();
    if (supervisor) {
      // Then the pid below too: the running daemon may be a detached one
      // from before `install`, which the supervisor cannot reach.
      await supervisor.stop("daemon").catch((err: unknown) => {
        console.warn(
          `[transport-local] the ${supervisor.kind} supervisor could not stop the daemon: ${errorMessage(err)}`,
        );
      });
    }
    await this.killDaemonByPid();
    // Grace period for the process to exit and release the socket
    await new Promise<void>((r) => setTimeout(r, 500));
    // Only while they are still the stopped daemon's. A client that found it
    // gone — a box's host server reconnecting at once — may have started the
    // next one within the grace period, and its socket and pid file are in
    // these places now: unlinking them would leave it unreachable, and the
    // next client would start a second daemon beside it.
    const current = this.readPid();
    if (current !== null && current !== killed) return;
    try { fs.unlinkSync(this.SOCKET_PATH); } catch { /* already gone */ }
    try { fs.unlinkSync(this.PID_PATH); } catch { /* already gone */ }
  }

  /** The pid the pid file names, or null when there is none to read. */
  private readPid(): number | null {
    try {
      const pid = parseInt(fs.readFileSync(this.PID_PATH, "utf-8").trim(), 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  connectControl(): Promise<Duplex> {
    return this.connectSocket();
  }

  connectStream(): Promise<Duplex> {
    return this.connectSocket();
  }

  async authToken(): Promise<string> {
    return fs.readFileSync(this.TOKEN_PATH, "utf-8").trim();
  }

  async dispose(): Promise<void> {
    // The daemon is detached and outlives this process on purpose; there is
    // nothing held here to release.
  }

  // ── Internal ──

  private connectSocket(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.SOCKET_PATH, () => {
        resolve(socket);
      });
      socket.on("error", reject);
    });
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

  /** Kill the current daemon and start a fresh replacement. */
  private async killAndRespawn(version?: string): Promise<void> {
    await this.stop();
    await this.startDaemon(version);
  }

  /**
   * Start the daemon: through the supervisor when there is one (ADR-229 D4),
   * else — or when the supervisor brings none up — spawned detached.
   */
  private async startDaemon(version?: string): Promise<void> {
    const supervisor = this.supervisor();
    if (supervisor) {
      try {
        // A stale socket must not pass for the started daemon's.
        try { fs.unlinkSync(this.SOCKET_PATH); } catch { /* not there */ }
        await supervisor.start("daemon");
        await this.waitForDaemon(SUPERVISED_WAIT_MS);
        return;
      } catch (err) {
        console.warn(
          `[transport-local] the ${supervisor.kind} supervisor did not start the daemon (${errorMessage(err)}); spawning it detached`,
        );
      }
    }
    await this.spawnDaemon(version);
  }

  /** Wait until the pid file names a live daemon and its socket exists. */
  private async waitForDaemon(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.isDaemonRunning()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the daemon's socket did not appear in time");
  }

  /**
   * One-time migration: SIGTERM any leftover daemons from the old versioned
   * path scheme (~/.manor/daemons/{version}/). Runs once per process lifetime.
   */
  private async migrateOldDaemons(): Promise<void> {
    if (this._migratedOldDaemons) return;
    // The versioned scheme predates the remote namespace; only a local
    // client may have left daemons there.
    if (this.namespace !== "local") return;
    this._migratedOldDaemons = true;
    const legacyDaemonsDir = path.join(MANOR_DIR, "daemons");
    try {
      const entries = fs.readdirSync(legacyDaemonsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pidFile = path.join(legacyDaemonsDir, entry.name, "terminal-host.pid");
        try {
          const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
          if (!isNaN(pid)) process.kill(pid, "SIGTERM");
        } catch {
          // PID file missing or process already gone — skip
        }
      }
    } catch {
      // Legacy directory doesn't exist — nothing to migrate
    }
  }

  private async spawnDaemon(version?: string): Promise<void> {
    fs.mkdirSync(this.daemonDir, { recursive: true, mode: 0o700 });

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
    if (version) {
      env.MANOR_VERSION = version;
    }

    // The daemon's stderr goes to a log file, never to ours. It is detached
    // and outlives us: inheriting our stderr would, under `remote-bridge`,
    // hold the ssh channel open forever, and once that channel went away the
    // daemon's next log line would hit EPIPE.
    const logFd = openDaemonLog(this.LOG_PATH);
    try {
      // The daemon resolves its own paths from this argv (see index.ts).
      const args =
        this.namespace === "local"
          ? [daemonScript]
          : [daemonScript, "--namespace", this.namespace];
      this.daemonProcess = spawn(process.execPath, args, {
        env,
        stdio: ["ignore", "ignore", logFd],
        detached: true,
      });
    } finally {
      if (typeof logFd === "number") fs.closeSync(logFd);
    }

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
}
