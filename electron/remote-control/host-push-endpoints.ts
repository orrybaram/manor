/**
 * The push endpoints each remote host's server sends to (ADR-218 D3).
 *
 * A phone can be subscribed on the desktop and on a host server both; for an
 * agent on that host, the host server pushes, so the desktop skips those
 * subscriptions. The answer is cached per host and refreshed when the owner
 * channel connects and after pairing changes (pair, revoke, reset), because
 * the desktop's push path must not wait on a round trip. A host the desktop
 * cannot ask yields the empty set: better a duplicate than a missed push.
 */

import type { HostServerStatus } from "../host-server/relay";

export interface HostPushEndpointsSource {
  /** Status of `hostId`'s server, or null when it cannot be asked. */
  status(hostId: string): Promise<Pick<HostServerStatus, "pushEndpoints"> | null>;
}

const EMPTY: ReadonlySet<string> = new Set();

export class HostPushEndpoints {
  private readonly cache = new Map<string, ReadonlySet<string>>();

  constructor(private readonly source: HostPushEndpointsSource) {}

  /** The cached endpoints for `hostId`; empty when unknown. */
  get(hostId: string): ReadonlySet<string> {
    return this.cache.get(hostId) ?? EMPTY;
  }

  /** Ask the host again and replace the cache; a failure clears it. */
  async refresh(hostId: string): Promise<void> {
    try {
      const status = await this.source.status(hostId);
      if (status) this.cache.set(hostId, new Set(status.pushEndpoints));
      else this.cache.delete(hostId);
    } catch {
      this.cache.delete(hostId);
    }
  }

  /** Take endpoints already in hand (a status the caller just fetched). */
  set(hostId: string, endpoints: readonly string[]): void {
    this.cache.set(hostId, new Set(endpoints));
  }

  forget(hostId: string): void {
    this.cache.delete(hostId);
  }
}
