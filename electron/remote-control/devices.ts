/**
 * Per-device bearer tokens for remote control.
 *
 * Anyone who can reach the relay can say hello, so this store *is* the
 * boundary. Three properties are load-bearing and every change here should
 * be read against them:
 *
 *   1. The store never holds a raw token. A token reaches it only in the
 *      hello that redeems a pairing ticket (`redeem()`), or, for a host
 *      pairing the desktop mints over an authenticated channel, in the return
 *      value of `pair(..., { direct: true })`. Only its SHA-256 is kept, in
 *      memory and on disk, so a stolen device file does not yield a working
 *      credential. A pairing ticket exists once, in the return value
 *      of `pair()` or `reissue()`; the store keeps its hash, and a ticket is
 *      never a bearer token: `verify()` ignores pending devices.
 *   2. `verify()` compares hashes with `timingSafeEqual` over equal-length
 *      buffers and never short-circuits on a match, so neither the token's
 *      length nor its position in the list is observable through timing.
 *   3. `revoke()` mutates the live map the lookup walks. Nothing caches a copy
 *      of the device list, so revocation takes effect on the next request.
 *
 * Persistence is a `SealedStore` over the `SecretBox` the store is given:
 * `safeStorage` on the desktop, the host's chosen backend on a
 * host server, mode 0600 either way. When the box cannot store (a desktop with
 * no OS keychain) pairing refuses, and remote control stays off. Pairing and
 * revoking resolve only once the change is on disk: a revoke that was not
 * saved would quietly come back on the next start.
 *
 * On a desktop, each device also carries the pairings minted for it on remote
 * hosts' servers (`hostLinks`) and the hosts where such a pairing
 * was revoked on the host itself (`hostBlocks`), where nothing is
 * minted for it again until that host's switch is turned off and on. Neither
 * leaves this module through `list()`.
 */

import crypto from "node:crypto";

import { remoteDevicesFile } from "../paths";
import type { SecretBox } from "../platform/secret-box";
import {
  EncryptionUnavailableError,
  SealedStore,
  type SealedCodec,
} from "../platform/sealed-store";

export interface RemoteDevice {
  /** Random id. Safe to log — it is not a credential. */
  id: string;
  /** User-supplied, e.g. "Orry's phone". */
  label: string;
  /**
   * SHA-256 hex of the raw token. Never leaves this module. Null while the
   * device is pending: its token is chosen by the device and arrives with the
   * ticket.
   */
  tokenHash: string | null;
  /**
   * The pairing ticket awaiting redemption: its SHA-256 hex and
   * when it stops working. Present exactly when `tokenHash` is null. An
   * expired row is kept, and reads "Link expired" until given a new link.
   */
  pending?: { ticketHash: string; expiresAt: number };
  /**
   * The relay room the device's link points at. When the desktop's relay
   * identity changes underneath it (an unreadable identity file is replaced
   * by a new one), every device whose room is not the current one holds a
   * dead link — the controller revokes those.
   */
  relayRoom: string;
  createdAt: number;
  lastSeenAt: number | null;
  /**
   * Web Push endpoint for this device, if it subscribed. Stored *on the device*
   * rather than in a table of its own so that revoking a device revokes its
   * push channel in the same operation — there is no second place to forget.
   */
  pushSubscription: PushSubscriptionRecord | null;
  /**
   * The pairings this desktop minted for the device on its remote hosts'
   * servers (`remoteControl.linkHostPairings`), one per host.
   * Kept on the device for the reason `pushSubscription` is: revoking the
   * device is what revokes these, and the revoke listeners are handed them.
   * Absent on a host server, which links nothing.
   */
  hostLinks?: HostLink[];
  /**
   * The hosts (the desktop's ids) where this device's linked pairing was
   * revoked on the host itself. Nothing is minted for it there
   * until the host's "can reach" switch is turned off and on. Kept on the
   * device so its revoke takes these with it. Absent when there are none.
   */
  hostBlocks?: string[];
  /**
   * Fields a newer release wrote that this one does not know, carried
   * through untouched so a downgrade-then-upgrade does not lose them. A
   * build that rebuilt each row from only the fields it knew would strip
   * them on its first write, and whatever they meant would be gone by the
   * time the newer build read the file again.
   */
  extra?: Record<string, unknown>;
}

