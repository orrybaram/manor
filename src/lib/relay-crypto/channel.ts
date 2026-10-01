/**
 * A Noise transport session over a finished NK handshake (ADR-206 D2).
 *
 * Every bridge frame becomes one or more Noise transport messages. Any
 * failure — authentication, ordering, limits, malformed chunk — poisons the
 * channel: every later call throws, and the caller must close the socket.
 * Never retry; a retry is what a replaying relay would want.
 */
import { RelayCryptoError, concatBytes, fromUtf8, utf8 } from "./bytes";
import {
  NOISE_MAX_MESSAGE,
  NOISE_MAX_PLAINTEXT,
  type CipherState,
  type HandshakeResult,
} from "./noise";

/**
 * Largest frame a viewer sends (browser → desktop), matching the bridge's
 * inbound `MAX_FRAME_BYTES` cap in `electron/bridge/transports/ws.ts`.
 */
export const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * Largest frame the desktop sends (desktop → browser).
 *
 * The caps are directional because the traffic is: what a browser sends is
 * keystrokes and calls, but what it gets back includes a `pty.create`
 * snapshot of a long coloured scrollback (1–3 MiB of JSON), a full diff
 * (`git diff` runs with a 10 MiB buffer) or an image as a data URL. The
 * listener's `/ws` puts no cap on what it sends at all; this is the relay's
 * bound on how much one frame may make a browser buffer before it parses.
 * The frame still crosses the relay in ≤ 1 MiB messages — its chunks are
 * spread over as many batches as it takes (`packBatches`).
 */
export const MAX_HOST_FRAME_BYTES = 32 * 1024 * 1024;

/** Frame bytes per chunk: one Noise plaintext minus the `more` flag byte. */
export const FRAME_CHUNK_BYTES = NOISE_MAX_PLAINTEXT - 1;

const FLAG_LAST = 0x00;
const FLAG_MORE = 0x01;
const EMPTY = new Uint8Array(0);

/**
 * Which end of the channel this is, and so which cap applies to which
 * direction: the viewer (Noise initiator, the browser) sends at most
 * `MAX_FRAME_BYTES` and accepts up to `MAX_HOST_FRAME_BYTES`; the host
 * (responder, the desktop) the reverse.
 */
export type ChannelRole = "viewer" | "host";

function frameLimits(role: ChannelRole): { send: number; recv: number } {
  return role === "viewer"
    ? { send: MAX_FRAME_BYTES, recv: MAX_HOST_FRAME_BYTES }
    : { send: MAX_HOST_FRAME_BYTES, recv: MAX_FRAME_BYTES };
}

export class SecureChannel {
  #send: CipherState;
  #recv: CipherState;
  #failed = false;
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  readonly #maxSendFrame: number;
  readonly #maxRecvFrame: number;
  /**
   * Most chunks one frame can take. `sealFrame` fills every chunk but the
   * last, so this follows from the byte cap; it is checked on its own so a
   * frame of tiny chunks cannot pile up work before the byte cap trips.
   */
  readonly #maxRecvChunks: number;

  constructor(
    handshake: Pick<HandshakeResult, "send" | "recv">,
    role: ChannelRole,
  ) {
    this.#send = handshake.send;
    this.#recv = handshake.recv;
    const limits = frameLimits(role);
    this.#maxSendFrame = limits.send;
    this.#maxRecvFrame = limits.recv;
    this.#maxRecvChunks = Math.floor(limits.recv / FRAME_CHUNK_BYTES) + 1;
  }

  /** True once any operation has failed; the channel is then unusable. */
  get failed(): boolean {
    return this.#failed;
  }

  /** Encrypt one Noise transport message (at most 65 519 plaintext bytes). */
  seal(plaintext: Uint8Array): Uint8Array {
    this.#checkUsable();
    if (plaintext.length > NOISE_MAX_PLAINTEXT) {
      throw new RelayCryptoError("plaintext exceeds one Noise message");
    }
    return this.#guard(() => this.#send.encryptWithAd(EMPTY, plaintext));
  }

