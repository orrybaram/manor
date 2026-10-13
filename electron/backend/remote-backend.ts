/**
 * RemoteBackend — a `WorkspaceBackend` whose host is another machine,
 * reached over ssh (ADR-160).
 *
 * Nothing here re-implements pty, git, shell or ports logic. It is the same
 * `createHostBackend` the local host is built with (ADR-183); the pty
 * backend gets a `TerminalHostClient` riding an `SshTransport`, and the
 * other three, and the host's `MachineFacts`, get an `Exec` that runs their
 * commands on the remote daemon. The only things that
 * are genuinely remote-specific live here: bootstrapping the host and the
 * reconnect policy. The transport comes from the host's `HostProvider`
 * (ADR-178 §1); for an ssh box that is an `SshTransport`.
 */

import { errorMessage } from "../lib/errors";
import {
  TerminalHostClient,
  type HeartbeatOptions,
  type ReconnectPolicy,
} from "../terminal-host/client";
import type { HostTransport } from "../terminal-host/transport";
import { SshAuthError, SshHostKeyError } from "../terminal-host/ssh-config";
import type { DaemonPtyBackend } from "./daemon-pty";
import type { ExecGitBackend } from "./exec-git";
import type { ExecShellBackend } from "./exec-shell";
import type { ExecPortsBackend } from "./exec-ports";
import { createHostBackend, type HostBackend } from "./host-backend";
import { execFacts, type MachineFacts } from "./machine-facts";
import { createRemoteExec } from "./remote-exec";
import { RemoteBootstrapError } from "./remote-bootstrap";
import { Emitter } from "./emitter";
import type {
  HostConnectionEvent,
  HostConnectionEventHandler,
  HostFailure,
  RemoteHostBackend,
} from "./types";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

/**
 * Heartbeat for a remote host's client (ADR-188 §2): ssh's own keepalives
 * (`ServerAliveInterval`/`CountMax`) only catch a dead TCP peer, not a
 * connection that is up but has stopped delivering — the failure mode a Mac
 * waking from sleep hit. Pinging on the control channel notices that within
 * about 25s (one interval plus one timeout), and within `HEARTBEAT_TIMEOUT_MS`
 * of a wake check (ADR-188 §3).
 */
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

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
  version: string;
  /**
   * Non-fatal warnings from the agent-hook bootstrap (ticket 7), e.g. an
   * agent config on the remote that was skipped rather than risk corrupting
   * it. Called only when there is at least one.
   */
  onBootstrapWarning?: (warnings: string[]) => void;
  /**
   * The remote daemon is about to be replaced and these are its still-live
   * sessions (ADR-185 §A). Handed to the host's `TerminalHostClient`.
   */
  onDaemonReplacing?: (sessionIds: string[]) => void;
  /**
   * How the daemon is reached — the host provider's transport. For ssh, an
   * `SshTransport` whose `ensureRunning` bootstraps the remote host.
   */
  transport: HostTransport;
  /** Replaces `remoteReconnectDelayMs`. For tests. */
  reconnectDelayMs?: ReconnectPolicy;
  /**
   * Replaces the default heartbeat (`HEARTBEAT_INTERVAL_MS`/
   * `HEARTBEAT_TIMEOUT_MS`); `null` turns it off. For tests.
   */
  heartbeat?: HeartbeatOptions | null;
}

export class RemoteBackend implements RemoteHostBackend, HostBackend {
  readonly pty: DaemonPtyBackend;
  readonly git: ExecGitBackend;
  readonly shell: ExecShellBackend;
  readonly ports: ExecPortsBackend;
  readonly facts: MachineFacts;
  readonly target: string;

  private readonly client: TerminalHostClient;
  private readonly transport: HostTransport;
  private readonly reconnectDelayMs: ReconnectPolicy;
  private readonly onBootstrapWarning?: (warnings: string[]) => void;
  /** The `disconnect()` in progress, which a `connect()` must wait out. */
  private disconnecting: Promise<void> | null = null;
  private readonly hostEvents = new Emitter<[HostConnectionEvent]>(
    "[remote-backend] host event handler",
  );

