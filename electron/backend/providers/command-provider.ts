/**
 * CommandHostProvider — a box reached through an exec prefix rather than
 * ssh (ADR-229 D3): `kubectl exec -i … --`, `docker exec -i <name>`.
 *
 * Wraps a `CommandTransport`. Only ever built inside a `RecipeHostProvider`
 * (ADR-229 D2), when a recipe's `up` returns `connection.type: "exec"`; the
 * recipe provider is the one the registry holds, and adds the real
 * lifecycle around this one. Here the lifecycle is the no-op one, as for an
 * ssh box: `ensureUp` resolves at once, nothing can be stopped or destroyed,
 * and `status` is the last connect's outcome.
 *
 * Port forwards have no ControlMaster to ride. `forwardPort` listens on a
 * local loopback port and runs one `manor-host port-pipe` child per
 * accepted connection, its stdio piped to the socket.
 */

import * as net from "node:net";
import { basename } from "node:path";
import type { Duplex } from "node:stream";
import {
  defaultBridgeSpawn,
  type BridgeChildProcess,
  type BridgeSpawn,
  type EnsureRemoteHost,
} from "../../terminal-host/bridge-spawner";
import { REMOTE_HOST_BIN } from "../../terminal-host/ssh-config";
import { CommandTransport } from "../../terminal-host/transport-command";
import { remoteHostEnsurer, type BootstrapProgress } from "../remote-bootstrap";
import {
  assertPort,
  ConnectOutcome,
  preferredLocalPort,
  type RemoteLoopback,
} from "./connect-and-forward";
import type { HostProvider, PortForward, ProviderCapabilities, ProviderStatus } from "./types";

/** The box addresses a forward may target: only ever its loopback. */
/**
 * The snippet one forwarded connection runs on the box: `manor-host
 * port-pipe <port>`, with `--host ::1` for a server listening only there.
 * Through `sh -c`, so `$HOME` expands — an exec prefix runs its command
 * directly, with no shell to expand `~`.
 */
export function remotePortPipeCommand(port: number, host: RemoteLoopback): string {
  assertPort(port, "remote");
  return `exec ${REMOTE_HOST_BIN} port-pipe ${port}${host === "::1" ? " --host ::1" : ""}`;
}

/** Listen on loopback at `port` (0: any free one); resolves with the bound port. */
function listenLoopback(server: net.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : 0;
      if (bound > 0) resolve(bound);
      else reject(new Error("Could not allocate a local port"));
    });
  });
}

export interface CommandHostProviderOptions {
  /** Bootstrap progress from the transport's host ensurer. */
  onBootstrapProgress?: (progress: BootstrapProgress) => void;
  /** Replaces the `CommandTransport`. For tests. */
  transport?: CommandTransport;
  /** Replaces the transport's host ensurer (`remoteHostEnsurer`). For tests. */
  ensureRemoteHost?: EnsureRemoteHost;
  /** How messages name the box. Defaults to the argv prefix, joined. */
  label?: string;
  /** Spawns the transport's children and the port pipes. Defaults to `child_process.spawn`. */
  spawn?: BridgeSpawn;
}

/** Reached, not managed: the recipe provider around it adds what it can do. */
const COMMAND_CAPABILITIES: ProviderCapabilities = Object.freeze({
  canStop: false,
  canDestroy: false,
  autoSleep: false,
});

/** One live forward: its local listener and the pipes it has running. */
interface CommandForward {
  server: net.Server;
  children: Set<BridgeChildProcess>;
  sockets: Set<net.Socket>;
}

export class CommandHostProvider implements HostProvider {
  /**
   * Only a recipe hands back an exec prefix (ADR-229 D2). Never what
   * `hosts.list` reports: the registry holds the `RecipeHostProvider`
   * around this one, whose kind says how the host was configured.
   */
  readonly kind = "recipe" as const;
  readonly capabilities = COMMAND_CAPABILITIES;

  private readonly commandTransport: CommandTransport;
  private readonly spawnFn: BridgeSpawn;
  /** Live forwards, keyed by their local port. */
  private readonly forwards = new Map<number, CommandForward>();
  /** Bumped by dispose(); a forwardPort() that straddles it cancels its own forward. */
  private generation = 0;
  /**
   * How the last connect went, as the transport's host ensurer saw it (it
   * runs inside every connect): what `status()` reports. `up` until a
   * connect says otherwise.
   */
  private readonly lastConnect = new ConnectOutcome();