/** One pairing minted for a device on a remote host's server. */
export interface HostLink {
  /** The desktop's id for the host. */
  hostId: string;
  /** The device's id in that host's own device store. */
  hostDeviceId: string;
  /**
   * The host's room the pairing was minted in: a link missing
   * from a host whose room has changed since was lost to a reset, not
   * revoked. Absent on older links.
   */
  roomId?: string;
}

/** A device a revoke took away, and the host pairings it held. */
export interface RevokedDevice {
  id: string;
  hostLinks: readonly HostLink[];
}

/** The subset of a `PushSubscription` the push service needs back. */
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * What `list()` hands out: a device minus the token hash and minus the push
 * endpoint, which is a capability URL in its own right.
 */
export type RemoteDeviceInfo = Omit<
  RemoteDevice,
  "tokenHash" | "pending" | "pushSubscription" | "relayRoom" | "extra" | "hostLinks" | "hostBlocks"
> & { hasPush: boolean; pending?: { expiresAt: number } };

const TOKEN_BYTES = 32;
/** A pairing ticket has the same shape as a token: 32 random bytes, base64url. */
const TICKET_BYTES = 32;
/** What a device-chosen token must look like (43 base64url characters). */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** How long a pairing ticket works. */
export const PAIRING_TICKET_TTL_MS = 10 * 60_000;
const HASH_BYTES = 32; // sha256

/**
 * How stale `lastSeenAt` may get on disk before a verify triggers a write.
 * Without this a phone polling every 5s would rewrite the device file every
 * 5s; the in-memory value is always current either way.
 */
const LAST_SEEN_FLUSH_MS = 60_000;

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** What the device file holds, and whether loading it changed anything. */
interface StoredDevices {
  devices: RemoteDevice[];
  /**
   * Set by `parse` when a row was dropped or carried a retired field, so the
   * file is rewritten without it. Never serialized.
   */
  migrated?: boolean;
}

const DEVICES_CODEC: SealedCodec<StoredDevices> = {
  parse(text) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    const devices: RemoteDevice[] = [];
    let migrated = false;
    for (const entry of parsed) {
      const device = asDevice(entry);
      if (!device) {
        migrated = true;
        continue;
      }
      devices.push(device);
      const raw = entry as Record<string, unknown>;
      if (RETIRED_FIELDS.some((field) => field in raw)) migrated = true;
    }
    return { devices, migrated };
  },
  serialize: ({ devices }) =>
    JSON.stringify(devices.map(({ extra, ...known }) => ({ ...extra, ...known }))),
};

export class RemoteDeviceStore {
  /**
   * The live lookup, once `init()` has run. `revoke()` deletes from this map
   * and nothing else.
   */
  private devices: Map<string, RemoteDevice> | null = null;
  private readonly store: SealedStore<StoredDevices>;
  private readonly revokeListeners = new Set<
    (revoked: readonly RevokedDevice[]) => void
  >();

  private readonly ticketTtlMs: number;

  constructor(
    private readonly secretBox: SecretBox,
    filePath: string = remoteDevicesFile(),
    options: { ticketTtlMs?: number } = {},
  ) {
    this.ticketTtlMs = options.ticketTtlMs ?? ticketTtlFromEnv();
    this.store = new SealedStore(
      secretBox,
      filePath,
      "paired devices",
      DEVICES_CODEC,
    );
  }

