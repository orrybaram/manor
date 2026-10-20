import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

import {
  MAX_BATCH_BYTES,
  MAX_FRAME_BYTES,
  RelayCryptoError,
  SecureChannel,
  createInitiator,
  createResponder,
  packBatch,
  packBatches,
  unpackBatch,
} from "../index";

const bytes = (n: number, fill = 0x61): Uint8Array =>
  new Uint8Array(n).fill(fill);

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

describe("packBatch / unpackBatch", () => {
  it("round-trips chunks in order", () => {
    const chunks = [bytes(1, 1), bytes(300, 2), bytes(65535, 3)];
    const packed = packBatch(chunks);
    expect(packed.length).toBe(4 * 3 + 1 + 300 + 65535);
    const out = unpackBatch(packed);
    expect(out.map((c) => Array.from(c.subarray(0, 2)))).toEqual([
      [1],
      [2, 2],
      [3, 3],
    ]);
    expect(out.map((c) => c.length)).toEqual([1, 300, 65535]);
  });

  it("writes big-endian u32 lengths", () => {
    const packed = packBatch([bytes(0x0102, 9)]);
    expect(Array.from(packed.subarray(0, 4))).toEqual([0, 0, 1, 2]);
  });

  it("reads a batch that is a view into a larger buffer", () => {
    const packed = packBatch([bytes(5, 7)]);
    const host = new Uint8Array(packed.length + 10);
    host.set(packed, 3);
    const view = host.subarray(3, 3 + packed.length);
    expect(unpackBatch(view)).toEqual([bytes(5, 7)]);
  });

  it("refuses to pack nothing, an empty chunk or an oversized chunk", () => {
    expect(() => packBatch([])).toThrow(RelayCryptoError);
    expect(() => packBatch([bytes(0)])).toThrow(RelayCryptoError);
    expect(() => packBatch([bytes(65536)])).toThrow(RelayCryptoError);
  });

  it("refuses to pack past MAX_BATCH_BYTES", () => {
    const many = Array.from({ length: 18 }, () => bytes(65535));
    expect(() => packBatch(many)).toThrow(/too large/);
  });

  it("rejects an empty message", () => {
    expect(() => unpackBatch(new Uint8Array(0))).toThrow(RelayCryptoError);
  });

  it("rejects a truncated length prefix", () => {
    const packed = packBatch([bytes(3)]);
    const withTail = new Uint8Array([...packed, 0, 0]);
    expect(() => unpackBatch(withTail)).toThrow(/truncated batch length/);
    expect(() => unpackBatch(Uint8Array.of(0, 0, 1))).toThrow(
      /truncated batch length/,
    );
  });

  it("rejects a chunk that runs past the end", () => {
    const packed = packBatch([bytes(10)]);
    expect(() => unpackBatch(packed.subarray(0, packed.length - 1))).toThrow(
      /truncated batch chunk/,
    );
  });

  it("rejects trailing bytes that are not a whole chunk", () => {
    const packed = packBatch([bytes(10)]);
    const trailing = new Uint8Array([...packed, ...u32(5), 1, 2]);
    expect(() => unpackBatch(trailing)).toThrow(/truncated batch chunk/);
  });

  it("rejects a zero-length or over-long chunk header", () => {
    expect(() => unpackBatch(u32(0))).toThrow(/empty batch chunk/);
    const long = new Uint8Array([...u32(65536), ...bytes(65536)]);
    expect(() => unpackBatch(long)).toThrow(/exceeds one Noise message/);
  });

  it("rejects a message over MAX_BATCH_BYTES before parsing it", () => {
    expect(() => unpackBatch(new Uint8Array(MAX_BATCH_BYTES + 1))).toThrow(
      /too large/,
    );
  });

  it("carries a whole MAX_FRAME_BYTES frame's sealed chunks", () => {
    const priv = x25519.utils.randomSecretKey();
    const s = { priv, pub: x25519.getPublicKey(priv) };
    const initiator = createInitiator(s.pub);
    const responder = createResponder(s);
    responder.readMessage1(initiator.writeMessage1());
    const resp = responder.writeMessage2();
    const phone = new SecureChannel(
      initiator.readMessage2(resp.message),
      "viewer",
    );
    const desktop = new SecureChannel(resp, "host");

    const text = "x".repeat(MAX_FRAME_BYTES);
    const batch = packBatch(desktop.sealFrame(text));
    let got: string | null = null;
    for (const chunk of unpackBatch(batch)) got = phone.openFrame(chunk);
    expect(got).toBe(text);
  });

  describe("packBatches", () => {
    it("keeps everything in one batch when it fits", () => {
      const out = packBatches([bytes(10), bytes(20)]);
      expect(out).toHaveLength(1);
      expect(unpackBatch(out[0]).map((c) => c.length)).toEqual([10, 20]);
    });

    it("splits at the limit, in order, without splitting a chunk", () => {
      const chunks = Array.from({ length: 5 }, (_, i) => bytes(65535, i));
      const limit = 2 * (4 + 65535);
      const out = packBatches(chunks, limit);
      expect(out.map((b) => b.length)).toEqual([limit, limit, 4 + 65535]);
      const flat = out.flatMap((b) => unpackBatch(b));
      expect(flat.map((c) => c[0])).toEqual([0, 1, 2, 3, 4]);
    });

    it("refuses a limit below one Noise message, and nothing at all", () => {
      expect(() => packBatches([bytes(1)], 100)).toThrow(RelayCryptoError);
      expect(() => packBatches([])).toThrow(RelayCryptoError);
    });
  });
});
