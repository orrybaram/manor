/**
 * One relay room: its identity, the devices paired to it, the gate that
 * closes a device's live channels, and the connector that holds the room
 * open. The desktop's `RemoteControlController` and the
 * host server's relay (`host-server/relay.ts`) both keep their own policies —
 * enable switches, notices, always-on redialling — and come here for the
 * operations that change who is paired:
 *
 *   - `pair` — a device on this room, and the link that reaches it;
 *   - `reissue` — a new link for a device that has not connected yet;
 *   - `revoke` / `revokeAll` — refused from now, disconnected, saved;
 *   - `reset` — new room, every device revoked;
 *   - `revokeStale` — devices paired to a room this identity no longer is.
 *
 * They run one at a time (`serialQueue`): each spans an `await flush`, and a
 * pair landing inside a reset, or two resets interleaving, would leave a
 * device paired to a dead room or the identity reset twice under one revoke.
 * Each resolves only once its change is on disk and rejects when it could not
 * be saved: a revoke that was not saved comes back on restart,
 * and whoever asked has to hear that.
 *
 * The gate and the relay are read through getters, so the desktop can hand
 * over its lazily loaded runtime: before it loads there is no
 * live connection to close and nothing to pair through.
 */

import { serialQueue, type Serially } from "../lib/serial";
import type { RemoteDeviceInfo, RemoteDeviceStore } from "./devices";
import type { RelayConnector } from "./relay/connector";
import type { RelayIdentityStore } from "./relay/identity";
import type { RelayGate } from "./relay-gate";
import { relayPairingUrl } from "./relay/url";

export interface PairResult {
  device: RemoteDeviceInfo;
  /**
   * The relay link (`https://<relay>/app/<version>/#relay=…`): a single-use
   * pairing ticket by default, the raw token for a `direct` pairing.
   * Shown once, never stored.
   */
  pairingUrl: string;
  /** When the link's ticket stops working; null for a `direct` pairing. */
  expiresAt: number | null;
  /** The device's token, only for a `direct` pairing. */
  rawToken?: string;
}

/** The relay half of a room: what holds it open, and its keys. */
export interface RelayRoomRelay {
  connector: RelayConnector;
  identity: RelayIdentityStore;
}

export interface RelayRoomOptions {
  devices: RemoteDeviceStore;
  /** Closes a revoked device's channels. Null: nothing can be connected. */
  gate: () => Pick<RelayGate, "closeDevice"> | null;
  /** Null: the relay is unavailable (or, on the desktop, not loaded). */
  relay: () => RelayRoomRelay | null;
  /** The version segment of pairing links (`/app/<version>/`). */
  appVersion: string;
  /** `revokeStale` revoked `count` devices (never called with 0). */
  onStaleRevoked?: (count: number) => void;
}

export interface RelayResetOptions {
  /**
   * Asked once the identity reset settles, saved or not: true redials the
   * connector to the new room. Absent: the relay stays stopped.
   */
  redial?: () => boolean;
}

const RELAY_UNAVAILABLE = "The relay is not available.";

export class RelayRoom {
  private readonly serially: Serially = serialQueue();

  constructor(private readonly options: RelayRoomOptions) {}

  /**
   * Pair a device to this room. Devices left on a stale room are revoked
   * first, so the list never mixes a dead room with the live one. By default
   * the link carries a pairing ticket; `direct` mints the token itself, for a
   * caller that hands it over an authenticated channel. Resolves
   * once the device is on disk.
   */
  pair(label: string, options?: { direct?: boolean }): Promise<PairResult> {
    return this.serially(async () => {
      const { origin, roomId, x25519Pub } = this.address();
      await this.revokeStaleNow(roomId);
      const paired = await this.options.devices.pair(label, roomId, options);
      if ("rawToken" in paired) {
        return {
          device: paired.device,
          rawToken: paired.rawToken,
          expiresAt: null,
          pairingUrl: this.link(origin, roomId, x25519Pub, {
            rawToken: paired.rawToken,
          }),
        };
      }
      return {
        device: paired.device,
        expiresAt: paired.expiresAt,
        pairingUrl: this.link(origin, roomId, x25519Pub, { ticket: paired.ticket }),
      };
    });
  }