  /**
   * Decrypt the file into memory. Must complete before any other method: the
   * secret box is async, so the rest of this API reads the cached state and
   * stays synchronous (`verify()` is on the hello path).
   *
   * No file, or one this install can no longer decrypt (a restored backup, a
   * new keychain), means no usable devices, and the user re-pairs — which is
   * exactly the recovery story the per-device model is for. A box that could
   * not run at all rejects instead (`SecretBoxUnavailableError`), leaving the
   * file alone.
   */
  async init(): Promise<void> {
    if (this.devices) return;
    const stored = await this.store.init();
    const devices = new Map<string, RemoteDevice>();
    for (const device of stored?.devices ?? []) devices.set(device.id, device);
    this.devices = devices;
    // Rewrite now rather than waiting for the next pair or `lastSeenAt`
    // flush: a dropped row (a Tailscale, Watch or Reply device) or a retired field would otherwise linger on disk for a device
    // that is never used again.
    if (stored?.migrated) {
      try {
        this.persist();
      } catch {
        // A machine that cannot encrypt still gets the in-memory migration;
        // refusing to *read* here would lock the user out of their own
        // devices over a write we do not need.
      }
    }
  }

  /** Resolves once every queued write has reached disk; rejects if one failed. */
  flush(): Promise<void> {
    return this.store.flush();
  }

  /**
   * Mint a device. By default it is pending: the returned
   * `ticket` is the only time it exists in a readable form anywhere, the
   * caller shows it once in a link (QR + copyable text) and drops it, and the
   * device chooses its own token when it redeems the ticket. With
   * `direct: true` the device is active at once and the returned `rawToken` is
   * the token, for a caller that hands it over an authenticated channel.
   * Resolves once the device is on disk; a device that could not
   * be saved is dropped again, and the failure rejects.
   */
  async pair(
    label: string,
    relayRoom: string,
    options: { direct: true },
  ): Promise<{ device: RemoteDeviceInfo; rawToken: string }>;
  async pair(
    label: string,
    relayRoom: string,
    options?: { direct?: false },
  ): Promise<{ device: RemoteDeviceInfo; ticket: string; expiresAt: number }>;
  async pair(
    label: string,
    relayRoom: string,
    options?: { direct?: boolean },
  ): Promise<
    | { device: RemoteDeviceInfo; rawToken: string }
    | { device: RemoteDeviceInfo; ticket: string; expiresAt: number }
  >;
  async pair(
    label: string,
    /** The relay room the device's link points at. */
    relayRoom: string,
    options: { direct?: boolean } = {},
  ): Promise<
    | { device: RemoteDeviceInfo; rawToken: string }
    | { device: RemoteDeviceInfo; ticket: string; expiresAt: number }
  > {
    const devices = this.live();
    if (!this.secretBox.available()) {
      throw new EncryptionUnavailableError();
    }

    const direct = options.direct === true;
    const rawToken = direct
      ? crypto.randomBytes(TOKEN_BYTES).toString("base64url")
      : null;
    const ticket = direct
      ? null
      : crypto.randomBytes(TICKET_BYTES).toString("base64url");
    const expiresAt = Date.now() + this.ticketTtlMs;
    const device: RemoteDevice = {
      id: crypto.randomUUID(),
      label,
      tokenHash: rawToken === null ? null : sha256Hex(rawToken),
      ...(ticket === null
        ? {}
        : { pending: { ticketHash: sha256Hex(ticket), expiresAt } }),
      relayRoom,
      createdAt: Date.now(),
      lastSeenAt: null,
      pushSubscription: null,
    };
    devices.set(device.id, device);
    try {
      this.persist();
      await this.store.flush();
    } catch (err) {
      devices.delete(device.id);
      throw err;
    }
    if (rawToken !== null) return { device: publicView(device), rawToken };
    return { device: publicView(device), ticket: ticket as string, expiresAt };
  }

  /**
   * Give a pending device (waiting or expired) a new ticket and a new expiry;
   * the old ticket is dead. A device that has connected already
   * has no ticket to replace, and an unknown id is the same refusal. Resolves
   * once it is on disk; a write that fails restores the old ticket and rejects.
   */
  async reissue(
    id: string,
  ): Promise<{ device: RemoteDeviceInfo; ticket: string; expiresAt: number }> {
    const device = this.live().get(id);
    if (!device || !device.pending) {
      throw new Error("Only a device that has not connected yet can get a new link.");
    }
    const previous = device.pending;
    const ticket = crypto.randomBytes(TICKET_BYTES).toString("base64url");
    const expiresAt = Date.now() + this.ticketTtlMs;
    device.pending = { ticketHash: sha256Hex(ticket), expiresAt };
    try {
      this.persist();
      await this.store.flush();
    } catch (err) {
      device.pending = previous;
      throw err;
    }
    return { device: publicView(device), ticket, expiresAt };
  }

