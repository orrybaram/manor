/**
 * RemoteBackend — a `WorkspaceBackend` whose host is another machine,
 * reached over ssh (ADR-160).
 *
 * Nothing here re-implements pty, git, shell or ports logic. It is the same
 * four backend classes `LocalBackend` uses; the pty backend gets a
 * `TerminalHostClient` riding an `SshTransport`, and the other three get an
 * `Exec` that runs their commands on the remote daemon. The only things that
 * are genuinely remote-specific live here: bootstrapping the host and the
 * reconnect policy.
 */

import {
  TerminalHostClient,
  type ReconnectPolicy,
} from "../terminal-host/client";
import type { HostTransport } from "../terminal-host/transport";
import { SshTransport } from "../terminal-host/transport-ssh";
import { LocalPtyBackend } from "./local-pty";
import { LocalGitBackend } from "./local-git";
import { LocalShellBackend } from "./local-shell";
import { LocalPortsBackend, execPortsHost } from "./local-ports";
import { createRemoteExec } from "./remote-exec";
import { remoteHostEnsurer, type BootstrapProgress } from "./remote-bootstrap";
import type {
  HostConnectionEvent,
  HostConnectionEventHandler,
  WorkspaceBackend,
} from "./types";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

/**
 * Backoff between reconnect attempts to a remote host: 1s, 2s, 4s, 8s, 16s,
 * then every 30s — for as long as the backend is connected. A remote host's
 * sessions outlive the connection (the laptop slept, the network blipped),
 * so unlike the local daemon there is no point at which giving up and
 * closing the panes is the right call.
 */
export function remoteReconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_CAP_MS);
}

export interface RemoteBackendOptions {
  /** ssh destination, e.g. `user@box` or a `Host` alias from ~/.ssh/config. */
  target: string;
  /** App version; the remote host is installed/upgraded to match. */
  version?: string;
  /** Bootstrap progress (platform detection, install) for a status line. */
  onBootstrapProgress?: (progress: BootstrapProgress) => void;
  /**
   * Replaces the `SshTransport` (whose `ensureRunning` bootstraps the
   * remote host). For tests.
   */
  transport?: HostTransport;
  /** Replaces `remoteReconnectDelayMs`. For tests. */
  reconnectDelayMs?: ReconnectPolicy;
}

export class RemoteBackend implements WorkspaceBackend {
  readonly pty: LocalPtyBackend;
  readonly git: LocalGitBackend;
  readonly shell: LocalShellBackend;
  readonly ports: LocalPortsBackend;
  readonly target: string;

  private readonly client: TerminalHostClient;
  private readonly reconnectDelayMs: ReconnectPolicy;
  private readonly hostEventHandlers = new Set<HostConnectionEventHandler>();

  constructor(opts: RemoteBackendOptions) {
    this.target = opts.target;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? remoteReconnectDelayMs;
    const transport =
      opts.transport ??
      new SshTransport(opts.target, {
        // Runs inside every client connect, before the bridge is opened —
        // so connect() installs or upgrades manor-host first.
        ensureRemoteHost: remoteHostEnsurer({
          onProgress: opts.onBootstrapProgress,
        }),
      });

    this.client = new TerminalHostClient(opts.version, transport);
    this.client.setReconnectPolicy(this.reconnectDelayMs);
    this.client.setConnectionListener({
      onLost: ({ sessionIds }) =>
        this.emitHostEvent({
          type: "hostDisconnected",
          sessionIds,
          retryInMs: this.reconnectDelayMs(0),
        }),
      onReconnected: ({ sessionIds }) =>
        this.emitHostEvent({ type: "hostReconnected", sessionIds }),
    });

    const exec = createRemoteExec(this.client);
    this.pty = new LocalPtyBackend(this.client);
    this.git = new LocalGitBackend(exec);
    this.shell = new LocalShellBackend(exec);
    this.ports = new LocalPortsBackend(exec, execPortsHost(exec));
  }

  /**
   * Make sure the remote has a matching `manor-host` (the transport's
   * `ensureRunning`, ticket 6), connect the client through the ssh bridge,
   * then ask the daemon to bootstrap agent hooks on its own filesystem.
   */
  async connect(opts?: { version?: string }): Promise<void> {
    if (opts?.version) this.client.setVersion(opts.version);
    await this.pty.ensureConnected();
    await this.bootstrapHost();
  }

  /**
   * Drop the connection and tear the transport down (for `SshTransport`,
   * the ssh children and the ControlMaster). The remote daemon and its
   * sessions keep running. A later `connect()` starts over.
   */
  async disconnect(): Promise<void> {
    await this.client.dispose();
  }

  onHostEvent(handler: HostConnectionEventHandler): void {
    this.hostEventHandlers.add(handler);
  }

  /**
   * The `bootstrap` request arrives with ticket 10. Until then the daemon
   * answers "unknown request type", and a daemon that fails to bootstrap
   * still serves terminals — agent status is what suffers, not the host —
   * so neither is allowed to fail the connect.
   */
  private async bootstrapHost(): Promise<void> {
    try {
      await this.client.bootstrap();
    } catch (err) {
      console.warn(
        `[remote-backend] bootstrap on ${this.target} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private emitHostEvent(event: HostConnectionEvent): void {
    for (const handler of this.hostEventHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error("[remote-backend] host event handler threw:", err);
      }
    }
  }
}
