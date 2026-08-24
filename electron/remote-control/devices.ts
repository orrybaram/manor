/**
 * Per-device bearer tokens for the remote-control listener (ADR-161).
 *
 * The listener has no network boundary once a tunnel is up, so this store *is*
 * the boundary. Three properties are load-bearing and every change here should
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
  /** Write capability. Off unless the user ticked the box at pairing. */
  canSend: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  /**
   * Web Push endpoint for this device, if it subscribed. Stored *on the device*
   * rather than in a table of its own so that revoking a device revokes its
   * push channel in the same operation — there is no second place to forget.
   */
  pushSubscription: PushSubscriptionRecord | null;
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
  "tokenHash" | "pushSubscription"
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
    canSend: boolean,
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
      canSend,
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
   * Attach (or clear) a device's push subscription. Called from the listener's
   * `POST /push/subscribe`; a revoked device is simply absent, so a late
   * subscribe from one is dropped rather than resurrecting it.
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
      for (const entry of parsed) {
        const device = asDevice(entry);
        if (device) this.devices.set(device.id, device);
      }
    } catch {
      // Corrupt payload — same recovery.
    }
  }

  private persist(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new EncryptionUnavailableError();
    }
    const payload = JSON.stringify([...this.devices.values()]);
    const encrypted = safeStorage.encryptString(payload);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, encrypted, { mode: 0o600 });
    // `mode` only applies when the file is created, so an existing file keeps
    // whatever it had. Restate it every write.
    fs.chmodSync(this.filePath, 0o600);
  }
}

function publicView(device: RemoteDevice): RemoteDeviceInfo {
  const { tokenHash: _tokenHash, pushSubscription, ...rest } = device;
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

/** Validate one persisted row. A row that fails any check is dropped. */
function asDevice(value: unknown): RemoteDevice | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.label !== "string") return null;
  if (typeof v.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(v.tokenHash))
    return null;
  if (typeof v.canSend !== "boolean") return null;
  if (typeof v.createdAt !== "number") return null;
  const lastSeenAt = typeof v.lastSeenAt === "number" ? v.lastSeenAt : null;
  return {
    id: v.id,
    label: v.label,
    tokenHash: v.tokenHash,
    canSend: v.canSend,
    createdAt: v.createdAt,
    lastSeenAt,
    pushSubscription: asSubscription(v.pushSubscription),
  };
}