  /**
   * Redeem a pairing ticket: the device that holds it chose `token`, and from
   * here that token is the device's credential. Synchronous, like
   * `verify()`, because it runs on the hello path; the write is queued, not
   * awaited.
   *
   * Like `verify()`, it hashes the presented ticket and walks every pending
   * device without stopping at a match, so neither a ticket's validity nor its
   * position is observable through timing. A match that has expired, a token
   * that is malformed and a token some device already has all return null and
   * leave the row as it was. So does a token equal to the ticket.
   */
  redeem(ticket: unknown, token: unknown): RemoteDevice | null {
    const devices = this.live();
    if (typeof ticket !== "string" || ticket.length === 0) return null;
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
    // The ticket as the token would make the link the long-lived credential
    // again, which is the one thing this exchange exists to prevent.
    if (token === ticket) return null;

    const presented = Buffer.from(sha256Hex(ticket), "hex");
    let matched: RemoteDevice | null = null;
    for (const device of devices.values()) {
      if (!device.pending) continue;
      const stored = Buffer.from(device.pending.ticketHash, "hex");
      if (stored.length !== HASH_BYTES) continue;
      if (crypto.timingSafeEqual(presented, stored)) matched = device;
    }
    if (!matched || !matched.pending) return null;

    const now = Date.now();
    if (matched.pending.expiresAt < now) return null;

    const tokenHash = sha256Hex(token);
    for (const device of devices.values()) {
      if (device.tokenHash === tokenHash) return null;
    }

    const { pending } = matched;
    const previousLastSeenAt = matched.lastSeenAt;
    matched.tokenHash = tokenHash;
    delete matched.pending;
    matched.lastSeenAt = now;
    try {
      this.persist();
    } catch {
      // The store cannot encrypt: refuse rather than activate a device that a
      // restart would forget. The ticket stays redeemable until it expires.
      matched.tokenHash = null;
      matched.pending = pending;
      matched.lastSeenAt = previousLastSeenAt;
      return null;
    }
    return matched;
  }

  /**
   * Resolve a presented token to its device, or `null`.
   *
   * Deliberately walks every device without breaking on a hit: an early return
   * would make "matched the first device" distinguishable from "matched the
   * last" by timing. The presented value is hashed first so a wrong-length
   * token costs the same as a right-length one and `timingSafeEqual` never
   * sees mismatched buffers.
   */
  verify(rawToken: unknown): RemoteDevice | null {
    const devices = this.live();
    if (typeof rawToken !== "string" || rawToken.length === 0) return null;

    let presented: Buffer;
    try {
      presented = Buffer.from(sha256Hex(rawToken), "hex");
    } catch {
      return null;
    }
    if (presented.length !== HASH_BYTES) return null;

    let matched: RemoteDevice | null = null;
    for (const device of devices.values()) {
      if (device.tokenHash === null) continue;
      const stored = Buffer.from(device.tokenHash, "hex");
      if (stored.length !== HASH_BYTES) continue;
      if (crypto.timingSafeEqual(presented, stored)) matched = device;
    }
    if (!matched) return null;

    const now = Date.now();
    const previous = matched.lastSeenAt;
    matched.lastSeenAt = now;
    if (previous === null || now - previous > LAST_SEEN_FLUSH_MS) {
      try {
        this.persist();
      } catch {
        // `lastSeenAt` is a courtesy; a store that cannot write must not turn
        // a valid hello away. The failure is the store's to report, to the
        // next pair or revoke.
      }
    }
    return matched;
  }

