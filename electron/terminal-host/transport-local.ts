/**
 * LocalTransport — reaches the terminal-host daemon on this machine.
 *
 * - Spawns the daemon as a detached child process if it is not running
 * - Connects over the unix socket in ~/.manor/daemon/
 * - Reads the auth token from the 0600 token file beside it
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { manorHomeDir } from "../paths";
import type { HostTransport } from "./transport";

const MANOR_DIR = manorHomeDir();

export class LocalTransport implements HostTransport {
  private daemonProcess: ChildProcess | null = null;
  private _migratedOldDaemons = false;

  private get daemonDir(): string {
    return path.join(MANOR_DIR, "daemon");
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

  async ensureRunning(version?: string): Promise<void> {
    // One-time cleanup of old versioned daemons from the previous path scheme
    await this.migrateOldDaemons();

    // Check if daemon is running
    if (!this.isDaemonRunning()) {
      await this.spawnDaemon(version);
    }
  }

  async restart(version?: string): Promise<void> {
    await this.killAndRespawn(version);
  }

  /**
   * SIGTERM the running daemon (if any) and clear its socket and pid file,
   * without spawning a replacement. The next `ensureRunning` starts a fresh
   * one. Backs `manor-host restart`, which a remote client runs over ssh.
   */
  async stop(): Promise<void> {
    await this.killDaemonByPid();
    // Grace period for the process to exit and release the socket
    await new Promise<void>((r) => setTimeout(r, 500));
    try { fs.unlinkSync(this.SOCKET_PATH); } catch { /* already gone */ }
    try { fs.unlinkSync(this.PID_PATH); } catch { /* already gone */ }
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

  /** Kill the current daemon and spawn a fresh replacement. */
  private async killAndRespawn(version?: string): Promise<void> {
    await this.stop();
    await this.spawnDaemon(version);
  }

  /**
   * One-time migration: SIGTERM any leftover daemons from the old versioned
   * path scheme (~/.manor/daemons/{version}/). Runs once per process lifetime.
   */
  private async migrateOldDaemons(): Promise<void> {
    if (this._migratedOldDaemons) return;
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
    if (version) {
      env.MANOR_VERSION = version;
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
}
