/**
 * The desktop's relay identity (ADR-206 D3): an Ed25519 key that proves to
 * the relay this machine owns its room, and the X25519 key that is the Noise
 * NK static key a paired browser authenticates the desktop by.
 *
 * Stored the way `RemoteDeviceStore` stores tokens: `SecretBox`-encrypted
 * into `manorDataDir()`, mode 0600, and never written in plaintext — when the
 * OS keychain cannot encrypt, this throws `EncryptionUnavailableError` and the
 * relay stays off.
 *
 * The secret box is async, so `init()` decrypts the file once into memory (or
 * creates the identity) and the rest of the API stays synchronous. `load()`
 * hands the caller (the connector, while it is running) a copy of the private
 * keys, which it drops — and zeroes — when it stops. The store's own copy is
 * never handed out.
 */

import {
  base64urlDecode,
  base64urlEncode,
  generateRelayIdentity,
  roomIdFor,
  type RelayIdentity,
} from "../../../src/lib/relay-crypto";
import { relayIdentityFile } from "../../paths";
import type { SecretBox } from "../../platform/secret-box";
import { readSealed, SealedWriter } from "../../platform/sealed-file";
import { EncryptionUnavailableError } from "../devices";
import { wipe } from "./wipe";

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
  /** The decrypted identity, once `init()` has run. Never leaves this class. */
  private cached: RelayIdentity | null = null;
  private inited = false;
  private readonly writer: SealedWriter;

  constructor(
    private readonly secretBox: SecretBox,
    private readonly filePath: string = relayIdentityFile(),
  ) {
    this.writer = new SealedWriter(secretBox, filePath, "relay identity");
  }

  /**
   * Read the identity from disk, or generate and persist one when there is
   * none. A no-op while the secret box cannot encrypt: `load()` then throws
   * `EncryptionUnavailableError` and the relay stays off.
   *
   * A file that cannot be decrypted or parsed (a restored backup, a new
   * keychain) is unusable either way; it is replaced by a fresh identity,
   * which is a new room — exactly what "Reset relay address" does on purpose.
   */
  async init(): Promise<void> {
    if (this.inited || !this.secretBox.available()) return;
    this.inited = true;
    const existing = await this.read();
    if (existing) this.adopt(existing);
    else this.create();
  }

  /** Resolves once every queued write has reached disk. */
  flush(): Promise<void> {
    return this.writer.flush();
  }

  /** The room this desktop owns. Creates the identity on first use. */
  get roomId(): string {
    return this.describe().roomId;
  }

  /** The Noise static public key, base64url. Creates the identity on first use. */
  get x25519Pub(): string {
    return this.describe().x25519Pub;
  }

  /** Public half only. */
  describe(): RelayIdentityInfo {
    return { ...this.ready().info };
  }

  /**
   * The full identity, private keys included. The caller owns the returned
   * copy and should `wipe` it when done.
   */
  load(): RelayIdentity {
    const { identity } = this.ready();
    return {
      ed25519: {
        pub: identity.ed25519.pub.slice(),
        priv: identity.ed25519.priv.slice(),
      },
      x25519: {
        pub: identity.x25519.pub.slice(),
        priv: identity.x25519.priv.slice(),
      },
    };
  }

  /** Regenerate both keys: a new room, and every relay link dead at once. */
  reset(): RelayIdentityInfo {
    if (!this.secretBox.available()) {
      throw new EncryptionUnavailableError();
    }
    if (this.cached) wipe(this.cached);
    this.create();
    return { ...this.info! };
  }

  private ready(): { identity: RelayIdentity; info: RelayIdentityInfo } {
    if (!this.secretBox.available()) {
      throw new EncryptionUnavailableError();
    }
    if (!this.inited) {
      throw new Error("RelayIdentityStore.init() has not completed");
    }
    if (!this.cached || !this.info) this.create();
    return { identity: this.cached!, info: this.info! };
  }

  private create(): void {
    this.adopt(generateRelayIdentity());
    this.persist(this.cached!);
  }

  private adopt(identity: RelayIdentity): void {
    this.cached = identity;
    this.info = infoOf(identity);
  }

  private async read(): Promise<RelayIdentity | null> {
    let decrypted: string;
    try {
      decrypted = await readSealed(this.secretBox, this.filePath);
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
    this.writer.write(JSON.stringify(stored));
  }
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
