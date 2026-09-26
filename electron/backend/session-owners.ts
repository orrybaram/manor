/**
 * SessionOwners — which host each terminal session lives on (ADR-160 §6,
 * ADR-183).
 *
 * Pane ids are `pane-<uuid>`, unique across hosts, and a session is only
 * ever created on the host its owner names (`RoutedBackend` routes a known
 * session to its owner). So the rule is simply: **the first host to claim a
 * session owns it until it is released.** A claim by another host meanwhile
 * is refused, and an event naming a session another host owns is dropped
 * rather than delivered twice.
 *
 * Sessions are claimed wherever a host shows it has them — created or
 * attached there, listed by its daemon, named in its connection events or
 * its stream events — and released when they end: killed, or their shell
 * exited. A remote session lost to a daemon restart is not released; its
 * pane is recreated on the same host (ADR-178 §6).
 */

import { LOCAL_HOST_ID, type StreamEvent } from "./types";

/**
 * Whether `event` is a remote session the client reported gone because the
 * daemon no longer had it after a reconnect — the daemon restarted or the
 * box rebooted — rather than a shell that exited. The pane of such a session
 * is recovered (ADR-178 §6), not closed. On the local host the same event
 * still closes the pane (ADR-169): there is nothing to recover it on.
 */
export function isRemoteSessionLoss(hostId: string, event: StreamEvent): boolean {
  return hostId !== LOCAL_HOST_ID && event.type === "exit" && event.lost === true;
}

export class SessionOwners {
  private readonly owners = new Map<string, string>();

  /** The host `sessionId` lives on, if any host has claimed it. */
  ownerOf(sessionId: string): string | undefined {
    return this.owners.get(sessionId);
  }

  /**
   * Record that `hostId` has `sessionId`. Returns whether `hostId` owns it
   * now: false when another host claimed it first.
   */
  claim(sessionId: string, hostId: string): boolean {
    const owner = this.owners.get(sessionId);
    if (owner === undefined) {
      this.owners.set(sessionId, hostId);
      return true;
    }
    return owner === hostId;
  }

  release(sessionId: string): void {
    this.owners.delete(sessionId);
  }

  /**
   * Whether a stream event `hostId` sent should be delivered: not when it
   * names a session another host owns. Claims the session on first sight,
   * and releases it once its shell exited.
   */
  accept(hostId: string, event: StreamEvent): boolean {
    if (!("sessionId" in event)) return true;
    if (!this.claim(event.sessionId, hostId)) {
      console.warn(
        `[session-owners] dropping ${event.type} for ${event.sessionId} from ${hostId}; it belongs to ${this.owners.get(event.sessionId)}`,
      );
      return false;
    }
    if (event.type === "exit" && !isRemoteSessionLoss(hostId, event)) {
      this.release(event.sessionId);
    }
    return true;
  }
}
