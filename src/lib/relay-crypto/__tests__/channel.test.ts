import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

import {
  FRAME_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  MAX_HOST_FRAME_BYTES,
  NOISE_MAX_PLAINTEXT,
  SecureChannel,
  createInitiator,
  createResponder,
} from "../index";

function pair(): { phone: SecureChannel; desktop: SecureChannel } {
  const priv = x25519.utils.randomSecretKey();
  const s = { priv, pub: x25519.getPublicKey(priv) };
  const initiator = createInitiator(s.pub);
  const responder = createResponder(s);
  responder.readMessage1(initiator.writeMessage1());
  const resp = responder.writeMessage2();
  const init = initiator.readMessage2(resp.message);
  return {
    phone: new SecureChannel(init, "viewer"),
    desktop: new SecureChannel(resp, "host"),
  };
}

const bytes = (n: number, fill = 0x61): Uint8Array =>
  new Uint8Array(n).fill(fill);

function deliver(
  from: SecureChannel,
  to: SecureChannel,
  text: string,
): string | null {
  let result: string | null = null;
  const chunks = from.sealFrame(text);
  chunks.forEach((c, i) => {
    result = to.openFrame(c);
    if (i < chunks.length - 1) expect(result).toBeNull();
  });
  return result;
}

describe("SecureChannel seal/open", () => {
  it("round-trips both directions", () => {
    const { phone, desktop } = pair();
    const msg = new TextEncoder().encode('{"type":"hello","token":"t"}');
    expect(desktop.open(phone.seal(msg))).toEqual(msg);
    expect(phone.open(desktop.seal(msg))).toEqual(msg);
    expect(desktop.open(phone.seal(new Uint8Array(0)))).toEqual(
      new Uint8Array(0),
    );
  });

  it("does not deliver a message back to its sender", () => {
    const { phone } = pair();
    expect(() => phone.open(phone.seal(bytes(4)))).toThrow();
  });

  it("fails on a tampered byte and stays failed", () => {
    const { phone, desktop } = pair();
    const good = phone.seal(bytes(10));
    for (const i of [0, 5, good.length - 1]) {
      const fresh = pair();
      const ct = fresh.phone.seal(bytes(10));
      ct[i] ^= 0x80;
      expect(() => fresh.desktop.open(ct)).toThrow(/decryption failed/);
      expect(fresh.desktop.failed).toBe(true);
    }
    const bad = good.slice();
    bad[3] ^= 1;
    expect(() => desktop.open(bad)).toThrow();
    // Even the genuine message is refused afterwards: never retry.
    expect(() => desktop.open(good)).toThrow(/channel has failed/);
    expect(() => desktop.seal(bytes(1))).toThrow(/channel has failed/);
  });

  it("fails on reordered messages (nonce mismatch)", () => {
    const { phone, desktop } = pair();
    const first = phone.seal(bytes(3, 1));
    const second = phone.seal(bytes(3, 2));
    expect(() => desktop.open(second)).toThrow(/decryption failed/);
    expect(() => desktop.open(first)).toThrow();
  });

  it("fails on a replayed message", () => {
    const { phone, desktop } = pair();
    const ct = phone.seal(bytes(3));
    desktop.open(ct);
    expect(() => desktop.open(ct)).toThrow(/decryption failed/);
  });

  it("fails on a dropped message", () => {
    const { phone, desktop } = pair();
    phone.seal(bytes(3));
    expect(() => desktop.open(phone.seal(bytes(3)))).toThrow(
      /decryption failed/,
    );
  });

  it("accepts exactly 65 535 - 16 plaintext bytes and refuses one more", () => {
    const { phone, desktop } = pair();
    expect(NOISE_MAX_PLAINTEXT).toBe(65535 - 16);
    const ct = phone.seal(bytes(NOISE_MAX_PLAINTEXT));
    expect(ct.length).toBe(65535);
    expect(desktop.open(ct)).toEqual(bytes(NOISE_MAX_PLAINTEXT));
    expect(() => phone.seal(bytes(NOISE_MAX_PLAINTEXT + 1))).toThrow(/exceeds/);
    expect(() => desktop.open(new Uint8Array(65536))).toThrow(/exceeds/);
  });
});

