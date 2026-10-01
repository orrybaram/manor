/**
 * Noise_NK_25519_ChaChaPoly_SHA256 (Noise Protocol Framework, revision 34).
 *
 * NK: the initiator (phone) is anonymous and knows the responder's (desktop's)
 * static X25519 key in advance, from the pairing QR (ADR-206 D2/D3).
 *
 *   <- s
 *   ...
 *   -> e, es
 *   <- e, ee
 *
 * Pure TypeScript over @noble/* — no Node or DOM imports, so the desktop and
 * the web bundle share this file. Nothing outside `relay-crypto/` touches keys
 * or nonces.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { RelayCryptoError, concatBytes, utf8 } from "./bytes";

const PROTOCOL_NAME = "Noise_NK_25519_ChaChaPoly_SHA256";
const HASHLEN = 32;
const DHLEN = 32;
const TAGLEN = 16;

/** Largest Noise message, handshake or transport (spec §3). */
export const NOISE_MAX_MESSAGE = 65535;
/** Largest plaintext one transport message can carry. */
export const NOISE_MAX_PLAINTEXT = NOISE_MAX_MESSAGE - TAGLEN;

/** Prologue binding every handshake to this protocol and version. */
export const RELAY_PROLOGUE = utf8("manor-relay-v1");

/** 2^64 - 1 is reserved by the spec; encrypting with it is an error. */
const MAX_NONCE = (1n << 64n) - 1n;

const EMPTY = new Uint8Array(0);

export interface X25519KeyPair {
  pub: Uint8Array;
  priv: Uint8Array;
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, key, data);
}

/** Noise HKDF with two outputs (spec §4.3). */
function hkdf2(
  chainingKey: Uint8Array,
  ikm: Uint8Array,
): [Uint8Array, Uint8Array] {
  const tempKey = hmacSha256(chainingKey, ikm);
  const out1 = hmacSha256(tempKey, Uint8Array.of(0x01));
  const out2 = hmacSha256(tempKey, concatBytes(out1, Uint8Array.of(0x02)));
  return [out1, out2];
}

function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  try {
    // noble rejects low-order points (an all-zero shared secret).
    return x25519.getSharedSecret(priv, pub);
  } catch {
    throw new RelayCryptoError("invalid X25519 public key");
  }
}

function generateKeyPair(): X25519KeyPair {
  const priv = x25519.utils.randomSecretKey();
  return { pub: x25519.getPublicKey(priv), priv };
}

