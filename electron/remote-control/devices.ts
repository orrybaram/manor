/**
 * Per-device bearer tokens for remote control (ADR-161).
 *
 * Anyone who can reach the relay can say hello, so this store *is* the
 * boundary. Three properties are load-bearing and every change here should
 * be read against them:
 *
 *   1. A raw token exists exactly once, in the return value of `pair()`. Only
 *      its SHA-256 is kept, in memory and on disk, so a stolen device file does
 *      not yield a working credential.
 *   2. `verify()` compares hashes with `timingSafeEqual` over equal-length
 *      buffers and never short-circuits on a match, so neither the token's
 *      length nor its position in the list is observable through timing.
 *   3. `revoke()` mutates the live map the lookup walks. Nothing caches a copy
 *      of the device list, so revocation takes effect on the next request.
 *
 * Persistence follows `electron/linear.ts` — `safeStorage.encryptString` into
 * `manorDataDir()`, mode 0600. If the OS keychain is unavailable we refuse to
 * store rather than degrading to plaintext: a plaintext bearer token on disk is
 * worse than a feature that will not turn on.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

import { remoteDevicesFile } from "../paths";

export interface RemoteDevice {
  /** Random id. Safe to log — it is not a credential. */
  id: string;
  /** User-supplied, e.g. "Orry's phone". */
  label: string;
  /** SHA-256 hex of the raw token. Never leaves this module. */
  tokenHash: string;
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
   * Fields a newer release wrote that this one does not know, carried
   * through untouched so a downgrade-then-upgrade does not lose them. A
   * build that rebuilt each row from only the fields it knew would strip
   * them on its first write, and whatever they meant would be gone by the
   * time the newer build read the file again.
   */
  extra?: Record<string, unknown>;
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
  "tokenHash" | "pushSubscription" | "relayRoom" | "extra"
> & { hasPush: boolean };

/** Raised when the OS keychain cannot encrypt — pairing must not proceed. */
export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      "OS encryption is unavailable, so a remote-control token cannot be " +
        "stored safely. Remote control stays off rather than writing a bearer " +
        "token to disk in plaintext.",
    );
    this.name = "EncryptionUnavailableError";
  }
}

const TOKEN_BYTES = 32;
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

export class RemoteDeviceStore {
  private readonly filePath: string;
  /** The live lookup. `revoke()` deletes from this map and nothing else. */
  private devices = new Map<string, RemoteDevice>();
  private loaded = false;

  constructor(filePath: string = remoteDevicesFile()) {
    this.filePath = filePath;
  }

