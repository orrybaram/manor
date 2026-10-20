/**
 * The desktop's relay identity: an Ed25519 key that proves to
 * the relay this machine owns its room, and the X25519 key that is the Noise
 * NK static key a paired browser authenticates the desktop by.
 *
 * Stored the way `RemoteDeviceStore` stores tokens: a `SealedStore` over the
 * `SecretBox`, mode 0600 — when the box cannot store, this throws
 * `EncryptionUnavailableError` and the relay stays off.
 *
 * The secret box is async, so `init()` decrypts the file once into memory and
 * the rest of the API stays synchronous. `load()` hands the caller (the
 * connector, while it is running) a copy of the private keys, which it drops —
 * and zeroes — when it stops. The store's own copy is never handed out.
 */

import {
  base64urlDecode,
  base64urlEncode,
  generateRelayIdentity,
  roomIdFor,
  type RelayIdentity,
} from "../../../src/lib/relay-crypto";
import { lazy, type Lazy } from "../../lib/lazy";
import { relayIdentityFile } from "../../paths";
import type { SecretBox } from "../../platform/secret-box";
import {
  EncryptionUnavailableError,
  SealedStore,
  type SealedCodec,
} from "../../platform/sealed-store";
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

const IDENTITY_CODEC: SealedCodec<RelayIdentity> = {
  parse(text) {
    const parsed = JSON.parse(text) as Partial<StoredIdentity>;
    if (parsed.v !== 1 || !parsed.ed25519 || !parsed.x25519) return null;
    return {
      ed25519: { pub: key(parsed.ed25519.pub), priv: key(parsed.ed25519.priv) },
      x25519: { pub: key(parsed.x25519.pub), priv: key(parsed.x25519.priv) },
    };
  },
  serialize(identity) {
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
    return JSON.stringify(stored);
  },
};

export class RelayIdentityStore {
  /** The decrypted identity and its public half. Never leaves this class. */
  private current: { identity: RelayIdentity; info: RelayIdentityInfo } | null =
    null;
  private readonly store: SealedStore<RelayIdentity>;
  /** Reads the file at most once; a read that threw is retried next time. */
  private readonly loadOnce: Lazy<void>;
  /** Has a read finished? Until then nothing may create an identity over it. */
  private loaded = false;

  constructor(
    private readonly secretBox: SecretBox,
    filePath: string = relayIdentityFile(),
  ) {
    this.store = new SealedStore(
      secretBox,
      filePath,
      "relay identity",
      IDENTITY_CODEC,
    );
    this.loadOnce = lazy(async () => {
      const existing = await this.store.init();
      this.loaded = true;
      if (existing) this.adopt(existing);
      else if (this.secretBox.available()) this.create();
    });
  }

  /**
   * Read the identity from disk, or generate and persist one when there is
   * none. Safe to call again; later calls share the first read. While the
   * secret box cannot store, nothing is generated: `load()` then throws
   * `EncryptionUnavailableError` and the relay stays off.
   *
   * A file that cannot be decrypted or parsed (a restored backup, a new
   * keychain) is unusable either way; it is replaced by a fresh identity,
   * which is a new room — exactly what "Reset relay address" does on purpose.
   * A box that could not run at all rejects (`SecretBoxUnavailableError`) and
   * the file is left alone.
   */
  async init(): Promise<void> {
    await this.loadOnce();
  }

  /** Resolves once every queued write has reached disk; rejects if one failed. */
  flush(): Promise<void> {
    return this.store.flush();
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

  /**
   * Regenerate both keys: a new room, and every relay link dead at once.
   * Resolves once the new identity is on disk.
   */
  async reset(): Promise<RelayIdentityInfo> {
    if (!this.secretBox.available()) {
      throw new EncryptionUnavailableError();
    }
    const previous = this.current;
    const { info } = this.create();
    if (previous) wipe(previous.identity);
    await this.store.flush();
    return { ...info };
  }

  private ready(): { identity: RelayIdentity; info: RelayIdentityInfo } {
    if (!this.secretBox.available()) {
      throw new EncryptionUnavailableError();
    }
    if (!this.loaded) {
      throw new Error("RelayIdentityStore.init() has not completed");
    }
    return this.current ?? this.create();
  }

  private create(): { identity: RelayIdentity; info: RelayIdentityInfo } {
    const identity = generateRelayIdentity();
    this.store.write(identity);
    return this.adopt(identity);
  }

  private adopt(identity: RelayIdentity): {
    identity: RelayIdentity;
    info: RelayIdentityInfo;
  } {
    this.current = { identity, info: infoOf(identity) };
    return this.current;
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
