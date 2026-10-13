/**
 * HostProvider — what sits between a persisted `HostSpec` and the
 * `HostTransport` a `RemoteBackend` rides (ADR-178 §1).
 *
 * A bring-your-own ssh box is the only provider today, and it is assumed to
 * always be on. Each new kind of box becomes one more implementation of this
 * interface rather than a change to the registry.
 */

import type { Duplex } from "node:stream";
import type { HostTransport } from "../../terminal-host/transport";

/** A local port that reaches a port on the box, until disposed. */
export interface PortForward {
  localPort: number;
  dispose(): void;
}

export interface HostProvider {
  readonly kind: "ssh";
  /** The transport a `TerminalHostClient` uses to reach the box's daemon. */
  transport(): HostTransport;
  /**
   * Make `remotePort` on the box reachable at a local port. With
   * `preferredLocalPort`, that port is used when it is free (so a forward
   * recreated after a reconnect keeps its URL); otherwise any free one.
   * `remoteHost` is the box's loopback address to reach — `"::1"` for a
   * server listening only there; 127.0.0.1 otherwise.
   */
  forwardPort(
    remotePort: number,
    opts?: { preferredLocalPort?: number; remoteHost?: string },
  ): Promise<PortForward>;
  /**
   * Open the owner channel to the box's host server (ADR-218 D4): a stream
   * carrying newline-delimited bridge frames, already past the server's
   * reply to the owner hello (the box's end says the hello; the provider
   * reads the reply). Rejects when there is no server to reach or it refuses.
   * Absent for a provider that cannot reach a host server yet; the desktop
   * then runs without one for that host.
   */
  openServerChannel?(): Promise<Duplex>;
  /**
   * Release what the provider holds of its own (port forwards). Does not
   * dispose the transport — its client owns that.
   */
  dispose(): Promise<void>;
}
