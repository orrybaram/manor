/**
 * End-to-end crypto for the relay transport (ADR-206 D2/D3): Noise NK
 * handshake, the transport channel, and the relay identity keys.
 *
 * The only entry point into `relay-crypto/`. Pure TypeScript — imported by
 * both Electron main and the web bundle.
 */
import {
  RELAY_PROLOGUE,
  createInitiator as createNoiseInitiator,
  createResponder as createNoiseResponder,
  type NoiseInitiator,
  type NoiseResponder,
  type X25519KeyPair,
} from "./noise";

export { RelayCryptoError, base64urlDecode, base64urlEncode } from "./bytes";
export {
  FRAME_CHUNK_BYTES,
  MAX_BATCH_BYTES,
  MAX_FRAME_BYTES,
  MAX_HOST_FRAME_BYTES,
  SecureChannel,
  type ChannelRole,
  packBatch,
  packBatches,
  unpackBatch,
} from "./channel";
export {
  ROOM_ID_LENGTH,
  generateRelayIdentity,
  roomIdFor,
  signHostChallenge,
  verifyHostChallenge,
  type KeyPair,
  type RelayIdentity,
} from "./keys";
export {
  NOISE_MAX_PLAINTEXT,
  type CipherState,
  type HandshakeResult,
  type InitiatorResult,
  type NoiseInitiator,
  type NoiseResponder,
  type ResponderResult,
} from "./noise";

/**
 * The phone's side of `Noise_NK_25519_ChaChaPoly_SHA256`, bound to the
 * `"manor-relay-v1"` prologue. `responderStaticPub` comes from the pairing QR.
 */
export function createInitiator(
  responderStaticPub: Uint8Array,
): NoiseInitiator {
  return createNoiseInitiator(responderStaticPub, RELAY_PROLOGUE);
}

/** The desktop's side, using the relay identity's X25519 key pair. */
export function createResponder(staticKeyPair: X25519KeyPair): NoiseResponder {
  return createNoiseResponder(staticKeyPair, RELAY_PROLOGUE);
}
