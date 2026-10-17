/**
 * One pairing covers every host (ADR-228 D9): the pairings this desktop
 * mints for its own paired devices on each remote host's server, and the
 * revokes that follow them.
 *
 * - **Minting** (`link`, behind `remoteControl.linkHostPairings`). For each
 *   host whose owner channel and relay are up, whose "Phones paired with this
 *   Mac can reach <host>" switch is on, and whose room the device does not
 *   already hold, the desktop pairs the device there under its own label and records
 *   the link on the device (`RemoteDeviceStore.setHostLink`). The device
 *   gets the room, key and token back inside its own Noise channel.
 * - **Revoking cascades.** Every revoke of a desktop device — by hand, a
 *   relay reset's, a stale room's — reaches this through
 *   `RemoteDeviceStore.onRevoke` with the links the device held. Each is
 *   owed to its host first (`PersistedHost.pendingRevokes`, so a quit or a
 *   host that is away loses nothing) and revoked through `HostServerSync`
 *   now, or on the host's next connect.
 * - **The switch off** forgets every link on that host and owes their
 *   revokes the same way.
 * - **A revoke on the host** (ADR-238 D2) — `hosts.revokeDevice`
 *   (`revokeOnHost`), or anything on the box — blocks the device there
 *   (`RemoteDeviceStore.blockHost`): no pairing is minted for it on that host
 *   again, however often the phone asks. One made on the box is found by
 *   `settle`, which tells it from a reset by the room the link was minted in:
 *   a link the host no longer lists, whose room is still the host's, was
 *   revoked; one whose room has changed was lost to a reset, and is minted
 *   again. `settle` runs before a mint replaces a link, and on each connect
 *   (`reconcileLinks`) — the owner channel can stay up for days, so the
 *   connect alone would be too late.
 * - **The switch back on** lifts every block on that host. Blocks survive a
 *   reset of the host's keys: a reset is a security action, and letting more
 *   devices in should not be its side effect.
 *
 * A device that held a link on a host and no longer holds its room — it
 * removed the pairing, or the host's keys were reset — has the old one
 * revoked before a new one is minted, so phones never pile up on a host.
 *
 * Minting, the switch and a reset of a host's pairing keys run one at a time
 * (`serialQueue`): two hellos from one phone landing together would otherwise
 * mint it twice on a host, and a reset landing after a mint's `pair` would
 * leave a link to a device the reset already revoked (ADR-230 D11).
 *
 * A mint is checked (ADR-230 D11):
 * - **its room** — a pairing whose room is not the one the host's status
 *   named just before is from a host reset meanwhile by something else; it
 *   is revoked rather than linked, and the next hello mints again;
 * - **its answer** — each mint goes under its label plus a random suffix,
 *   recorded on the host (`PersistedHost.pendingMints`) before `pair` and
 *   dropped once the answer is handled. One whose answer was lost is
 *   reconciled on the host's next connect (`HostServerSync.reconcileMints`,
 *   through `pendingMints()`).
 */

import crypto from "node:crypto";

import { serialQueue, type Serially } from "../lib/serial";
import { errorMessage } from "../lib/errors";
import type { HostServerClient } from "../backend/host-server-client";
import {
  serverFactsOf,
  type PendingMint,
  type PendingMints,
} from "../backend/host-server-sync";
import type { HostLink, RemoteDeviceStore, RevokedDevice } from "./devices";
import { parseRelayPairingUrl } from "./relay/url";

/** What a device is handed for one host: enough to dial its room. */
export interface LinkedHostPairing {
  roomId: string;
  /** The host server's X25519 static public key, base64url. */
  serverKey: string;
  /** The device's token in that host's own store. Shown to it once. */
  token: string;
  /** The host as this desktop names it, until the host's hello says. */
  name: string;
}

/** The desktop's record of each host: its switch and what it is owed. */
export interface HostLinkRecords {
  linkPhones(hostId: string): boolean;
  setLinkPhones(hostId: string, on: boolean): void;
  addPendingRevokes(hostId: string, hostDeviceIds: readonly string[]): void;
  /** How the host is named to people. */
  label(hostId: string): string;
  /** Mints started on the host whose answer was not handled yet (ADR-230 D11). */
  pendingMints(hostId: string): readonly PendingMint[];
  addPendingMint(hostId: string, mint: PendingMint): void;
  clearPendingMints(hostId: string, labels: readonly string[]): void;
  /** The host's keys were reset: nothing on it is owed any more. */
  forgetOwed(hostId: string): void;
  /** The host's own ids for the linked pairings it is owed a revoke of. */
  pendingRevokes(hostId: string): readonly string[];
}