  /**
   * A new link for a device that has not connected yet; the
   * old one is dead. Revokes nothing, but refuses a device paired to a room
   * this identity no longer is: a link to the current room would let it
   * redeem, and the next stale-room sweep would then revoke it. Resolves once
   * it is on disk.
   */
  reissue(id: string): Promise<PairResult> {
    return this.serially(async () => {
      const { origin, roomId, x25519Pub } = this.address();
      if (this.options.devices.idsInOtherRelayRooms(roomId).includes(id)) {
        throw new Error(
          "This device was added for an old relay address. Remove it and add it again.",
        );
      }
      const { device, ticket, expiresAt } = await this.options.devices.reissue(id);
      return {
        device,
        expiresAt,
        pairingUrl: this.link(origin, roomId, x25519Pub, { ticket }),
      };
    });
  }

  /**
   * Revoke means now: the store refuses the device's next hello and the gate
   * closes its live channels, both before the write. Resolves once the revoke
   * is on disk.
   */
  revoke(id: string): Promise<void> {
    return this.serially(() => this.revokeNow([id]));
  }

  /** `revoke` for every paired device. */
  revokeAll(): Promise<void> {
    return this.serially(() => this.revokeNow(this.options.devices.ids()));
  }

  /**
   * New room, new keys: every link ever shared for the old address is dead,
   * so every device is revoked.
   *
   * The order is what makes each relay browser hear *why*. Revoking closes a
   * device's channels with 4401, which travels to the browser through the
   * live relay and reads there as "re-pair". Stopping the relay first would
   * take the host socket away underneath them, and the room would answer
   * 4404 — "this machine is not reachable" — a retry loop rather than a
   * prompt. So: revoke and close, then stop (the connector holds the old
   * keys) and reset.
   */
  reset(options: RelayResetOptions = {}): Promise<void> {
    return this.serially(async () => {
      const relay = this.options.relay();
      if (!relay) throw new Error(RELAY_UNAVAILABLE);
      await this.revokeNow(this.options.devices.ids());
      relay.connector.stop();
      try {
        await relay.identity.reset();
      } finally {
        if (options.redial?.()) relay.connector.start();
      }
    });
  }

  /**
   * Devices paired to a room other than `roomId` hold dead links. The
   * identity store replaces an identity it cannot read with a new one (a new
   * room) without a word; this revokes those devices and reports how many.
   */
  revokeStale(roomId: string): Promise<number> {
    return this.serially(() => this.revokeStaleNow(roomId));
  }

  private async revokeStaleNow(roomId: string): Promise<number> {
    const stale = this.options.devices.idsInOtherRelayRooms(roomId);
    if (stale.length === 0) return 0;
    await this.revokeNow(stale);
    this.options.onStaleRevoked?.(stale.length);
    return stale.length;
  }

  /** Where a link points: the relay's origin and this room's keys. */
  private address(): { origin: string; roomId: string; x25519Pub: string } {
    const relay = this.options.relay();
    if (!relay) throw new Error(RELAY_UNAVAILABLE);
    const origin = relay.connector.origin;
    if (!origin) throw new Error("The relay address is not configured.");
    const { roomId, x25519Pub } = relay.identity.describe();
    return { origin, roomId, x25519Pub };
  }

  private link(
    origin: string,
    roomId: string,
    x25519Pub: string,
    credential: { ticket: string } | { rawToken: string },
  ): string {
    return relayPairingUrl({
      origin,
      appVersion: this.options.appVersion,
      roomId,
      x25519Pub,
      credential,
    });
  }

  /** Unqueued: only ever called from a step already on the queue. */
  private async revokeNow(ids: readonly string[]): Promise<void> {
    const saved = this.options.devices.revokeMany(ids);
    const gate = this.options.gate();
    for (const id of ids) gate?.closeDevice(id);
    await saved;
  }
}