/** ChaChaPoly nonce: 32 bits of zeros, then the counter little-endian. */
function nonceBytes(n: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  let v = n;
  for (let i = 4; i < 12; i++) {
    nonce[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return nonce;
}

/**
 * One direction of a Noise session: a key and a 64-bit message counter.
 * Rekey is not implemented; the counter refuses to reach 2^64 - 1.
 */
export class CipherState {
  #key: Uint8Array | null;
  #n: bigint;

  /** `initialNonce` exists for tests of counter exhaustion only. */
  constructor(key: Uint8Array | null, initialNonce = 0n) {
    if (key !== null && key.length !== 32) {
      throw new RelayCryptoError("cipher key must be 32 bytes");
    }
    this.#key = key;
    this.#n = initialNonce;
  }

  hasKey(): boolean {
    return this.#key !== null;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.#key === null) return plaintext.slice();
    if (this.#n >= MAX_NONCE) throw new RelayCryptoError("nonce exhausted");
    const ciphertext = chacha20poly1305(
      this.#key,
      nonceBytes(this.#n),
      ad,
    ).encrypt(plaintext);
    this.#n += 1n;
    return ciphertext;
  }

  /** Throws on authentication failure; the counter only advances on success. */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.#key === null) return ciphertext.slice();
    if (this.#n >= MAX_NONCE) throw new RelayCryptoError("nonce exhausted");
    if (ciphertext.length < TAGLEN)
      throw new RelayCryptoError("ciphertext too short");
    let plaintext: Uint8Array;
    try {
      plaintext = chacha20poly1305(this.#key, nonceBytes(this.#n), ad).decrypt(
        ciphertext,
      );
    } catch {
      throw new RelayCryptoError("decryption failed");
    }
    this.#n += 1n;
    return plaintext;
  }
}

/** Handshake-time hashing and key derivation (spec §5.2). */
export class SymmetricState {
  #ck: Uint8Array;
  #h: Uint8Array;
  #cipher = new CipherState(null);

  constructor(protocolName: string) {
    const name = utf8(protocolName);
    let h: Uint8Array;
    if (name.length <= HASHLEN) {
      h = new Uint8Array(HASHLEN);
      h.set(name);
    } else {
      h = sha256(name);
    }
    this.#h = h;
    this.#ck = h.slice();
  }

  get handshakeHash(): Uint8Array {
    return this.#h.slice();
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = hkdf2(this.#ck, ikm);
    this.#ck = ck;
    this.#cipher = new CipherState(tempK);
  }

  mixHash(data: Uint8Array): void {
    this.#h = sha256(concatBytes(this.#h, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.#cipher.encryptWithAd(this.#h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.#cipher.decryptWithAd(this.#h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  /** `[initiator→responder, responder→initiator]` */
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.#ck, EMPTY);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

export interface HandshakeResult {
  send: CipherState;
  recv: CipherState;
  /** `h` at the end of the handshake — usable for channel binding. */
  handshakeHash: Uint8Array;
}

export interface InitiatorResult extends HandshakeResult {
  /** The decrypted payload of message 2 (empty in Manor's use). */
  payload: Uint8Array;
}

export interface ResponderResult extends HandshakeResult {
  /** Message 2, to be sent to the initiator. */
  message: Uint8Array;
}

function checkKey(key: Uint8Array, what: string): void {
  if (key.length !== DHLEN)
    throw new RelayCryptoError(`${what} must be ${DHLEN} bytes`);
}

function checkOutgoing(payload: Uint8Array): void {
  // Both NK messages are e (32) + payload + tag (16).
  if (DHLEN + payload.length + TAGLEN > NOISE_MAX_MESSAGE) {
    throw new RelayCryptoError("handshake payload too large");
  }
}

function checkIncoming(msg: Uint8Array): void {
  if (msg.length > NOISE_MAX_MESSAGE)
    throw new RelayCryptoError("handshake message too large");
  if (msg.length < DHLEN + TAGLEN)
    throw new RelayCryptoError("handshake message too short");
}

function initState(
  responderStaticPub: Uint8Array,
  prologue: Uint8Array,
): SymmetricState {
  const ss = new SymmetricState(PROTOCOL_NAME);
  ss.mixHash(prologue);
  // Pre-message pattern: <- s
  ss.mixHash(responderStaticPub);
  return ss;
}

export interface NoiseInitiator {
  writeMessage1(payload?: Uint8Array): Uint8Array;
  readMessage2(msg: Uint8Array): InitiatorResult;
}

export interface NoiseResponder {
  readMessage1(msg: Uint8Array): Uint8Array;
  writeMessage2(payload?: Uint8Array): ResponderResult;
}

/**
 * The phone's side. `ephemeral` is for deterministic test vectors only and is
 * not reachable through `index.ts`.
 */
export function createInitiator(
  responderStaticPub: Uint8Array,
  prologue: Uint8Array,
  ephemeral?: X25519KeyPair,
): NoiseInitiator {
  checkKey(responderStaticPub, "responder static key");
  const rs = responderStaticPub.slice();
  const ss = initState(rs, prologue);
  let e: X25519KeyPair | null = null;
  let step: "write1" | "read2" | "done" = "write1";

  return {
    writeMessage1(payload = EMPTY) {
      if (step !== "write1")
        throw new RelayCryptoError("writeMessage1 out of order");
      checkOutgoing(payload);
      step = "done"; // a failure part-way through is final
      // -> e
      e = ephemeral
        ? { pub: ephemeral.pub.slice(), priv: ephemeral.priv.slice() }
        : generateKeyPair();
      ss.mixHash(e.pub);
      // es
      ss.mixKey(dh(e.priv, rs));
      const msg = concatBytes(e.pub, ss.encryptAndHash(payload));
      step = "read2";
      return msg;
    },
    readMessage2(msg) {
      if (step !== "read2" || e === null)
        throw new RelayCryptoError("readMessage2 out of order");
      step = "done";
      checkIncoming(msg);
      // <- e
      const re = msg.slice(0, DHLEN);
      ss.mixHash(re);
      // ee
      ss.mixKey(dh(e.priv, re));
      e.priv.fill(0);
      const payload = ss.decryptAndHash(msg.slice(DHLEN));
      const [c1, c2] = ss.split();
      return { send: c1, recv: c2, payload, handshakeHash: ss.handshakeHash };
    },
  };
}

/**
 * The desktop's side. `ephemeral` is for deterministic test vectors only and
 * is not reachable through `index.ts`.
 */
export function createResponder(
  staticKeyPair: X25519KeyPair,
  prologue: Uint8Array,
  ephemeral?: X25519KeyPair,
): NoiseResponder {
  checkKey(staticKeyPair.pub, "static public key");
  checkKey(staticKeyPair.priv, "static private key");
  const s = {
    pub: staticKeyPair.pub.slice(),
    priv: staticKeyPair.priv.slice(),
  };
  const ss = initState(s.pub, prologue);
  let re: Uint8Array | null = null;
  let step: "read1" | "write2" | "done" = "read1";

  return {
    readMessage1(msg) {
      if (step !== "read1")
        throw new RelayCryptoError("readMessage1 out of order");
      step = "done";
      checkIncoming(msg);
      // -> e
      re = msg.slice(0, DHLEN);
      ss.mixHash(re);
      // es
      ss.mixKey(dh(s.priv, re));
      const payload = ss.decryptAndHash(msg.slice(DHLEN));
      step = "write2";
      return payload;
    },
    writeMessage2(payload = EMPTY) {
      if (step !== "write2" || re === null)
        throw new RelayCryptoError("writeMessage2 out of order");
      checkOutgoing(payload);
      step = "done";
      // <- e
      const e = ephemeral
        ? { pub: ephemeral.pub.slice(), priv: ephemeral.priv.slice() }
        : generateKeyPair();
      ss.mixHash(e.pub);
      // ee
      ss.mixKey(dh(e.priv, re));
      e.priv.fill(0);
      s.priv.fill(0);
      const msg = concatBytes(e.pub, ss.encryptAndHash(payload));
      const [c1, c2] = ss.split();
      return {
        message: msg,
        send: c2,
        recv: c1,
        handshakeHash: ss.handshakeHash,
      };
    },
  };
}