/** What `settle` found of a host's links. */
interface Settled {
  /** The host's ids for the links it still lists: owed a revoke before a new mint. */
  present: string[];
  /** The devices blocked because their link was revoked on the host. */
  blocked: Set<string>;
  /** Whether any link was dropped or device blocked. */
  changed: boolean;
}

/** `label` as minted on a host: with a suffix no pairing made there shares. */
export function mintLabel(label: string): string {
  return `${label} (${crypto.randomBytes(3).toString("hex")})`;
}

export interface HostPairingLinksOptions {
  devices: Pick<
    RemoteDeviceStore,
    | "ready"
    | "label"
    | "hostLinks"
    | "linksOn"
    | "setHostLink"
    | "dropHostLinks"
    | "onRevoke"
    | "hostBlocks"
    | "blockHost"
    | "blockedOn"
    | "clearHostBlocks"
  >;
  /** Each remote host's owner channel. */
  hostServers(): Pick<HostServerClient, "hostId" | "state" | "api">[];
  records: HostLinkRecords;
  /** Revoke what a host is owed, if it is connected (`HostServerSync`). */
  revokePending(hostId: string): Promise<void>;
  /** A pairing was minted on `hostId`: its phone list and endpoints changed. */
  pairingChanged(hostId: string): void;
  log?: Pick<Console, "warn">;
}

export class HostPairingLinks {
  private readonly serially: Serially = serialQueue();
  private readonly log: Pick<Console, "warn">;
  private stopRevokes: (() => void) | null = null;
  /** The label each host is being minted a pairing under right now. */
  private readonly minting = new Map<string, string>();

  constructor(private readonly options: HostPairingLinksOptions) {
    this.log = options.log ?? console;
  }

  /** Follow the device store's revokes. */
  start(): void {
    this.stopRevokes?.();
    this.stopRevokes = this.options.devices.onRevoke((revoked) => this.cascade(revoked));
  }

  dispose(): void {
    this.stopRevokes?.();
    this.stopRevokes = null;
  }

  /**
   * Pair `deviceId` with every host it can be, whose room is not in
   * `heldRooms`. A host that fails is skipped, and tried again on the
   * device's next call.
   */
  link(deviceId: string, heldRooms: readonly string[]): Promise<LinkedHostPairing[]> {
    return this.serially(async () => {
      const label = this.options.devices.label(deviceId);
      if (label === null) return [];
      const held = new Set(heldRooms);
      const out: LinkedHostPairing[] = [];
      for (const client of this.options.hostServers()) {
        try {
          const linked = await this.linkOne(client, deviceId, label, held);
          if (linked) out.push(linked);
        } catch (err) {
          this.log.warn(
            `[host-links] ${client.hostId}: could not pair a device there: ${errorMessage(err)}`,
          );
        }
      }
      return out;
    });
  }

  /**
   * "Phones paired with this Mac can reach <host>". Off forgets every link on
   * the host and revokes each, now or on its next connect.
   */
  setLinkPhones(hostId: string, on: boolean): Promise<void> {
    return this.serially(async () => {
      this.options.records.setLinkPhones(hostId, on);
      // On again lifts every block there (ADR-238 D2): the way back for a
      // device whose pairing was revoked on the host.
      if (on) return this.options.devices.clearHostBlocks(hostId);
      const links = this.options.devices.linksOn(hostId);
      if (links.length === 0) return;
      this.options.records.addPendingRevokes(
        hostId,
        links.map((l) => l.hostDeviceId),
      );
      await this.options.devices.dropHostLinks(hostId);
      await this.options.revokePending(hostId);
    });
  }

  /**
   * Reset `hostId`'s pairing keys with `reset`, after any mint in flight
   * (ADR-230 D11). The reset revoked every device on the host, so its links
   * are forgotten and nothing there is owed afterwards. Its blocks stay
   * (ADR-238 D2): only the switch lifts them.
   */
  resetHost<T>(hostId: string, reset: () => Promise<T>): Promise<T> {
    return this.serially(async () => {
      const out = await reset();
      await this.options.devices.dropHostLinks(hostId);
      this.options.records.forgetOwed(hostId);
      return out;
    });
  }

