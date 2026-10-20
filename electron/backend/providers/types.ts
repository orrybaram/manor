/**
 * HostProvider — what sits between a persisted `HostSpec` and the
 * `HostTransport` a `RemoteBackend` rides.
 *
 * Each kind of box is one implementation of this interface rather than a
 * change to the registry. A bring-your-own ssh box is assumed to always be
 * on; a box Manor starts itself has a lifecycle — it is brought up
 * before every connect (`ensureUp`), may be put to sleep (`stop`), and says
 * whether it is asleep (`status`), which the connection treats as a state of
 * its own rather than an error.
 */

import type { Duplex } from "node:stream";
import type { HostTransport } from "../../terminal-host/transport";

/** A local port that reaches a port on the box, until disposed. */
export interface PortForward {
  localPort: number;
  dispose(): void;
}

/**
 * Where a provider's box is. `sleeping` is a box that was put
 * to sleep — by `stop()`, or by the provider itself when idle — and stays so
 * until something means to use it; `unreachable` is one that should be up
 * but did not answer.
 */
export type ProviderState = "up" | "starting" | "sleeping" | "unreachable" | "error";

/** What a provider can do to its box beyond reaching it. */
export interface ProviderCapabilities {
  /** `stop()` puts the box to sleep; `ensureUp()` wakes it. */
  canStop: boolean;
  /** `destroy()` deletes the box and its disk. */
  canDestroy: boolean;
  /** The provider puts the box to sleep by itself when idle. */
  autoSleep: boolean;
}

/** What `HostProvider.status()` says of the box. */
export interface ProviderStatus {
  state: ProviderState;
  detail?: string;
  /**
   * The box is gone — deleted outside Manor — so `state` is
   * `error`, and the way back is to start it again (`ensureUp`) or remove
   * the host.
   */
  missing?: boolean;
}

export interface HostProvider {
  /**
   * How the host was configured: a box the user brings (`ssh`), or one a
   * recipe starts (`recipe`) — whichever way it is reached.
   */
  readonly kind: "ssh" | "recipe";
  readonly capabilities: ProviderCapabilities;
  /**
   * Make sure the box is up — starting or resuming it if not — before the
   * backend connects. `onProgress` gets one line per step, shown
   * as the host's progress while it connects. Rejects when the box cannot be
   * brought up.
   */
  ensureUp(onProgress?: (line: string) => void): Promise<void>;
  /**
   * During a reconnect, bring the box up again and rebuild the way in if
   * it moved: a box that came back at a new address is found
   * without waiting for a full connect. Resolves false, having run nothing,
   * when it cannot tell that doing so would not wake a box that put itself
   * to sleep. Rejects as `ensureUp` does. Absent for a provider whose way
   * in never moves (ssh, an exec prefix).
   */
  refresh?(onProgress?: (line: string) => void): Promise<boolean>;
  /**
   * Where the box is now. Asked before each reconnect attempt: `sleeping`
   * stops the attempts. Should be cheap; never rejects for a box that is
   * merely away.
   */
  status(): Promise<ProviderStatus>;
  /** Whether any agent on the box is working. */
  setBusy?(busy: boolean): void;
  /** Put the box to sleep. Present only with `capabilities.canStop`. */
  stop?(): Promise<void>;
  /** Delete the box and its disk. Present only with `capabilities.canDestroy`. */
  destroy?(): Promise<void>;
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
   * Open the owner channel to the box's host server: a stream
   * carrying newline-delimited bridge frames, already past the server's
   * reply to the owner hello (the box's end says the hello; the provider
   * reads the reply). Rejects when there is no server to reach or it refuses.
   * Absent for a provider that cannot reach a host server yet; the desktop
   * then runs without one for that host.
   */
  openServerChannel?(): Promise<Duplex>;
  /**
   * Open a desktop window's own stream to the box's host server: the owner's credential with a desktop viewer's hello. Unlike
   * `openServerChannel` the stream *starts* with the server's hello reply
   * line, for the window's transport to read. Rejects as `openServerChannel`
   * does. Absent for a provider that cannot reach a host server.
   */
  openViewerChannel?(): Promise<Duplex>;
  /**
   * Release what the provider holds of its own (port forwards). Does not
   * dispose the transport — its client owns that.
   */
  dispose(): Promise<void>;
}
