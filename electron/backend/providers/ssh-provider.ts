/**
 * SshHostProvider — a box the user brings, reached over ssh (ADR-178 §1).
 *
 * Wraps ADR-160's `SshTransport`. The box is assumed to be always on, so
 * `ensureUp` has nothing to do and there is no keep-awake. Port forwards ride
 * the transport's existing ControlMaster (`ssh -O forward`), so they cost no
 * new connection or authentication.
 */

import { spawn as nodeSpawn } from "node:child_process";
import * as net from "node:net";
import { buildControlArgs } from "../../terminal-host/ssh-config";
import {
  SshTransport,
  type SshChild,
  type SshSpawn,
} from "../../terminal-host/transport-ssh";
import { remoteHostEnsurer, type BootstrapProgress } from "../remote-bootstrap";
import type {
  HostProvider,
  HostProviderCapabilities,
  HostProviderStatus,
  PortForward,
} from "./types";

const CONTROL_TIMEOUT_MS = 5_000;
const MAX_STDERR_BYTES = 4 * 1024;

const defaultSpawn: SshSpawn = (command, args) =>
  nodeSpawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

/** Ask the OS for a free loopback port. Racy by nature; ssh reports a clash. */
function findFreeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("Could not allocate a local port"));
      });
    });
  });
}

/**
 * The `-L` spec for a forward: `<local>` on loopback to `<remote>` on the box's
 * loopback. The local bind address is explicit so a user's `GatewayPorts yes`
 * (pulled in via the included ~/.ssh/config) can't expose the forward to the LAN.
 */
export function forwardSpec(localPort: number, remotePort: number): string[] {
  return ["-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`];
}

function assertPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label} port: ${port}`);
  }
}

export interface SshHostProviderOptions {
  /** Bootstrap progress from the transport's host ensurer. */
  onBootstrapProgress?: (progress: BootstrapProgress) => void;
  /** Replaces the `SshTransport`. For tests. */
  transport?: SshTransport;
  /** Spawns the `ssh -O` control commands. Defaults to `child_process.spawn`. */
  spawn?: SshSpawn;
  /** Picks the local end of a forward. For tests. */
  findFreePort?: () => Promise<number>;
}

export class SshHostProvider implements HostProvider {
  readonly kind = "ssh" as const;
  readonly capabilities: HostProviderCapabilities = {
    autoSleep: false,
    persistsMemory: false,
    previewUrls: false,
  };

  private readonly sshTransport: SshTransport;
  private readonly spawnFn: SshSpawn;
  private readonly findFreePort: () => Promise<number>;
  /** Live forwards, keyed by their local port. */
  private readonly forwards = new Map<number, { remotePort: number; configPath: string }>();
  /** Bumped by dispose(); a forwardPort() that straddles it cancels its own forward. */
  private generation = 0;

  constructor(
    readonly target: string,
    opts: SshHostProviderOptions = {},
  ) {
    this.sshTransport =
      opts.transport ??
      new SshTransport(target, {
        // Runs inside every client connect, before the bridge is opened —
        // so connect() installs or upgrades manor-host first.
        ensureRemoteHost: remoteHostEnsurer({ onProgress: opts.onBootstrapProgress }),
      });
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.findFreePort = opts.findFreePort ?? findFreeLocalPort;
  }

  /** A BYO box is always on; there is nothing to start. */
  async ensureUp(): Promise<void> {}

  /**
   * `up` while the ControlMaster answers `-O check`, `unreachable` otherwise
   * (including before the first connect, when there is no master to ask).
   */
  async status(): Promise<HostProviderStatus> {
    const configPath = this.sshTransport.configPath;
    if (!configPath) return "unreachable";
    try {
      const { code } = await this.runControl(
        buildControlArgs(configPath, this.target, "check"),
      );
      return code === 0 ? "up" : "unreachable";
    } catch {
      return "unreachable";
    }
  }

  transport(): SshTransport {
    return this.sshTransport;
  }

  async forwardPort(remotePort: number): Promise<PortForward> {
    assertPort(remotePort, "remote");
    const configPath = this.sshTransport.configPath;
    if (!configPath) {
      throw new Error(`Cannot forward port ${remotePort}: not connected to ${this.target}`);
    }
    const generation = this.generation;
    const localPort = await this.findFreePort();
    assertPort(localPort, "local");
    const cancelArgs = buildControlArgs(
      configPath,
      this.target,
      "cancel",
      forwardSpec(localPort, remotePort),
    );
    let result: { code: number | null; stderr: string };
    try {
      result = await this.runControl(
        buildControlArgs(configPath, this.target, "forward", forwardSpec(localPort, remotePort)),
      );
    } catch (err) {
      // A timeout may fire after ssh already set the forward up.
      this.runControl(cancelArgs).catch(() => {});
      throw err;
    }
    const { code, stderr } = result;
    if (generation !== this.generation) {
      if (code === 0) this.runControl(cancelArgs).catch(() => {});
      throw new Error(`Port forward to ${this.target} was cancelled: provider disposed`);
    }
    if (code !== 0) {
      const detail = stderr.trim();
      throw new Error(
        `ssh could not forward port ${remotePort} on ${this.target}` +
          (detail ? `: ${detail}` : ` (exit ${code ?? "unknown"})`),
      );
    }
    this.forwards.set(localPort, { remotePort, configPath });
    return {
      localPort,
      dispose: () => {
        this.cancelForward(localPort).catch(() => {
          // Best effort: the master may already be gone, taking the forward with it.
        });
      },
    };
  }

  /** Cancel every forward. The transport (and its master) is left alone. */
  async dispose(): Promise<void> {
    this.generation++;
    await Promise.allSettled(
      Array.from(this.forwards.keys(), (localPort) => this.cancelForward(localPort)),
    );
  }

  // ── Internal ──

  private async cancelForward(localPort: number): Promise<void> {
    const forward = this.forwards.get(localPort);
    if (!forward) return;
    this.forwards.delete(localPort);
    await this.runControl(
      buildControlArgs(
        forward.configPath,
        this.target,
        "cancel",
        forwardSpec(localPort, forward.remotePort),
      ),
    );
  }

  /** Run one `ssh -O …` against the ControlMaster. */
  private runControl(args: string[]): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      let child: SshChild;
      try {
        child = this.spawnFn("ssh", args);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf-8")).slice(-MAX_STDERR_BYTES);
      });
      child.stdout?.resume();
      child.stdin?.on("error", () => {});
      child.stdin?.end();
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`ssh -O to ${this.target} timed out`));
      }, CONTROL_TIMEOUT_MS);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    });
  }
}
