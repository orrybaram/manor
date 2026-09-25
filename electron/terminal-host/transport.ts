/**
 * HostTransport — how a `TerminalHostClient` reaches a terminal-host daemon.
 *
 * The client owns the protocol (NDJSON framing, request mutex, auth, version
 * handshake, stream dispatch). A transport owns only the plumbing underneath
 * it: making sure a daemon exists, and producing byte streams connected to it.
 * `LocalTransport` does that with a detached child process and a unix socket;
 * a remote transport might pipe the same bytes through ssh stdio or a provider
 * SDK's exec stream. Nothing here may assume a socket — only `Duplex`.
 */

import type { Duplex } from "node:stream";

export interface HostTransport {
  /**
   * How long the client waits for its auth and handshake replies. A remote
   * transport pays for cold TCP, key exchange and ssh auth inside that
   * window, so it needs far longer than a local socket. Absent means the
   * client's default request timeout.
   */
  readonly handshakeTimeoutMs?: number;

  /**
   * Make sure a daemon is running and accepting connections, starting one if
   * not. `version` is the client's app version, handed to a daemon started
   * here so it can report it in the handshake.
   */
  ensureRunning(version?: string): Promise<void>;

  /**
   * Replace the running daemon with a fresh one. Called when the version
   * handshake shows the daemon cannot serve this client (see `isDaemonStale`).
   * Resolves once the replacement is accepting connections.
   */
  restart(version?: string): Promise<void>;

  /** Open a connection the client will use for control requests. */
  connectControl(): Promise<Duplex>;

  /** Open a connection the client will use as its event stream. */
  connectStream(): Promise<Duplex>;

  /** The token the daemon expects in `auth` and the stream preamble. */
  authToken(): Promise<string>;

  /** Release anything the transport holds. Does not stop the daemon. */
  dispose(): Promise<void>;
}