  /** Decrypt one Noise transport message. Throws (and poisons) on failure. */
  open(ciphertext: Uint8Array): Uint8Array {
    this.#checkUsable();
    return this.#guard(() => {
      if (ciphertext.length > NOISE_MAX_MESSAGE) {
        throw new RelayCryptoError("ciphertext exceeds one Noise message");
      }
      return this.#recv.decryptWithAd(EMPTY, ciphertext);
    });
  }

  /**
   * Encrypt one UTF-8 text frame as one or more transport messages, each
   * carrying a 1-byte `more` flag then up to `FRAME_CHUNK_BYTES` of the frame.
   */
  sealFrame(text: string): Uint8Array[] {
    this.#checkUsable();
    const bytes = utf8(text);
    if (bytes.length > this.#maxSendFrame) {
      throw new RelayCryptoError("frame too large");
    }
    const out: Uint8Array[] = [];
    let offset = 0;
    do {
      const end = Math.min(offset + FRAME_CHUNK_BYTES, bytes.length);
      const flag = end < bytes.length ? FLAG_MORE : FLAG_LAST;
      out.push(
        this.seal(
          concatBytes(Uint8Array.of(flag), bytes.subarray(offset, end)),
        ),
      );
      offset = end;
    } while (offset < bytes.length);
    return out;
  }

  /**
   * Decrypt one transport message produced by `sealFrame`. Returns the frame
   * once its last chunk arrives, `null` while more chunks are expected.
   *
   * Exactly the shapes `sealFrame` emits are accepted: a non-final chunk
   * carries exactly `FRAME_CHUNK_BYTES`, so a sender cannot make this hold
   * thousands of empty or 1-byte pieces under the byte cap.
   */
  openFrame(ciphertext: Uint8Array): string | null {
    const chunk = this.open(ciphertext);
    return this.#guard(() => {
      if (chunk.length < 1) throw new RelayCryptoError("empty frame chunk");
      const flag = chunk[0];
      if (flag !== FLAG_MORE && flag !== FLAG_LAST) {
        throw new RelayCryptoError("invalid frame chunk flag");
      }
      const data = chunk.subarray(1);
      if (flag === FLAG_MORE && data.length !== FRAME_CHUNK_BYTES) {
        throw new RelayCryptoError("short non-final frame chunk");
      }
      if (this.#pendingBytes + data.length > this.#maxRecvFrame) {
        throw new RelayCryptoError("frame too large");
      }
      if (this.#pending.length + 1 > this.#maxRecvChunks) {
        throw new RelayCryptoError("frame has too many chunks");
      }
      this.#pending.push(data);
      this.#pendingBytes += data.length;
      if (flag === FLAG_MORE) return null;
      const frame = concatBytes(...this.#pending);
      this.#pending = [];
      this.#pendingBytes = 0;
      return fromUtf8(frame);
    });
  }

  #checkUsable(): void {
    if (this.#failed) throw new RelayCryptoError("channel has failed");
  }

  #guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      this.#failed = true;
      this.#pending = [];
      this.#pendingBytes = 0;
      throw err;
    }
  }
}

/**
 * The batch: how sealed chunks ride in one relay message (ADR-206 D5).
 *
 * The relay bills and rate-limits per message, and PTY output is many small
 * frames, so the desktop coalesces the transport messages it has sealed for
 * a channel (flush on 16 ms or 64 KiB) into one relay message. The wire form
 * is the concatenation of `u32 big-endian length ‖ ciphertext` for each
 * Noise transport message, in order. Nothing else: no count, no version byte
 * — the Noise session already rejects anything reordered, replayed or
 * substituted, so the batch only has to be unambiguous.
 *
 * **Both directions use it.** The browser sends one batch per bridge frame
 * (the `sealFrame` chunks of that one frame), so the host's reader and the
 * browser's reader are the same `unpackBatch`, and there is exactly one
 * shape of transport message on a relay channel. The browser does not
 * coalesce across frames: what it sends is keystrokes and calls, which are
 * few and latency-sensitive.
 *
 * **The handshake is not batched.** Noise messages 1 and 2 travel as bare
 * relay messages; batches start with the first transport message.
 *
 * Strict on read: a truncated length, a length running past the end, an
 * empty chunk, a chunk longer than one Noise message, an empty batch or a
 * batch over `MAX_BATCH_BYTES` all throw `RelayCryptoError`. The caller
 * treats that like a decrypt failure and closes the channel.
 */

