/**
 * The desktop's relay identity (ADR-206 D3): an Ed25519 key that proves to
 * the relay this machine owns its room, and the X25519 key that is the Noise
 * NK static key a paired browser authenticates the desktop by.
 *
 * Stored the way `RemoteDeviceStore` stores tokens: `safeStorage`-encrypted
 * into `manorDataDir()`, mode 0600, and never written in plaintext — when the
 * OS keychain cannot encrypt, this throws `EncryptionUnavailableError` and the
 * relay stays off.
 *
 * Only the public half is cached. `load()` decrypts the file and hands the
 * private keys to the caller (the connector, while it is running), which
 * drops — and zeroes — them when it stops.
 */
import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

import {
  base64urlDecode,
  base64urlEncode,
  generateRelayIdentity,
  roomIdFor,
  type RelayIdentity,
} from "../../../src/lib/relay-crypto";
import { relayIdentityFile } from "../../paths";
import { EncryptionUnavailableError } from "../devices";

/** What a pairing link needs, and nothing secret. */
export interface RelayIdentityInfo {
  roomId: string;
  /** The X25519 static public key, base64url — the `#relay=<room>.<key>` half. */
  x25519Pub: string;
}

/** The file's JSON, before encryption. All keys base64url. */
interface StoredIdentity {
  v: 1;
  ed25519: { pub: string; priv: string };
  x25519: { pub: string; priv: string };
}

const KEY_BYTES = 32;

export class RelayIdentityStore {
  private info: RelayIdentityInfo | null = null;

  constructor(private readonly filePath: string = relayIdentityFile()) {}

  /** The room this desktop owns. Creates the identity on first use. */
  get roomId(): string {
    return this.describe().roomId;
  }

  /** The Noise static public key, base64url. Creates the identity on first use. */
  get x25519Pub(): string {
    return this.describe().x25519Pub;
  }

  /** Public half only. Creates and persists the identity if there is none. */
  describe(): RelayIdentityInfo {
    if (this.info) return { ...this.info };
    const identity = this.load();
    const info = infoOf(identity);
    wipe(identity);
    return info;
  }

  /**
   * The full identity, private keys included: read from disk, or generated
   * and persisted when there is none. The caller owns the returned copy and
   * should `wipe` it when done.
   *
   * A file that cannot be decrypted or parsed (a restored backup, a new
   * keychain) is unusable either way; it is replaced by a fresh identity,
   * which is a new room — exactly what "Reset relay address" does on purpose.
   */
  load(): RelayIdentity {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new EncryptionUnavailableError();
    }
    const existing = this.read();
    if (existing) {
      this.remember(existing);
      return existing;
    }
    return this.create();
  }

  /** Regenerate both keys: a new room, and every relay link dead at once. */
  reset(): RelayIdentityInfo {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new EncryptionUnavailableError();
    }
    const identity = this.create();
    const info = infoOf(identity);
    wipe(identity);
    return info;
  }

  private create(): RelayIdentity {
    const identity = generateRelayIdentity();
    this.persist(identity);
    this.remember(identity);
    return identity;
  }

  private remember(identity: RelayIdentity): void {
    this.info = infoOf(identity);
  }

  private read(): RelayIdentity | null {
    let decrypted: string;
    try {
      decrypted = safeStorage.decryptString(fs.readFileSync(this.filePath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[remote-control] relay identity could not be decrypted; " +
            "generating a new one (existing relay links stop working)",
        );
      }
      return null;
    }
    try {
      const parsed = JSON.parse(decrypted) as Partial<StoredIdentity>;
      if (parsed.v !== 1 || !parsed.ed25519 || !parsed.x25519) return null;
      const identity: RelayIdentity = {
        ed25519: {
          pub: key(parsed.ed25519.pub),
          priv: key(parsed.ed25519.priv),
        },
        x25519: { pub: key(parsed.x25519.pub), priv: key(parsed.x25519.priv) },
      };
      return identity;
    } catch {
      console.warn(
        "[remote-control] relay identity file is corrupt; generating a new one",
      );
      return null;
    }
  }

  private persist(identity: RelayIdentity): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new EncryptionUnavailableError();
    }
    const stored: StoredIdentity = {
      v: 1,
      ed25519: {
        pub: base64urlEncode(identity.ed25519.pub),
        priv: base64urlEncode(identity.ed25519.priv),
      },
      x25519: {
        pub: base64urlEncode(identity.x25519.pub),
        priv: base64urlEncode(identity.x25519.priv),
      },
    };
    const encrypted = safeStorage.encryptString(JSON.stringify(stored));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, encrypted, { mode: 0o600 });
    // `mode` only applies on create; restate it for an existing file.
    fs.chmodSync(this.filePath, 0o600);
  }
}

/** Overwrite the private keys in place. The identity is unusable afterwards. */
export function wipe(identity: RelayIdentity): void {
  identity.ed25519.priv.fill(0);
  identity.x25519.priv.fill(0);
}

function infoOf(identity: RelayIdentity): RelayIdentityInfo {
  return {
    roomId: roomIdFor(identity.ed25519.pub),
    x25519Pub: base64urlEncode(identity.x25519.pub),
  };
}

function key(value: unknown): Uint8Array {
  if (typeof value !== "string") throw new Error("missing key");
  const bytes = base64urlDecode(value);
  if (bytes.length !== KEY_BYTES) throw new Error("bad key length");
  return bytes;
}
