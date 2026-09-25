/**
 * RemoteBackend — a `WorkspaceBackend` whose host is another machine,
 * reached over ssh (ADR-160).
 *
 * Nothing here re-implements pty, git, shell or ports logic. It is the same
 * four backend classes `LocalBackend` uses; the pty backend gets a
 * `TerminalHostClient` riding an `SshTransport`, and the other three get an
 * `Exec` that runs their commands on the remote daemon. The only things that
 * are genuinely remote-specific live here: bootstrapping the host and the
 * reconnect policy. The transport comes from the host's `HostProvider`
 * (ADR-178 §1); for an ssh box that is an `SshTransport`.
 */

import {
  TerminalHostClient,
  type ReconnectPolicy,
} from "../terminal-host/client";
import type { HostTransport } from "../terminal-host/transport";
import { SshAuthError, SshHostKeyError } from "../terminal-host/ssh-config";
import { LocalPtyBackend } from "./local-pty";
import { LocalGitBackend } from "./local-git";
import { LocalShellBackend, execShellHost } from "./local-shell";
import { LocalPortsBackend, execPortsHost } from "./local-ports";
import { createRemoteExec } from "./remote-exec";
import { RemoteBootstrapError } from "./remote-bootstrap";
import type {
  HostConnectionEvent,
  HostConnectionEventHandler,
  HostFailure,
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

/**
 * A connect error that retrying cannot fix — the user has to act (fix their
 * keys, accept a host key, install Node) — or null for anything that may be
 * the network and is worth retrying.
 */
export function classifyHostFailure(err: unknown): HostFailure | null {
  if (err instanceof SshAuthError) return { reason: "auth", message: err.message };
  if (err instanceof SshHostKeyError) return { reason: "host-key", message: err.message };
  if (err instanceof RemoteBootstrapError) {
    return { reason: "bootstrap", code: err.code, message: err.message };
  }
  return null;
}

export interface RemoteBackendOptions {
  /** ssh destination, e.g. `user@box` or a `Host` alias from ~/.ssh/config. */
  target: string;
  /** App version; the remote host is installed/upgraded to match. */
  version?: string;
  /**
   * Non-fatal warnings from the agent-hook bootstrap (ticket 7), e.g. an
   * agent config on the remote that was skipped rather than risk corrupting
   * it. Called only when there is at least one.
   */
  onBootstrapWarning?: (warnings: string[]) => void;
  /**
   * How the daemon is reached — the host provider's transport. For ssh, an
   * `SshTransport` whose `ensureRunning` bootstraps the remote host.
   */
  transport: HostTransport;
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
  private readonly transport: HostTransport;
  private readonly reconnectDelayMs: ReconnectPolicy;
  private readonly onBootstrapWarning?: (warnings: string[]) => void;
  /** The `disconnect()` in progress, which a `connect()` must wait out. */
  private disconnecting: Promise<void> | null = null;
  private readonly hostEventHandlers = new Set<HostConnectionEventHandler>();

  constructor(opts: RemoteBackendOptions) {
    this.target = opts.target;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? remoteReconnectDelayMs;
    this.onBootstrapWarning = opts.onBootstrapWarning;
    const transport = (this.transport = opts.transport);

    // The laptop's MANOR_* ports mean nothing on the box, and a pushed
    // MANOR_HOOK_PORT would point remote agents away from the daemon's own
    // hook listener (ADR-178 §2).
    this.client = new TerminalHostClient(opts.version, transport, {
      pushLocalEnv: false,
    });
    this.client.setReconnectPolicy(this.reconnectDelayMs, {
      // Retrying bad credentials or a host without Node every 30s forever
      // only re-runs the bootstrap; stop and tell the user instead.
      isPermanentFailure: (err) => classifyHostFailure(err) !== null,
    });
    this.client.setConnectionListener({
      onLost: ({ sessionIds }) =>
        this.emitHostEvent({
          type: "hostDisconnected",
          sessionIds,
          retryInMs: this.reconnectDelayMs(0),
        }),
      onReconnected: ({ sessionIds }) =>
        this.emitHostEvent({ type: "hostReconnected", sessionIds }),
      onFailed: ({ error, sessionIds }) => {
        const failure = classifyHostFailure(error);
        if (failure) this.emitHostEvent({ type: "hostFailed", sessionIds, ...failure });
      },
    });

    const exec = createRemoteExec(this.client);
    this.pty = new LocalPtyBackend(this.client);
    this.git = new LocalGitBackend(exec);
    this.shell = new LocalShellBackend(exec, execShellHost(exec));
    this.ports = new LocalPortsBackend(exec, execPortsHost(exec), opts.target);
  }

  /**
   * Make sure the remote has a matching `manor-host` (the transport's
   * `ensureRunning`, ticket 6), connect the client through the ssh bridge,
   * then ask the daemon to bootstrap agent hooks on its own filesystem.
   * Also the way to retry after `hostFailed`, and to reconnect after
   * `disconnect()`.
   */
  async connect(opts?: { version?: string }): Promise<void> {
    if (opts?.version) this.client.setVersion(opts.version);
    // A disposed transport refuses to spawn ssh (so a connect racing a
    // disconnect cannot resurrect it); only an explicit connect revives it.
    await this.disconnecting;
    this.transport.reset?.();
    await this.pty.ensureConnected();
    await this.bootstrapHost();
  }

  /**
   * Drop the connection and tear the transport down (for `SshTransport`,
   * the ssh children and the ControlMaster). The remote daemon and its
   * sessions keep running. A later `connect()` starts over.
   */
  async disconnect(): Promise<void> {
    const done = this.client.dispose();
    this.disconnecting = done;
    try {
      await done;
    } finally {
      if (this.disconnecting === done) this.disconnecting = null;
    }
  }

  onHostEvent(handler: HostConnectionEventHandler): void {
    this.hostEventHandlers.add(handler);
  }

  /**
   * A daemon older than the `bootstrap` request answers "unknown request
   * type", and a daemon that fails to bootstrap still serves terminals —
   * agent status is what suffers, not the host — so neither is allowed to
   * fail the connect.
   */
  private async bootstrapHost(): Promise<void> {
    try {
      const result = await this.client.bootstrap();
      if (result === null) {
        console.warn(
          `[remote-backend] manor-host on ${this.target} does not support bootstrap; agent hooks are not set up there`,
        );
      } else {
        for (const warning of result.warnings) {
          console.warn(`[remote-backend] bootstrap on ${this.target}: ${warning}`);
        }
        if (result.warnings.length > 0) {
          this.onBootstrapWarning?.(result.warnings);
        }
      }
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
