/**
 * Relay identity (ADR-206 D3): an Ed25519 key that proves to the relay the
 * desktop owns its room, and an X25519 key that is the Noise NK static key.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { RelayCryptoError, base64urlEncode, concatBytes, utf8 } from "./bytes";

export interface KeyPair {
  pub: Uint8Array;
  priv: Uint8Array;
}

export interface RelayIdentity {
  /** Room authentication: signs the relay's host challenge. */
  ed25519: KeyPair;
  /** Noise NK responder static key; its public half goes in the QR. */
  x25519: KeyPair;
}

/** Length of a room id in base64url characters (132 bits of SHA-256). */
export const ROOM_ID_LENGTH = 22;

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const HOST_CHALLENGE_CONTEXT = utf8("manor-relay-host-v1");

export function generateRelayIdentity(): RelayIdentity {
  const edPriv = ed25519.utils.randomSecretKey();
  const xPriv = x25519.utils.randomSecretKey();
  return {
    ed25519: { pub: ed25519.getPublicKey(edPriv), priv: edPriv },
    x25519: { pub: x25519.getPublicKey(xPriv), priv: xPriv },
  };
}

/** The room a host key owns: `base64url(sha256(pub)).slice(0, 22)`. */
export function roomIdFor(ed25519Pub: Uint8Array): string {
  if (ed25519Pub.length !== 32)
    throw new RelayCryptoError("Ed25519 public key must be 32 bytes");
  return base64urlEncode(sha256(ed25519Pub)).slice(0, ROOM_ID_LENGTH);
}

function hostChallengeMessage(
  roomId: string,
  challenge: Uint8Array,
): Uint8Array {
  // roomId is fixed-length, so the concatenation is unambiguous.
  if (!ROOM_ID_PATTERN.test(roomId))
    throw new RelayCryptoError("invalid room id");
  return concatBytes(HOST_CHALLENGE_CONTEXT, utf8(roomId), challenge);
}

/** Sign `"manor-relay-host-v1" ‖ roomId ‖ challenge`. */
export function signHostChallenge(
  ed25519Priv: Uint8Array,
  roomId: string,
  challenge: Uint8Array,
): Uint8Array {
  return ed25519.sign(hostChallengeMessage(roomId, challenge), ed25519Priv);
}

/**
 * True only if `pub` hashes to `roomId` and `sig` is its signature over the
 * challenge for that room. Never throws on bad input; returns false.
 */
export function verifyHostChallenge(
  ed25519Pub: Uint8Array,
  roomId: string,
  challenge: Uint8Array,
  sig: Uint8Array,
): boolean {
  try {
    if (roomIdFor(ed25519Pub) !== roomId) return false;
    // Strict RFC 8032 decoding, not the more permissive ZIP-215.
    return ed25519.verify(
      sig,
      hostChallengeMessage(roomId, challenge),
      ed25519Pub,
      {
        zip215: false,
      },
    );
  } catch {
    return false;
  }
}