  constructor(argv: readonly string[], opts: CommandHostProviderOptions = {}) {
    this.spawnFn = opts.spawn ?? defaultBridgeSpawn;
    this.commandTransport =
      opts.transport ??
      new CommandTransport(argv, {
        spawn: this.spawnFn,
        label: opts.label,
        // Runs inside every client connect, before the bridge is opened —
        // so connect() installs or upgrades manor-host first, over exec.
        ensureRemoteHost: this.lastConnect.track(
          opts.ensureRemoteHost ??
            remoteHostEnsurer({
              onProgress: opts.onBootstrapProgress,
              // A failed channel is kubectl's or docker's, not ssh's.
              via: basename(argv[0] ?? "exec"),
            }),
        ),
      });
  }

  transport(): CommandTransport {
    return this.commandTransport;
  }

  /** Nothing to start here; the recipe provider around it starts the box. */
  async ensureUp(): Promise<void> {}

  async status(): Promise<ProviderStatus> {
    return this.lastConnect.status();
  }

  /** `manor-host server-bridge` in its own exec child, read past the server's hello. */
  openServerChannel(): Promise<Duplex> {
    return this.commandTransport.openServerBridge();
  }

  /** `manor-host server-bridge --viewer`, the server's hello reply left in (ADR-228 D4). */
  openViewerChannel(): Promise<Duplex> {
    return this.commandTransport.openViewerBridge();
  }

  /**
   * Listen on a local loopback port — `preferredLocalPort` when it is free,
   * otherwise any — and pipe each accepted connection to `remotePort` on the
   * box's loopback through its own `manor-host port-pipe` child.
   */
  async forwardPort(
    remotePort: number,
    opts?: { preferredLocalPort?: number; remoteHost?: string },
  ): Promise<PortForward> {
    assertPort(remotePort, "remote");
    // Anything but the IPv6 loopback targets 127.0.0.1: a forward never
    // reaches past the box's loopback.
    const remoteHost: RemoteLoopback = opts?.remoteHost === "::1" ? "::1" : "127.0.0.1";
    const snippet = remotePortPipeCommand(remotePort, remoteHost);
    const generation = this.generation;
    const forward: CommandForward = {
      server: net.createServer((socket) => this.pipeConnection(forward, socket, snippet)),
      children: new Set(),
      sockets: new Set(),
    };
    const preferred = preferredLocalPort(opts?.preferredLocalPort, this.forwards);
    let localPort: number;
    if (preferred !== null) {
      localPort = await listenLoopback(forward.server, preferred).catch(() =>
        listenLoopback(forward.server, 0),
      );
    } else {
      localPort = await listenLoopback(forward.server, 0);
    }
    if (generation !== this.generation) {
      forward.server.close();
      throw new Error(
        `Port forward to ${this.commandTransport.label} was cancelled: provider disposed`,
      );
    }
    this.forwards.set(localPort, forward);
    return {
      localPort,
      dispose: () => this.closeForward(localPort),
    };
  }

  /** Close every forward's listener and kill its pipes. The transport is left alone. */
  async dispose(): Promise<void> {
    this.generation++;
    for (const localPort of Array.from(this.forwards.keys())) this.closeForward(localPort);
  }

  // ── Internal ──

  /** Pipe one accepted connection through a fresh `port-pipe` child. */
  private pipeConnection(forward: CommandForward, socket: net.Socket, snippet: string): void {
    let child: BridgeChildProcess;
    try {
      const [command, ...args] = this.commandTransport.childArgv(snippet);
      child = this.spawnFn(command, args);
    } catch {
      socket.destroy();
      return;
    }
    const { stdin, stdout, stderr } = child;
    if (!stdin || !stdout) {
      child.kill("SIGTERM");
      socket.destroy();
      return;
    }
    forward.children.add(child);
    forward.sockets.add(socket);
    let childGone = false;
    // A failed connect on the box is one stderr line and an exit; the local
    // connection just closes.
    stderr?.resume();
    stdin.on("error", () => {
      // EPIPE once the child is gone; its `close` ends the socket.
    });
    socket.on("error", () => {
      // A reset from the local client; `close` below kills the child.
    });
    child.on("error", () => {
      childGone = true;
      forward.children.delete(child);
      socket.destroy();
    });
    child.on("close", () => {
      childGone = true;
      forward.children.delete(child);
      socket.end();
    });
    socket.on("close", () => {
      forward.sockets.delete(socket);
      if (!childGone) child.kill("SIGTERM");
    });
    socket.pipe(stdin);
    stdout.pipe(socket);
  }

  private closeForward(localPort: number): void {
    const forward = this.forwards.get(localPort);
    if (!forward) return;
    this.forwards.delete(localPort);
    forward.server.close();
    for (const child of forward.children) child.kill("SIGTERM");
    forward.children.clear();
    for (const socket of forward.sockets) socket.destroy();
    forward.sockets.clear();
  }
}