  /**
   * Attach (or clear) a device's push subscription. Called from the bridge's
   * `remoteControl.subscribePush`; a revoked device is simply absent, so a
   * late subscribe from one is dropped rather than resurrecting it.
   */
  setPushSubscription(
    id: string,
    subscription: PushSubscriptionRecord | null,
  ): boolean {
    const device = this.live().get(id);
    if (!device) return false;
    device.pushSubscription = subscription;
    this.persist();
    return true;
  }

  /**
   * Drop every device's push subscription, keeping the devices paired. For a
   * VAPID key change: the old subscriptions are bound to the old key, so a
   * push signed with the new one would be refused. The phone re-subscribes on
   * its next load.
   */
  clearPushSubscriptions(): void {
    let changed = false;
    for (const device of this.live().values()) {
      if (device.pushSubscription) {
        device.pushSubscription = null;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Every device that can currently receive a push. */
  pushTargets(): Array<{
    device: RemoteDeviceInfo;
    subscription: PushSubscriptionRecord;
  }> {
    const targets: Array<{
      device: RemoteDeviceInfo;
      subscription: PushSubscriptionRecord;
    }> = [];
    for (const device of this.live().values()) {
      if (device.pushSubscription)
        targets.push({
          device: publicView(device),
          subscription: device.pushSubscription,
        });
    }
    return targets;
  }

  /** Ids of every paired device. */
  ids(): string[] {
    return [...this.live().keys()];
  }

  /**
   * Devices whose link points at a room other than `roomId` — dead links,
   * once the identity has changed.
   */
  idsInOtherRelayRooms(roomId: string): string[] {
    return [...this.live().values()]
      .filter((d) => d.relayRoom !== roomId)
      .map((d) => d.id);
  }

  /**
   * Immediate: the map this deletes from is what `verify()` walks, so the
   * device is refused from this call on. Resolves once that is on disk too;
   * rejects when it could not be saved (the device would come back on the
   * next start), and the caller says so.
   */
  revoke(id: string): Promise<void> {
    return this.revokeMany([id]);
  }

  /** `revoke` for several devices, in one write. */
  async revokeMany(ids: readonly string[]): Promise<void> {
    const devices = this.live();
    const revoked: RevokedDevice[] = [];
    for (const id of ids) {
      const device = devices.get(id);
      if (!device) continue;
      devices.delete(id);
      revoked.push({ id, hostLinks: device.hostLinks ?? [] });
    }
    if (revoked.length === 0) return;
    // Before the write: a revoke that reaches the map is a revoke, saved or
    // not, and whatever it takes down with it must hear so.
    for (const listener of [...this.revokeListeners]) listener(revoked);
    this.persist();
    await this.store.flush();
  }

  /**
   * Hear every revoke — one by hand, a relay reset's, a stale room's — with
   * the host links each revoked device held.
   */
  onRevoke(
    listener: (revoked: readonly RevokedDevice[]) => void,
  ): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  /** `id`'s label, or null for a device that is not paired. */
  label(id: string): string | null {
    return this.live().get(id)?.label ?? null;
  }

  /** The pairings minted for `id` on remote hosts; empty when none. */
  hostLinks(id: string): readonly HostLink[] {
    return this.live().get(id)?.hostLinks ?? [];
  }

  /** Every link on `hostId`, with the desktop device each belongs to. */
  linksOn(hostId: string): Array<{ deviceId: string } & HostLink> {
    const out: Array<{ deviceId: string } & HostLink> = [];
    for (const device of this.live().values()) {
      for (const link of device.hostLinks ?? []) {
        if (link.hostId === hostId) out.push({ deviceId: device.id, ...link });
      }
    }
    return out;
  }

  /** The hosts where `id`'s linked pairing was revoked on the host. */
  hostBlocks(id: string): readonly string[] {
    return this.live().get(id)?.hostBlocks ?? [];
  }

  /**
   * `id`'s linked pairing on `hostId` was revoked on the host: mint it none
   * there again, and forget the link. False when the device is no longer
   * paired. Resolves once it is on disk.
   */
  async blockHost(id: string, hostId: string): Promise<boolean> {
    const device = this.live().get(id);
    if (!device) return false;
    const blocks = device.hostBlocks ?? [];
    if (!blocks.includes(hostId)) device.hostBlocks = [...blocks, hostId];
    const kept = (device.hostLinks ?? []).filter((l) => l.hostId !== hostId);
    if (kept.length > 0) device.hostLinks = kept;
    else delete device.hostLinks;
    this.persist();
    await this.store.flush();
    return true;
  }

  /** Every device blocked on `hostId`. */
  blockedOn(hostId: string): Array<{ deviceId: string; label: string }> {
    return [...this.live().values()]
      .filter((d) => d.hostBlocks?.includes(hostId))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((d) => ({ deviceId: d.id, label: d.label }));
  }

  /** Lift every device's block on `hostId`: the switch was turned back on. */
  async clearHostBlocks(hostId: string): Promise<void> {
    let changed = false;
    for (const device of this.live().values()) {
      const blocks = device.hostBlocks;
      if (!blocks?.includes(hostId)) continue;
      changed = true;
      const kept = blocks.filter((h) => h !== hostId);
      if (kept.length > 0) device.hostBlocks = kept;
      else delete device.hostBlocks;
    }
    if (!changed) return;
    this.persist();
    await this.store.flush();
  }

  /**
   * Record `link` for `id`, replacing its link on the same host. False when
   * the device is no longer paired: the caller revokes what it minted.
   * Resolves once it is on disk.
   */
  async setHostLink(id: string, link: HostLink): Promise<boolean> {
    const device = this.live().get(id);
    if (!device) return false;
    device.hostLinks = [
      ...(device.hostLinks ?? []).filter((l) => l.hostId !== link.hostId),
      link,
    ];
    this.persist();
    await this.store.flush();
    return true;
  }

  /**
   * Forget the links on `hostId` — every device's, or only `deviceId`'s.
   * The pairings themselves are the caller's to revoke.
   */
  async dropHostLinks(hostId: string, deviceId?: string): Promise<void> {
    let changed = false;
    for (const device of this.live().values()) {
      if (deviceId !== undefined && device.id !== deviceId) continue;
      const links = device.hostLinks ?? [];
      const kept = links.filter((l) => l.hostId !== hostId);
      if (kept.length === links.length) continue;
      changed = true;
      if (kept.length > 0) device.hostLinks = kept;
      else delete device.hostLinks;
    }
    if (!changed) return;
    this.persist();
    await this.store.flush();
  }

  /** Has `init()` read the file? Until it has, `list()` and the rest refuse. */
  get ready(): boolean {
    return this.devices !== null;
  }

  /** Can this install seal a token? False: pairing cannot store one. */
  encryptionAvailable(): boolean {
    return this.secretBox.available();
  }

  list(): RemoteDeviceInfo[] {
    return [...this.live().values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicView);
  }

  private live(): Map<string, RemoteDevice> {
    if (!this.devices) {
      throw new Error("RemoteDeviceStore.init() has not completed");
    }
    return this.devices;
  }

  private persist(): void {
    this.store.write({ devices: [...this.live().values()] });
  }
}

/** `MANOR_PAIRING_TICKET_TTL_MS` when it is a positive integer, else the default. */
function ticketTtlFromEnv(): number {
  const raw = process.env.MANOR_PAIRING_TICKET_TTL_MS;
  if (raw !== undefined && /^[0-9]+$/.test(raw)) {
    const ms = Number(raw);
    if (Number.isSafeInteger(ms) && ms > 0) return ms;
  }
  return PAIRING_TICKET_TTL_MS;
}

function publicView(device: RemoteDevice): RemoteDeviceInfo {
  const {
    tokenHash: _tokenHash,
    pending,
    pushSubscription,
    relayRoom: _relayRoom,
    extra: _extra,
    hostLinks: _hostLinks,
    hostBlocks: _hostBlocks,
    ...rest
  } = device;
  return {
    ...rest,
    hasPush: pushSubscription !== null,
    ...(pending ? { pending: { expiresAt: pending.expiresAt } } : {}),
  };
}

/** A stored push subscription, or null if it is not one. */
function asSubscription(value: unknown): PushSubscriptionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.endpoint !== "string" || !/^https:\/\//.test(v.endpoint))
    return null;
  const keys = v.keys;
  if (typeof keys !== "object" || keys === null) return null;
  const k = keys as Record<string, unknown>;
  if (typeof k.p256dh !== "string" || typeof k.auth !== "string") return null;
  return { endpoint: v.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}

/** Every field `asDevice` reads; anything else on a row is `extra`. */
const KNOWN_FIELDS = new Set([
  "id",
  "label",
  "tokenHash",
  "pending",
  "relayRoom",
  "createdAt",
  "lastSeenAt",
  "pushSubscription",
  "hostLinks",
  "hostBlocks",
]);

/** A stored device's host links; malformed entries are dropped. */
function asHostLinks(value: unknown): HostLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { hostId, hostDeviceId, roomId } = entry as Record<string, unknown>;
    if (typeof hostId !== "string" || typeof hostDeviceId !== "string") return [];
    return [{ hostId, hostDeviceId, ...(typeof roomId === "string" ? { roomId } : {}) }];
  });
}