  /**
   * Find the linked pairings revoked on `hostId` while this desktop was not
   * looking (ADR-238 D2), on each connect of its owner channel: each device
   * whose link is gone is blocked there, and one lost to a reset is
   * forgotten. Links already owed a revoke are left to `revokePending`.
   */
  reconcileLinks(hostId: string): Promise<void> {
    return this.serially(async () => {
      const { devices, records } = this.options;
      if (!devices.ready) return;
      const client = this.options.hostServers().find((c) => c.hostId === hostId);
      if (client?.state !== "connected") return;
      const { roomId } = serverFactsOf(await client.api.hostServer.status());
      if (roomId === null) return;
      const owed = new Set(records.pendingRevokes(hostId));
      const links = devices.linksOn(hostId).filter((l) => !owed.has(l.hostDeviceId));
      if (links.length === 0) return;
      const { changed } = await this.settle(client, hostId, roomId, links);
      if (changed) this.options.pairingChanged(hostId);
    });
  }

  /**
   * Revoke `hostDeviceId` on `hostId` with `revoke` (`hosts.revokeDevice`),
   * then block the desktop device whose link it was, if any (ADR-238 D2):
   * otherwise its next hello would mint it a new pairing there.
   */
  revokeOnHost<T>(hostId: string, hostDeviceId: string, revoke: () => Promise<T>): Promise<T> {
    return this.serially(async () => {
      const out = await revoke();
      const link = this.options.devices
        .linksOn(hostId)
        .find((l) => l.hostDeviceId === hostDeviceId);
      if (link) await this.options.devices.blockHost(link.deviceId, hostId);
      return out;
    });
  }

  /** The devices whose pairing was revoked on `hostId` (ADR-238 D2). */
  blockedOn(hostId: string): Array<{ deviceId: string; label: string }> {
    return this.options.devices.blockedOn(hostId);
  }

  /**
   * The lost mints `HostServerSync` reconciles on each connect: those on the
   * host, less one still in flight, whose answer is yet to come.
   */
  pendingMints(): PendingMints {
    const { records, devices } = this.options;
    return {
      // Until the device store is read, which host devices are linked is
      // unknown: nothing is reconciled, and the mints wait for a later connect.
      list: (hostId) =>
        devices.ready
          ? records.pendingMints(hostId).filter((m) => m.label !== this.minting.get(hostId))
          : [],
      clear: (hostId, labels) => records.clearPendingMints(hostId, labels),
      linked: (hostId) => this.linkedOn(hostId),
    };
  }

  /** The host's own ids for the pairings linked there (its "via This Mac" rows). */
  linkedOn(hostId: string): string[] {
    return this.options.devices.linksOn(hostId).map((l) => l.hostDeviceId);
  }