  constructor(opts: RemoteBackendOptions) {
    this.target = opts.target;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? remoteReconnectDelayMs;
    this.onBootstrapWarning = opts.onBootstrapWarning;
    const transport = (this.transport = opts.transport);

    // The laptop's MANOR_* ports are pushed like to any daemon; the remote
    // daemon's role drops them (ADR-178 §2).
    this.client = new TerminalHostClient(opts.version, transport, opts.onDaemonReplacing);
    this.client.setReconnectPolicy(this.reconnectDelayMs, {
      // Retrying bad credentials or a host without Node every 30s forever
      // only re-runs the bootstrap; stop and tell the user instead.
      isPermanentFailure: (err) => classifyHostFailure(err) !== null,
    });
    this.client.setHeartbeat(
      opts.heartbeat === undefined
        ? { intervalMs: HEARTBEAT_INTERVAL_MS, timeoutMs: HEARTBEAT_TIMEOUT_MS }
        : opts.heartbeat,
    );
    this.client.setConnectionListener({
      onLost: ({ sessionIds }) =>
        this.emitHostEvent({
          type: "hostDisconnected",
          sessionIds,
          retryInMs: this.reconnectDelayMs(0),
        }),
      // Attempt 0's delay went out with `hostDisconnected`; each later one
      // is announced so the UI's "retrying in Ns" follows the backoff.
      onRetryScheduled: ({ attempt, delayMs }) => {
        if (attempt === 0) return;
        this.emitHostEvent({ type: "hostRetrying", sessionIds: [], retryInMs: delayMs });
      },
      onReconnected: ({ sessionIds }) =>
        this.emitHostEvent({ type: "hostReconnected", sessionIds }),
      onFailed: ({ error, sessionIds }) => {
        const failure = classifyHostFailure(error);
        if (failure) this.emitHostEvent({ type: "hostFailed", sessionIds, ...failure });
      },
    });

    const exec = createRemoteExec(this.client);
    const host = createHostBackend(this.client, exec, execFacts(exec), {
      label: opts.target,
    });
    this.pty = host.pty;
    this.git = host.git;
    this.shell = host.shell;
    this.ports = host.ports;
    this.facts = host.facts;
  }

  /**
   * Make sure the remote has a matching `manor-host` (the transport's
   * `ensureRunning`, ticket 6), connect the client through the ssh bridge,
   * then ask the daemon how bootstrapping its own filesystem went.
   * Also the way to retry after `hostFailed`, and to reconnect after
   * `disconnect()`.
   */
  async connect(): Promise<void> {
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

  onHostEvent(handler: HostConnectionEventHandler): () => void {
    return this.hostEvents.on(handler);
  }

  /** "Retry now": skip the rest of the reconnect loop's current wait. */
  retryNow(): boolean {
    return this.client.retryReconnectNow();
  }

  /**
   * Ping the daemon once and resolve whether it answered (ADR-188 §3), for a
   * wake check. A failure is reported through `onHostEvent`'s
   * `hostDisconnected`, the same as a heartbeat tick going unanswered.
   */
  checkLiveness(): Promise<boolean> {
    return this.client.checkLiveness();
  }

  /**
   * A daemon that failed to bootstrap still serves terminals — agent status
   * is what suffers, not the host — so that is not allowed to fail the
   * connect.
   */
  private async bootstrapHost(): Promise<void> {
    try {
      const { warnings } = await this.client.bootstrap();
      for (const warning of warnings) {
        console.warn(`[remote-backend] bootstrap on ${this.target}: ${warning}`);
      }
      if (warnings.length > 0) this.onBootstrapWarning?.(warnings);
    } catch (err) {
      console.warn(
        `[remote-backend] bootstrap on ${this.target} failed: ${errorMessage(err)}`,
      );
    }
  }

  private emitHostEvent(event: HostConnectionEvent): void {
    this.hostEvents.emit(event);
  }
}