/** A stored device's host blocks: unique, non-empty host ids; `[]` if malformed. */
function asHostBlocks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)];
}

/**
 * Fields older releases wrote and this one no longer does: `canSend`
 * then `capability` and `via`. They are
 * read to decide whether a row survives, never carried forward as `extra`.
 */
const RETIRED_FIELDS = ["canSend", "capability", "via"] as const;

/**
 * Validate one persisted row. A row that fails any check is dropped.
 *
 * Only relay devices survive. A row in the old shape must say
 * `via: "relay"` and, if it names a tier, `full` — relay pairings were never
 * anything else. An older row with no `via` has no `relayRoom` either,
 * so the room check drops it with the Tailscale, Watch and Reply rows.
 */
function asDevice(value: unknown): RemoteDevice | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.label !== "string") return null;
  // Active: a token hash. Pending: no token hash and a ticket.
  let tokenHash: string | null = null;
  let pending: RemoteDevice["pending"];
  if (typeof v.tokenHash === "string") {
    if (!/^[0-9a-f]{64}$/.test(v.tokenHash)) return null;
    tokenHash = v.tokenHash;
  } else if (v.tokenHash === null || v.tokenHash === undefined) {
    const p = v.pending;
    if (typeof p !== "object" || p === null) return null;
    const { ticketHash, expiresAt } = p as Record<string, unknown>;
    if (typeof ticketHash !== "string" || !/^[0-9a-f]{64}$/.test(ticketHash))
      return null;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
    pending = { ticketHash, expiresAt };
  } else {
    return null;
  }
  if (typeof v.relayRoom !== "string") return null;
  if ("via" in v && v.via !== "relay") return null;
  if ("capability" in v && v.capability !== "full") return null;
  if ("canSend" in v) return null;
  if (typeof v.createdAt !== "number") return null;
  const lastSeenAt = typeof v.lastSeenAt === "number" ? v.lastSeenAt : null;
  const extra: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(v)) {
    if (
      !KNOWN_FIELDS.has(field) &&
      !(RETIRED_FIELDS as readonly string[]).includes(field)
    )
      extra[field] = value;
  }
  const hostLinks = asHostLinks(v.hostLinks);
  const hostBlocks = asHostBlocks(v.hostBlocks);
  return {
    id: v.id,
    label: v.label,
    tokenHash,
    ...(pending ? { pending } : {}),
    relayRoom: v.relayRoom,
    createdAt: v.createdAt,
    lastSeenAt,
    pushSubscription: asSubscription(v.pushSubscription),
    ...(hostLinks.length > 0 ? { hostLinks } : {}),
    ...(hostBlocks.length > 0 ? { hostBlocks } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}
