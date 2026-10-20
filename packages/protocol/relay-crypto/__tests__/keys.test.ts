import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

import {
  ROOM_ID_LENGTH,
  base64urlDecode,
  base64urlEncode,
  generateRelayIdentity,
  roomIdFor,
  signHostChallenge,
  verifyHostChallenge,
} from "../index";

const challenge = Uint8Array.from({ length: 32 }, (_, i) => i);

describe("relay identity", () => {
  it("generates distinct 32-byte Ed25519 and X25519 key pairs", () => {
    const a = generateRelayIdentity();
    const b = generateRelayIdentity();
    for (const k of [
      a.ed25519.pub,
      a.ed25519.priv,
      a.x25519.pub,
      a.x25519.priv,
    ]) {
      expect(k).toHaveLength(32);
    }
    expect(a.ed25519.pub).not.toEqual(b.ed25519.pub);
    expect(a.x25519.pub).not.toEqual(b.x25519.pub);
  });

  it("derives the room id as base64url(sha256(pub)) truncated to 22 chars", () => {
    const { ed25519 } = generateRelayIdentity();
    const room = roomIdFor(ed25519.pub);
    expect(room).toHaveLength(ROOM_ID_LENGTH);
    expect(room).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(room).toBe(base64urlEncode(sha256(ed25519.pub)).slice(0, 22));
  });
});

describe("host challenge", () => {
  it("verifies a valid signature", () => {
    const { ed25519 } = generateRelayIdentity();
    const room = roomIdFor(ed25519.pub);
    const sig = signHostChallenge(ed25519.priv, room, challenge);
    expect(verifyHostChallenge(ed25519.pub, room, challenge, sig)).toBe(true);
  });

  it("fails for a wrong room id", () => {
    const { ed25519 } = generateRelayIdentity();
    const room = roomIdFor(ed25519.pub);
    const other = roomIdFor(generateRelayIdentity().ed25519.pub);
    const sig = signHostChallenge(ed25519.priv, room, challenge);
    expect(verifyHostChallenge(ed25519.pub, other, challenge, sig)).toBe(false);
    expect(verifyHostChallenge(ed25519.pub, "not-a-room", challenge, sig)).toBe(
      false,
    );
  });

  it("fails for a wrong key", () => {
    const owner = generateRelayIdentity().ed25519;
    const attacker = generateRelayIdentity().ed25519;
    const room = roomIdFor(owner.pub);
    // Attacker signs for the owner's room with their own key.
    const sig = signHostChallenge(attacker.priv, room, challenge);
    expect(verifyHostChallenge(owner.pub, room, challenge, sig)).toBe(false);
  });

  it("fails for a key that does not hash to the room, even with a valid signature", () => {
    const owner = generateRelayIdentity().ed25519;
    const attacker = generateRelayIdentity().ed25519;
    const room = roomIdFor(owner.pub);
    const sig = signHostChallenge(attacker.priv, room, challenge);
    expect(verifyHostChallenge(attacker.pub, room, challenge, sig)).toBe(false);
  });

  it("fails for a different challenge or a tampered signature", () => {
    const { ed25519 } = generateRelayIdentity();
    const room = roomIdFor(ed25519.pub);
    const sig = signHostChallenge(ed25519.priv, room, challenge);
    expect(
      verifyHostChallenge(
        ed25519.pub,
        room,
        challenge.map((b) => b ^ 1),
        sig,
      ),
    ).toBe(false);
    const bad = sig.slice();
    bad[0] ^= 1;
    expect(verifyHostChallenge(ed25519.pub, room, challenge, bad)).toBe(false);
    expect(
      verifyHostChallenge(ed25519.pub, room, challenge, new Uint8Array(3)),
    ).toBe(false);
  });
});

describe("base64url", () => {
  it("round-trips every length 0..64", () => {
    for (let n = 0; n <= 64; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(base64urlDecode(base64urlEncode(b))).toEqual(b);
    }
  });

  it("matches RFC 4648 test vectors (unpadded, url alphabet)", () => {
    const enc = (s: string) => base64urlEncode(new TextEncoder().encode(s));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("Zg");
    expect(enc("fo")).toBe("Zm8");
    expect(enc("foo")).toBe("Zm9v");
    expect(enc("foob")).toBe("Zm9vYg");
    expect(enc("fooba")).toBe("Zm9vYmE");
    expect(enc("foobar")).toBe("Zm9vYmFy");
    expect(base64urlEncode(Uint8Array.of(0xfb, 0xff))).toBe("-_8");
  });

  it("rejects padding, bad characters, impossible lengths and non-canonical input", () => {
    expect(() => base64urlDecode("Zg==")).toThrow();
    expect(() => base64urlDecode("Zm9+")).toThrow();
    expect(() => base64urlDecode("Z")).toThrow();
    expect(() => base64urlDecode("Zh")).toThrow(/non-canonical/);
  });
});
