import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

import {
  CipherState,
  createInitiator,
  createResponder,
  type X25519KeyPair,
} from "../noise";
import {
  createInitiator as createRelayInitiator,
  createResponder as createRelayResponder,
} from "../index";
import vectorFile from "./vectors/cacophony-nk-25519-chachapoly-sha256.json";

const hex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const keyPair = (privHex: string): X25519KeyPair => {
  const priv = hex(privHex);
  return { priv, pub: x25519.getPublicKey(priv) };
};
const EMPTY = new Uint8Array(0);

function staticKey(): X25519KeyPair {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
}

describe("cacophony vectors: Noise_NK_25519_ChaChaPoly_SHA256", () => {
  expect(vectorFile.vectors.length).toBeGreaterThan(0);

  for (const [index, v] of vectorFile.vectors.entries()) {
    it(`vector ${index} matches byte for byte`, () => {
      expect(v.protocol_name).toBe("Noise_NK_25519_ChaChaPoly_SHA256");
      const respStatic = keyPair(v.resp_static);
      expect(toHex(respStatic.pub)).toBe(v.init_remote_static);

      const initiator = createInitiator(
        hex(v.init_remote_static),
        hex(v.init_prologue),
        keyPair(v.init_ephemeral),
      );
      const responder = createResponder(
        respStatic,
        hex(v.resp_prologue),
        keyPair(v.resp_ephemeral),
      );

      const [m1, m2, ...transport] = v.messages;

      const msg1 = initiator.writeMessage1(hex(m1.payload));
      expect(toHex(msg1)).toBe(m1.ciphertext);
      expect(toHex(responder.readMessage1(msg1))).toBe(m1.payload);

      const resp = responder.writeMessage2(hex(m2.payload));
      expect(toHex(resp.message)).toBe(m2.ciphertext);
      const init = initiator.readMessage2(resp.message);
      expect(toHex(init.payload)).toBe(m2.payload);

      expect(toHex(init.handshakeHash)).toBe(v.handshake_hash);
      expect(toHex(resp.handshakeHash)).toBe(v.handshake_hash);

      // Transport messages alternate, initiator first.
      transport.forEach((m, i) => {
        const [sender, receiver] = i % 2 === 0 ? [init, resp] : [resp, init];
        const ct = sender.send.encryptWithAd(EMPTY, hex(m.payload));
        expect(toHex(ct)).toBe(m.ciphertext);
        expect(toHex(receiver.recv.decryptWithAd(EMPTY, ct))).toBe(m.payload);
      });
    });
  }
});

describe("NK handshake", () => {
  it("round-trips initiator <-> responder through the public surface", () => {
    const s = staticKey();
    const initiator = createRelayInitiator(s.pub);
    const responder = createRelayResponder(s);
    expect(responder.readMessage1(initiator.writeMessage1())).toEqual(EMPTY);
    const resp = responder.writeMessage2();
    const init = initiator.readMessage2(resp.message);
    expect(init.handshakeHash).toEqual(resp.handshakeHash);

    const hello = new TextEncoder().encode('{"type":"hello"}');
    expect(
      resp.recv.decryptWithAd(EMPTY, init.send.encryptWithAd(EMPTY, hello)),
    ).toEqual(hello);
    expect(
      init.recv.decryptWithAd(EMPTY, resp.send.encryptWithAd(EMPTY, hello)),
    ).toEqual(hello);
  });

  it("uses fresh ephemerals: two handshakes to the same key differ", () => {
    const s = staticKey();
    const a = createRelayInitiator(s.pub).writeMessage1();
    const b = createRelayInitiator(s.pub).writeMessage1();
    expect(a).not.toEqual(b);
  });

  it("fails when the relay substitutes its own responder key", () => {
    const real = staticKey();
    const relay = staticKey();
    const initiator = createRelayInitiator(real.pub);
    const msg1 = initiator.writeMessage1();
    // The relay cannot read message 1 encrypted to the real key...
    expect(() => createRelayResponder(relay).readMessage1(msg1)).toThrow();
    // ...and a message 2 from a responder with a different static key fails.
    const impostor = createRelayResponder(relay);
    const relayInitiator = createRelayInitiator(relay.pub);
    impostor.readMessage1(relayInitiator.writeMessage1());
    expect(() =>
      initiator.readMessage2(impostor.writeMessage2().message),
    ).toThrow(/decryption failed/);
  });

  it("fails when the prologue differs", () => {
    const s = staticKey();
    const initiator = createInitiator(
      s.pub,
      new TextEncoder().encode("other-protocol"),
    );
    expect(() =>
      createRelayResponder(s).readMessage1(initiator.writeMessage1()),
    ).toThrow();
  });

  it("rejects tampered handshake messages", () => {
    const s = staticKey();
    const initiator = createRelayInitiator(s.pub);
    const msg1 = initiator.writeMessage1();
    msg1[msg1.length - 1] ^= 1;
    expect(() => createRelayResponder(s).readMessage1(msg1)).toThrow();
  });

  it("rejects low-order ephemeral keys", () => {
    const s = staticKey();
    const msg1 = new Uint8Array(48); // all-zero point
    expect(() => createRelayResponder(s).readMessage1(msg1)).toThrow(
      /invalid X25519/,
    );
  });

  it("rejects out-of-order and repeated calls", () => {
    const s = staticKey();
    const initiator = createRelayInitiator(s.pub);
    expect(() => initiator.readMessage2(new Uint8Array(48))).toThrow(
      /out of order/,
    );
    initiator.writeMessage1();
    expect(() => initiator.writeMessage1()).toThrow(/out of order/);
    const responder = createRelayResponder(s);
    expect(() => responder.writeMessage2()).toThrow(/out of order/);
  });

  it("rejects short messages and wrong-size keys", () => {
    const s = staticKey();
    expect(() =>
      createRelayResponder(s).readMessage1(new Uint8Array(47)),
    ).toThrow(/too short/);
    expect(() => createRelayInitiator(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe("CipherState", () => {
  const key = new Uint8Array(32).fill(7);

  it("refuses to encrypt or decrypt at nonce 2^64-1", () => {
    const max = (1n << 64n) - 1n;
    const almost = new CipherState(key, max - 1n);
    almost.encryptWithAd(EMPTY, EMPTY);
    expect(() => almost.encryptWithAd(EMPTY, EMPTY)).toThrow(/nonce exhausted/);
    expect(() =>
      new CipherState(key, max).decryptWithAd(EMPTY, new Uint8Array(16)),
    ).toThrow(/nonce exhausted/);
  });

  it("encodes the nonce as 64-bit little-endian", () => {
    const pt = new Uint8Array([1, 2, 3]);
    const high = new CipherState(key, 1n << 40n).encryptWithAd(EMPTY, pt);
    expect(new CipherState(key, 1n << 40n).decryptWithAd(EMPTY, high)).toEqual(
      pt,
    );
    expect(() =>
      new CipherState(key, 1n << 8n).decryptWithAd(EMPTY, high),
    ).toThrow();
  });

  it("does not advance the counter on a failed decrypt", () => {
    const sender = new CipherState(key);
    const receiver = new CipherState(key);
    const ct = sender.encryptWithAd(EMPTY, new Uint8Array([9]));
    const bad = ct.slice();
    bad[0] ^= 1;
    expect(() => receiver.decryptWithAd(EMPTY, bad)).toThrow(
      /decryption failed/,
    );
    expect(receiver.decryptWithAd(EMPTY, ct)).toEqual(new Uint8Array([9]));
  });
});