describe("SecureChannel frames", () => {
  it("round-trips an empty frame and multi-byte UTF-8", () => {
    const { phone, desktop } = pair();
    expect(deliver(phone, desktop, "")).toBe("");
    const text = "héllo 🏠 ".repeat(20_000); // spans chunks, may split code points
    expect(deliver(desktop, phone, text)).toBe(text);
  });

  it("sends a frame of exactly one chunk as one message", () => {
    const { phone, desktop } = pair();
    const text = "a".repeat(FRAME_CHUNK_BYTES);
    const chunks = phone.sealFrame(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(65535);
    expect(desktop.openFrame(chunks[0])).toBe(text);
  });

  it("splits one byte over the chunk size into two messages", () => {
    const { phone, desktop } = pair();
    const text = "a".repeat(FRAME_CHUNK_BYTES + 1);
    const chunks = phone.sealFrame(text);
    expect(chunks).toHaveLength(2);
    expect(desktop.openFrame(chunks[0])).toBeNull();
    expect(desktop.openFrame(chunks[1])).toBe(text);
  });

  it("carries a 1 MiB frame", () => {
    const { phone, desktop } = pair();
    const text = "z".repeat(MAX_FRAME_BYTES);
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
    expect(deliver(phone, desktop, text)).toBe(text);
    // and the channel continues afterwards
    expect(deliver(phone, desktop, "next")).toBe("next");
  });

  it("refuses to seal 1 MiB + 1 from the viewer", () => {
    const { phone } = pair();
    expect(() => phone.sealFrame("z".repeat(MAX_FRAME_BYTES + 1))).toThrow(
      /frame too large/,
    );
  });

  it("carries a desktop frame larger than 1 MiB to the viewer", () => {
    const { phone, desktop } = pair();
    const text = "s".repeat(3 * 1024 * 1024 + 17);
    expect(deliver(desktop, phone, text)).toBe(text);
    expect(deliver(desktop, phone, "after")).toBe("after");
  });

  it("caps desktop frames at MAX_HOST_FRAME_BYTES", () => {
    const { desktop } = pair();
    expect(MAX_HOST_FRAME_BYTES).toBe(32 * 1024 * 1024);
    expect(() =>
      desktop.sealFrame("z".repeat(MAX_HOST_FRAME_BYTES + 1)),
    ).toThrow(/frame too large/);
  });

  it("refuses non-final chunks shorter than a full chunk", () => {
    for (const data of [
      new Uint8Array(0),
      bytes(1),
      bytes(FRAME_CHUNK_BYTES - 1),
    ]) {
      const { phone, desktop } = pair();
      const chunk = new Uint8Array(1 + data.length);
      chunk[0] = 1;
      chunk.set(data, 1);
      expect(() => desktop.openFrame(phone.seal(chunk))).toThrow(
        /short non-final/,
      );
      expect(desktop.failed).toBe(true);
    }
  });

  it("refuses to reassemble past 1 MiB from a hostile sender", () => {
    const { phone, desktop } = pair();
    const full = Math.floor(MAX_FRAME_BYTES / FRAME_CHUNK_BYTES);
    let sent = 0;
    for (let i = 0; i < full; i++) {
      const chunk = new Uint8Array(1 + FRAME_CHUNK_BYTES).fill(0x61);
      chunk[0] = 1;
      expect(desktop.openFrame(phone.seal(chunk))).toBeNull();
      sent += FRAME_CHUNK_BYTES;
    }
    // A final chunk that lands on exactly 1 MiB + 1.
    const last = new Uint8Array(1 + MAX_FRAME_BYTES - sent + 1).fill(0x61);
    last[0] = 0;
    expect(() => desktop.openFrame(phone.seal(last))).toThrow(
      /frame too large/,
    );
    expect(desktop.failed).toBe(true);
  });

  it("rejects an unknown flag, an empty chunk, and invalid UTF-8", () => {
    for (const plaintext of [
      Uint8Array.of(2, 0x61),
      new Uint8Array(0),
      Uint8Array.of(0, 0xff),
    ]) {
      const { phone, desktop } = pair();
      expect(() => desktop.openFrame(phone.seal(plaintext))).toThrow();
      expect(desktop.failed).toBe(true);
    }
  });
});