  private async linkOne(
    client: Pick<HostServerClient, "hostId" | "state" | "api">,
    deviceId: string,
    label: string,
    held: ReadonlySet<string>,
  ): Promise<LinkedHostPairing | null> {
    const { hostId } = client;
    const { records, devices } = this.options;
    if (client.state !== "connected" || !records.linkPhones(hostId)) return null;
    const status = await client.api.hostServer.status();
    const { roomId } = serverFactsOf(status);
    if (roomId === null || held.has(roomId)) return null;
    // A pairing with a room the relay does not hold open is one the device
    // cannot dial, and its router would only wait on it. Asked again on the
    // device's next hello, by when it may be.
    if (!status.relay.connected) return null;
    // Its pairing here was revoked on the host (ADR-238 D2).
    if (devices.hostBlocks(deviceId).includes(hostId)) return null;

    // A link the device has let go of: revoked with the new one's mint —
    // unless the host no longer has it (`settle`). One already owed a revoke
    // is the queue's, not a sign of anything done on the host.
    const owed = new Set(records.pendingRevokes(hostId));
    const links = devices.hostLinks(deviceId).filter((l) => l.hostId === hostId);
    const toSettle = links
      .filter((l) => !owed.has(l.hostDeviceId))
      .map((l) => ({ deviceId, ...l }));
    let present: string[] = [];
    if (toSettle.length > 0) {
      const settled = await this.settle(client, hostId, roomId, toSettle);
      if (settled.blocked.has(deviceId)) {
        this.options.pairingChanged(hostId);
        return null;
      }
      present = settled.present;
    }
    records.addPendingRevokes(hostId, present);
    // Owed now, the old links are the revoke queue's, not the device's: one
    // left recorded past a failed mint would, once revoked, look revoked on
    // the host to `settle` and block the device.
    if (links.length > 0) await devices.dropHostLinks(hostId, deviceId);

    // Recorded before the host is asked, so a mint whose answer is lost —
    // the host committed it, the channel dropped — is found on the next
    // connect rather than left on the host linked to nothing.
    const mint: PendingMint = { label: mintLabel(label), startedAt: Date.now() };
    records.addPendingMint(hostId, mint);
    this.minting.set(hostId, mint.label);
    let link: ReturnType<typeof parseRelayPairingUrl>;
    let recorded: boolean;
    try {
      const result = await client.api.remoteControl.pair(mint.label);
      link = parseRelayPairingUrl(result.pairingUrl);
      // A room other than the status's: the host's keys were reset since,
      // by something other than this desktop. The pairing is in a room the
      // relay no longer holds for it; the next hello mints again.
      const sameRoom = link !== null && link.roomId === roomId;
      if (link !== null && !sameRoom) {
        this.log.warn(`[host-links] ${hostId}: its room changed during a mint; not linking it`);
      }
      recorded =
        sameRoom &&
        (await devices.setHostLink(deviceId, { hostId, hostDeviceId: result.device.id, roomId }));
      if (!recorded) {
        // Revoked while this ran, a link this build cannot read, or a stale
        // room: what was just minted must not outlive the call.
        records.addPendingRevokes(hostId, [result.device.id]);
      }
      records.clearPendingMints(hostId, [mint.label]);
    } finally {
      this.minting.delete(hostId);
    }
    await this.options.revokePending(hostId);
    this.options.pairingChanged(hostId);
    if (!recorded || link === null) return null;
    return {
      roomId: link.roomId,
      serverKey: link.x25519Pub,
      token: link.rawToken,
      name: records.label(hostId),
    };
  }

  /**
   * What became of `links` on `hostId`, from one `listDevices` (ADR-238 D2):
   * - **listed**: still there, and `present` — a mint owes it a revoke;
   * - **absent, minted in another room** than the host's now (`roomId`):
   *   lost to a reset made elsewhere. The link is forgotten;
   * - **absent otherwise** (the same room, or a link from before ADR-238
   *   that does not say): revoked on the host. The device is blocked there.
   * A failing `listDevices` rejects, and nothing is settled.
   */
  private async settle(
    client: Pick<HostServerClient, "api">,
    hostId: string,
    roomId: string,
    links: ReadonlyArray<{ deviceId: string } & HostLink>,
  ): Promise<Settled> {
    const { devices } = this.options;
    const listed = new Set((await client.api.remoteControl.listDevices()).map((d) => d.id));
    const out: Settled = { present: [], blocked: new Set(), changed: false };
    for (const link of links) {
      if (listed.has(link.hostDeviceId)) {
        out.present.push(link.hostDeviceId);
      } else if (link.roomId !== undefined && link.roomId !== roomId) {
        await devices.dropHostLinks(hostId, link.deviceId);
        out.changed = true;
      } else {
        this.log.warn(
          `[host-links] ${hostId}: a device's pairing there was revoked on the host; not pairing it there again`,
        );
        await devices.blockHost(link.deviceId, hostId);
        out.blocked.add(link.deviceId);
        out.changed = true;
      }
    }
    return out;
  }

  /** Owe every revoked device's links to their hosts, then try them now. */
  private cascade(revoked: readonly RevokedDevice[]): void {
    const byHost = new Map<string, string[]>();
    for (const { hostLinks } of revoked) {
      for (const { hostId, hostDeviceId } of hostLinks) {
        byHost.set(hostId, [...(byHost.get(hostId) ?? []), hostDeviceId]);
      }
    }
    for (const [hostId, ids] of byHost) {
      this.options.records.addPendingRevokes(hostId, ids);
      void this.options.revokePending(hostId).catch((err: unknown) => {
        this.log.warn(`[host-links] ${hostId}: revoke failed: ${errorMessage(err)}`);
      });
    }
  }
}
