import { describe, expect, it } from "vitest";

import {
  RelayCryptoError,
  canonicalJson,
  generateRelayIdentity,
  signJevRequest,
  verifyJevRequest,
} from "../index";

const ts = 1_760_000_000_000;
const payload = {
  state: { a: 1, b: [1, { y: 2, x: 3 }], c: null },
  options: { model: "m", flag: true },
};

describe("jev request signing", () => {
  const { ed25519: key } = generateRelayIdentity();
  const sig = signJevRequest(key.priv, ts, payload);

  it("round-trips", () => {
    expect(verifyJevRequest(key.pub, ts, payload, sig)).toBe(true);
  });

  it("is key-order independent", () => {
    const reordered = {
      options: { flag: true, model: "m" },
      state: { c: null, b: [1, { x: 3, y: 2 }], a: 1 },
    };
    expect(verifyJevRequest(key.pub, ts, reordered, sig)).toBe(true);
  });

  it("fails after tampering or with the wrong key", () => {
    expect(verifyJevRequest(key.pub, ts + 1, payload, sig)).toBe(false);
    expect(
      verifyJevRequest(key.pub, ts, { ...payload, state: { a: 2 } }, sig),
    ).toBe(false);
    expect(
      verifyJevRequest(key.pub, ts, { ...payload, options: {} }, sig),
    ).toBe(false);
    const other = generateRelayIdentity().ed25519;
    expect(verifyJevRequest(other.pub, ts, payload, sig)).toBe(false);
  });

  it("returns false on garbage input", () => {
    expect(verifyJevRequest(new Uint8Array(3), ts, payload, sig)).toBe(false);
    expect(verifyJevRequest(key.pub, ts, payload, new Uint8Array(5))).toBe(
      false,
    );
    expect(verifyJevRequest(key.pub, -1, payload, sig)).toBe(false);
    expect(verifyJevRequest(key.pub, 1.5, payload, sig)).toBe(false);
    expect(
      verifyJevRequest(key.pub, ts, { state: undefined, options: 1 }, sig),
    ).toBe(false);
  });

  it("rejects bad timestamps and unsupported values when signing", () => {
    expect(() => signJevRequest(key.priv, -1, payload)).toThrow(
      RelayCryptoError,
    );
    expect(() => canonicalJson({ d: new Date() })).toThrow(RelayCryptoError);
    expect(() => canonicalJson(NaN)).toThrow(RelayCryptoError);
  });

  it("canonicalJson sorts keys and strips whitespace", () => {
    expect(canonicalJson({ b: [1, "x"], a: { d: null, c: true } })).toBe(
      '{"a":{"c":true,"d":null},"b":[1,"x"]}',
    );
  });
});