/** Bytes of length prefix in front of each chunk. */
const BATCH_LENGTH_BYTES = 4;

/**
 * Largest batch accepted or produced: one whole `MAX_FRAME_BYTES` frame,
 * plus 64 KiB for its chunks' flags, tags and length prefixes (a 1 MiB frame
 * is 17 chunks, ~360 bytes of overhead) and slack for frames coalesced with it.
 * A bigger desktop frame (up to `MAX_HOST_FRAME_BYTES`) is split over several
 * batches by `packBatches`.
 */
export const MAX_BATCH_BYTES = MAX_FRAME_BYTES + 64 * 1024;

/** Concatenate transport messages into one relay message. */
export function packBatch(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) throw new RelayCryptoError("empty batch");
  let total = 0;
  for (const chunk of chunks) {
    if (chunk.length === 0) throw new RelayCryptoError("empty batch chunk");
    if (chunk.length > NOISE_MAX_MESSAGE) {
      throw new RelayCryptoError("batch chunk exceeds one Noise message");
    }
    total += BATCH_LENGTH_BYTES + chunk.length;
  }
  if (total > MAX_BATCH_BYTES) throw new RelayCryptoError("batch too large");
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.length, false);
    out.set(chunk, offset + BATCH_LENGTH_BYTES);
    offset += BATCH_LENGTH_BYTES + chunk.length;
  }
  return out;
}

/**
 * Pack `chunks` into as few batches as fit in `maxBytes` each, in order.
 *
 * For a sender whose carrier caps one message below `MAX_BATCH_BYTES` — the
 * relay takes at most 1 MiB per message, and one maximal frame seals to a
 * little more than that. A frame's chunks may span batches: `openFrame`
 * reassembles across relay messages, so the split costs nothing on read.
 */
export function packBatches(
  chunks: Uint8Array[],
  maxBytes: number = MAX_BATCH_BYTES,
): Uint8Array[] {
  if (maxBytes < BATCH_LENGTH_BYTES + NOISE_MAX_MESSAGE) {
    throw new RelayCryptoError("batch limit below one Noise message");
  }
  const out: Uint8Array[] = [];
  let group: Uint8Array[] = [];
  let size = 0;
  for (const chunk of chunks) {
    const add = BATCH_LENGTH_BYTES + chunk.length;
    if (group.length > 0 && size + add > Math.min(maxBytes, MAX_BATCH_BYTES)) {
      out.push(packBatch(group));
      group = [];
      size = 0;
    }
    group.push(chunk);
    size += add;
  }
  if (group.length > 0) out.push(packBatch(group));
  else throw new RelayCryptoError("empty batch");
  return out;
}

/** Split one relay message back into its transport messages (views). */
export function unpackBatch(msg: Uint8Array): Uint8Array[] {
  if (msg.length === 0) throw new RelayCryptoError("empty batch");
  if (msg.length > MAX_BATCH_BYTES) {
    throw new RelayCryptoError("batch too large");
  }
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const out: Uint8Array[] = [];
  let offset = 0;
  while (offset < msg.length) {
    if (msg.length - offset < BATCH_LENGTH_BYTES) {
      throw new RelayCryptoError("truncated batch length");
    }
    const length = view.getUint32(offset, false);
    offset += BATCH_LENGTH_BYTES;
    if (length === 0) throw new RelayCryptoError("empty batch chunk");
    if (length > NOISE_MAX_MESSAGE) {
      throw new RelayCryptoError("batch chunk exceeds one Noise message");
    }
    if (length > msg.length - offset) {
      throw new RelayCryptoError("truncated batch chunk");
    }
    out.push(msg.subarray(offset, offset + length));
    offset += length;
  }
  return out;
}
