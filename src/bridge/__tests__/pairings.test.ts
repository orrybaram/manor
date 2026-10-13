import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { base64urlEncode } from "../../lib/relay-crypto";
import {
  LEGACY_RELAY_KEY,
  PAIRINGS_KEY,
  lastUsedPairing,
  listPairings,
  migrateLegacyPairing,
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
    upsertPairing({ roomId: A, serverKey: KEY, token: "a" }, 10);
    upsertPairing({ roomId: B, serverKey: KEY, token: "b" }, 20);
    expect(listPairings()).toEqual([
      { roomId: A, serverKey: KEY, token: "a", name: "Host 1", addedAt: 10, lastUsedAt: 10 },
      { roomId: B, serverKey: KEY, token: "b", name: "Host 2", addedAt: 20, lastUsedAt: 20 },
    ]);
  });

  it("updates the same room in place, keeping name and addedAt", () => {
    upsertPairing({ roomId: A, serverKey: KEY, token: "a" }, 10);
    renamePairing(A, "Studio");
    upsertPairing({ roomId: A, serverKey: KEY, token: "a2" }, 30);
    expect(listPairings()).toEqual([
      { roomId: A, serverKey: KEY, token: "a2", name: "Studio", addedAt: 10, lastUsedAt: 30 },
    ]);
  });

  it("migrates the legacy single pairing", () => {
    map.set(LEGACY_RELAY_KEY, JSON.stringify({ roomId: A, serverKey: KEY, token: "old" }));
    // Listing only reads: the migration is `readPairing`'s, once at boot.
    expect(listPairings()).toEqual([]);
    expect(map.has(LEGACY_RELAY_KEY)).toBe(true);
    migrateLegacyPairing(5);
    expect(listPairings()).toEqual([
      { roomId: A, serverKey: KEY, token: "old", name: "Host 1", addedAt: 5, lastUsedAt: 5 },
    ]);
    expect(map.has(LEGACY_RELAY_KEY)).toBe(false);
    expect(map.has(PAIRINGS_KEY)).toBe(true);
  });

  it("listing returns the same array until the list changes", () => {
    upsertPairing({ roomId: A, serverKey: KEY, token: "a" }, 10);
    const first = listPairings();
    expect(listPairings()).toBe(first);
    upsertPairing({ roomId: B, serverKey: KEY, token: "b" }, 20);
    expect(listPairings()).not.toBe(first);
  });

  it("remembers the last-used room across selections", () => {
    upsertPairing({ roomId: A, serverKey: KEY, token: "a" }, 10);
    upsertPairing({ roomId: B, serverKey: KEY, token: "b" }, 20);
    expect(lastUsedPairing()?.roomId).toBe(B);
    selectPairing(A, 30);
    expect(lastUsedPairing()?.roomId).toBe(A);
  });

  it("removes one room only when all its credentials match", () => {
    const a = upsertPairing({ roomId: A, serverKey: KEY, token: "a" });
    upsertPairing({ roomId: B, serverKey: KEY, token: "b" });
    removePairing({ ...a, token: "stale" });
    removePairing({ ...a, serverKey: base64urlEncode(new Uint8Array(32).fill(1)) });
    expect(listPairings()).toHaveLength(2);
    removePairing(a);
    expect(listPairings().map((p) => p.roomId)).toEqual([B]);
  });

  it("reuses the smallest free Host number", () => {
    const a = upsertPairing({ roomId: A, serverKey: KEY, token: "a" });
    upsertPairing({ roomId: B, serverKey: KEY, token: "b" });
    removePairing(a);
    upsertPairing({ roomId: A, serverKey: KEY, token: "a" });
    expect(listPairings().find((p) => p.roomId === A)?.name).toBe("Host 1");
  });
});
