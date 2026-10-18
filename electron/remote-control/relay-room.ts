/**
 * One relay room: its identity, the devices paired to it, the gate that
 * closes a device's live channels, and the connector that holds the room
 * open (ADR-206, ADR-226). The desktop's `RemoteControlController` and the
 * host server's relay (`host-server/relay.ts`) both keep their own policies —
 * enable switches, notices, always-on redialling — and come here for the
 * operations that change who is paired:
 *
 *   - `pair` — a device on this room, and the link that reaches it;
 *   - `revoke` / `revokeAll` — refused from now, disconnected, saved;
 *   - `reset` — new room, every device revoked;
 *   - `revokeStale` — devices paired to a room this identity no longer is.
 *
 * They run one at a time (`serialQueue`): each spans an `await flush`, and a
 * pair landing inside a reset, or two resets interleaving, would leave a
 * device paired to a dead room or the identity reset twice under one revoke.
 * Each resolves only once its change is on disk and rejects when it could not
 * be saved (ADR-226 B2): a revoke that was not saved comes back on restart,
 * and whoever asked has to hear that.
 *
 * The gate and the relay are read through getters, so the desktop can hand
 * over its lazily loaded runtime (ADR-205 §3): before it loads there is no
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
  /** Shown once, never stored. */
  rawToken: string;
  /** The relay link (`https://<relay>/app/<version>/#relay=…`). */
  pairingUrl: string;
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
   * first, so the list never mixes a dead room with the live one. Resolves
   * once the device is on disk.
   */
  pair(label: string): Promise<PairResult> {
    return this.serially(async () => {
      const relay = this.options.relay();
      if (!relay) throw new Error(RELAY_UNAVAILABLE);
      const origin = relay.connector.origin;
      if (!origin) throw new Error("The relay address is not configured.");
      const { roomId, x25519Pub } = relay.identity.describe();
      await this.revokeStaleNow(roomId);
      const { device, rawToken } = await this.options.devices.pair(
        label,
        roomId,
        // Temporary (ADR-240 ticket 1): ticket links arrive with ticket 2.
        { direct: true },
      );
      return {
        device,
        rawToken,
        pairingUrl: relayPairingUrl({
          origin,
          appVersion: this.options.appVersion,
          roomId,
          x25519Pub,
          rawToken,
        }),
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

  /** Unqueued: only ever called from a step already on the queue. */
  private async revokeNow(ids: readonly string[]): Promise<void> {
    const saved = this.options.devices.revokeMany(ids);
    const gate = this.options.gate();
    for (const id of ids) gate?.closeDevice(id);
    await saved;
  }
}
