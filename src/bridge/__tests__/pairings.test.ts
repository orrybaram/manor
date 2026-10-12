import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { base64urlEncode } from "../../lib/relay-crypto";
import {
  LEGACY_RELAY_KEY,
  PAIRINGS_KEY,
  lastUsedPairing,
  listPairings,
  removePairing,
  renamePairing,
  selectPairing,
  upsertPairing,
} from "../pairings";

const KEY = base64urlEncode(new Uint8Array(32).fill(9));
const A = "AbCdEfGhIjKlMnOpQr_-01";
const B = "ZyXwVuTsRqPoNmLkJi_-02";

describe("pairings store", () => {
  let map: Map<string, string>;

  beforeEach(() => {
    map = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("adds pairings keyed by room, each with a fallback name", () => {
    upsertPairing({ roomId: A, x25519Pub: KEY, token: "a" }, 10);
    upsertPairing({ roomId: B, x25519Pub: KEY, token: "b" }, 20);
    expect(listPairings()).toEqual([
      { roomId: A, x25519Pub: KEY, token: "a", name: "Host 1", addedAt: 10, lastUsedAt: 10 },
      { roomId: B, x25519Pub: KEY, token: "b", name: "Host 2", addedAt: 20, lastUsedAt: 20 },
    ]);
  });

  it("updates the same room in place, keeping name and addedAt", () => {
    upsertPairing({ roomId: A, x25519Pub: KEY, token: "a" }, 10);
    renamePairing(A, "Studio");
    upsertPairing({ roomId: A, x25519Pub: KEY, token: "a2" }, 30);
    expect(listPairings()).toEqual([
      { roomId: A, x25519Pub: KEY, token: "a2", name: "Studio", addedAt: 10, lastUsedAt: 30 },
    ]);
  });

  it("migrates the legacy single pairing", () => {
    map.set(LEGACY_RELAY_KEY, JSON.stringify({ roomId: A, serverKey: KEY, token: "old" }));
    const [only] = listPairings();
    expect(only).toMatchObject({ roomId: A, x25519Pub: KEY, token: "old", name: "Host 1" });
    expect(map.has(LEGACY_RELAY_KEY)).toBe(false);
    expect(map.has(PAIRINGS_KEY)).toBe(true);
  });

  it("remembers the last-used room across selections", () => {
    upsertPairing({ roomId: A, x25519Pub: KEY, token: "a" }, 10);
    upsertPairing({ roomId: B, x25519Pub: KEY, token: "b" }, 20);
    expect(lastUsedPairing()?.roomId).toBe(B);
    selectPairing(A, 30);
    expect(lastUsedPairing()?.roomId).toBe(A);
  });

  it("removes one room, only with a matching token when given one", () => {
    upsertPairing({ roomId: A, x25519Pub: KEY, token: "a" });
    upsertPairing({ roomId: B, x25519Pub: KEY, token: "b" });
    removePairing(A, "stale");
    expect(listPairings()).toHaveLength(2);
    removePairing(A);
    expect(listPairings().map((p) => p.roomId)).toEqual([B]);
  });

  it("reuses the smallest free Host number", () => {
    upsertPairing({ roomId: A, x25519Pub: KEY, token: "a" });
    upsertPairing({ roomId: B, x25519Pub: KEY, token: "b" });
    removePairing(A);
    upsertPairing({ roomId: A, x25519Pub: KEY, token: "a" });
    expect(listPairings().find((p) => p.roomId === A)?.name).toBe("Host 1");
  });
});