  /**
   * Mint a device. The returned `rawToken` is the only time it exists in a
   * readable form anywhere — the caller shows it once (QR + copyable text) and
   * drops it.
   */
  pair(
    label: string,
    /** The relay room the device's link points at. */
    relayRoom: string,
  ): {
    device: RemoteDeviceInfo;
    rawToken: string;
  } {
    this.load();
    if (!safeStorage.isEncryptionAvailable()) {
      throw new EncryptionUnavailableError();
    }

    const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    const device: RemoteDevice = {
      id: crypto.randomUUID(),
      label,
      tokenHash: sha256Hex(rawToken),
      relayRoom,
      createdAt: Date.now(),
      lastSeenAt: null,
      pushSubscription: null,
    };
    this.devices.set(device.id, device);
    this.persist();
    return { device: publicView(device), rawToken };
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
    this.load();
    if (typeof rawToken !== "string" || rawToken.length === 0) return null;

    let presented: Buffer;
    try {
      presented = Buffer.from(sha256Hex(rawToken), "hex");
    } catch {
      return null;
    }
    if (presented.length !== HASH_BYTES) return null;

    let matched: RemoteDevice | null = null;
    for (const device of this.devices.values()) {
      const stored = Buffer.from(device.tokenHash, "hex");
      if (stored.length !== HASH_BYTES) continue;
      if (crypto.timingSafeEqual(presented, stored)) matched = device;
    }
    if (!matched) return null;

    const now = Date.now();
    const previous = matched.lastSeenAt;
    matched.lastSeenAt = now;
    if (previous === null || now - previous > LAST_SEEN_FLUSH_MS) {
      this.persist();
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
    this.load();
    const device = this.devices.get(id);
    if (!device) return false;
    device.pushSubscription = subscription;
    this.persist();
    return true;
  }

  /** Every device that can currently receive a push. */
  pushTargets(): Array<{
    device: RemoteDeviceInfo;
    subscription: PushSubscriptionRecord;
  }> {
    this.load();
    const targets: Array<{
      device: RemoteDeviceInfo;
      subscription: PushSubscriptionRecord;
    }> = [];
    for (const device of this.devices.values()) {
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
    this.load();
    return [...this.devices.keys()];
  }

  /**
   * Devices whose link points at a room other than `roomId` — dead links,
   * once the identity has changed.
   */
  idsInOtherRelayRooms(roomId: string): string[] {
    this.load();
    return [...this.devices.values()]
      .filter((d) => d.relayRoom !== roomId)
      .map((d) => d.id);
  }

  /** Immediate: the map this deletes from is what `verify()` walks. */
  revoke(id: string): void {
    this.load();
    if (this.devices.delete(id)) this.persist();
  }

  list(): RemoteDeviceInfo[] {
    this.load();
    return [...this.devices.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicView);
  }

  /** Test seam and shutdown hook: forget everything in memory. */
  reset(): void {
    this.devices = new Map();
    this.loaded = false;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let decrypted: string;
    try {
      const encrypted = fs.readFileSync(this.filePath);
      decrypted = safeStorage.decryptString(encrypted);
    } catch {
      // No file yet, or a file this install can no longer decrypt (a restored
      // backup, a new keychain). Either way there are no usable devices, and
      // the user re-pairs — which is exactly the recovery story the per-device
      // model is for.
      return;
    }
    try {
      const parsed: unknown = JSON.parse(decrypted);
      if (!Array.isArray(parsed)) return;
      let migrated = false;
      for (const entry of parsed) {
        const device = asDevice(entry);
        if (!device) {
          migrated = true;
          continue;
        }
        this.devices.set(device.id, device);
        const raw = entry as Record<string, unknown>;
        if (RETIRED_FIELDS.some((field) => field in raw)) migrated = true;
      }
      // Rewrite now rather than waiting for the next pair or `lastSeenAt`
      // flush: a dropped row (a Tailscale, Watch or Reply device — ADR-207
      // D5) or a retired field would otherwise linger on disk for a device
      // that is never used again.
      if (migrated) {
        try {
          this.persist();
        } catch {
          // A machine that cannot encrypt still gets the in-memory migration;
          // refusing to *read* here would lock the user out of their own
          // devices over a write we do not need.
        }
      }
    } catch {
      // Corrupt payload — same recovery.
    }
  }

  private persist(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new EncryptionUnavailableError();
    }
    const payload = JSON.stringify(
      [...this.devices.values()].map(({ extra, ...known }) => ({
        ...extra,
        ...known,
      })),
    );
    const encrypted = safeStorage.encryptString(payload);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, encrypted, { mode: 0o600 });
    // `mode` only applies when the file is created, so an existing file keeps
    // whatever it had. Restate it every write.
    fs.chmodSync(this.filePath, 0o600);
  }
}

function publicView(device: RemoteDevice): RemoteDeviceInfo {
  const {
    tokenHash: _tokenHash,
    pushSubscription,
    relayRoom: _relayRoom,
    extra: _extra,
    ...rest
  } = device;
  return { ...rest, hasPush: pushSubscription !== null };
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
  "relayRoom",
  "createdAt",
  "lastSeenAt",
  "pushSubscription",
]);

/**
 * Fields older releases wrote and this one no longer does: `canSend`
 * (before ADR-178), then `capability` and `via` (before ADR-207). They are
 * read to decide whether a row survives, never carried forward as `extra`.
 */
const RETIRED_FIELDS = ["canSend", "capability", "via"] as const;

/**
 * Validate one persisted row. A row that fails any check is dropped.
 *
 * Only relay devices survive (ADR-207 D5). A row in the old shape must say
 * `via: "relay"` and, if it names a tier, `full` — relay pairings were never
 * anything else. A row from before ADR-206 has no `via` and no `relayRoom`,
 * so the room check drops it with the Tailscale, Watch and Reply rows.
 */
function asDevice(value: unknown): RemoteDevice | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.label !== "string") return null;
  if (typeof v.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(v.tokenHash))
    return null;
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
  return {
    id: v.id,
    label: v.label,
    tokenHash: v.tokenHash,
    relayRoom: v.relayRoom,
    createdAt: v.createdAt,
    lastSeenAt,
    pushSubscription: asSubscription(v.pushSubscription),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}
