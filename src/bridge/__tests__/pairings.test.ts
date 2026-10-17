import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { base64urlEncode } from "../../lib/relay-crypto";
import {
  DECLINED_KEY,
  LEGACY_RELAY_KEY,
  PAIRINGS_KEY,
  connectRoomDirectly,
  declinePairing,
  declinedRooms,
  homePairing,
  lastUsedPairing,
  linkPairing,
  listPairings,
  migrateLegacyPairing,
  recordPairingHello,
  recordPairingHosts,
  registerRelink,
  removePairing,
  renamePairing,
  selectPairing,
  subscribePairings,
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
      {
        roomId: A,
        serverKey: KEY,
        token: "a2",
        name: "Studio",
        customName: true,
        addedAt: 10,
        lastUsedAt: 30,
      },
    ]);
  });

  it("takes the host's own name from a hello until the user names it", () => {
    upsertPairing({ roomId: A, serverKey: KEY, token: "a" }, 10);
    recordPairingHello(A, { hostName: "desk.local", hostServer: false });
    expect(listPairings()[0]).toMatchObject({ name: "desk.local", hostServer: false });
    renamePairing(A, "  My Mac ");
    recordPairingHello(A, { hostName: "desk.local", hostServer: false });
    expect(listPairings()[0]).toMatchObject({ name: "My Mac", customName: true });
    // An empty name is no rename.
    renamePairing(A, "  ");
    expect(listPairings()[0].name).toBe("My Mac");
  });

  it("keeps a pairing a desktop linked, named by it, without making it last used (ADR-228 D9)", () => {
    upsertPairing({ roomId: A, serverKey: KEY, token: "desk" }, 10);
    linkPairing({ roomId: B, serverKey: KEY, token: "box", name: "me@box" }, 20);
    expect(listPairings()[1]).toEqual({
      roomId: B,
      serverKey: KEY,
      token: "box",
      name: "me@box",
      addedAt: 20,
      lastUsedAt: 0,
      hostServer: true,
    });
    expect(lastUsedPairing()?.roomId).toBe(A);
    // A fresh mint renews the token; the user's own name stays.
    renamePairing(B, "Build box");
    linkPairing({ roomId: B, serverKey: KEY, token: "box-2", name: "me@box" }, 30);
    expect(listPairings()[1]).toMatchObject({ token: "box-2", name: "Build box", addedAt: 20 });
    // Nothing that is not a pairing is kept.
    linkPairing({ roomId: "short", serverKey: KEY, token: "x", name: "bad" });
    expect(listPairings()).toHaveLength(2);
  });

  it("keeps a desktop's host rooms", () => {
    upsertPairing({ roomId: A, serverKey: KEY, token: "a" }, 10);
    recordPairingHosts(A, { h1: B, h2: null });
    expect(listPairings()[0].hosts).toEqual({ h1: B, h2: null });
  });

  it("makes the paired desktop home, else the last used", () => {
    upsertPairing({ roomId: A, serverKey: KEY, token: "a" }, 10);
    upsertPairing({ roomId: B, serverKey: KEY, token: "b" }, 20);
    expect(homePairing()?.roomId).toBe(B);
    recordPairingHello(B, { hostName: null, hostServer: true });
    expect(homePairing()?.roomId).toBe(B);
    recordPairingHello(A, { hostName: null, hostServer: false });
    expect(homePairing()?.roomId).toBe(A);
  });

  it("drops a stored pairing whose extra fields are malformed", () => {
    map.set(
      PAIRINGS_KEY,
      JSON.stringify([
        { roomId: A, serverKey: KEY, token: "a", name: "A", addedAt: 1, lastUsedAt: 1, hosts: [] },
        { roomId: B, serverKey: KEY, token: "b", name: "B", addedAt: 1, lastUsedAt: 1 },
      ]),
    );
    expect(listPairings().map((p) => p.roomId)).toEqual([B]);
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

  it("remembers a declined room, which a desktop's link does not bring back but a fresh link does (ADR-228 D9)", () => {
    upsertPairing({ roomId: A, serverKey: KEY, token: "desk" }, 10);
    linkPairing({ roomId: B, serverKey: KEY, token: "box", name: "me@box" }, 20);
    const box = listPairings()[1];
    // A stale tab's refusal declines nothing.
    declinePairing({ ...box, token: "stale" });
    expect(declinedRooms()).toEqual([]);
    declinePairing(box);
    expect(listPairings().map((p) => p.roomId)).toEqual([A]);
    expect(declinedRooms()).toEqual([B]);
    linkPairing({ roomId: B, serverKey: KEY, token: "box-2", name: "me@box" }, 30);
    expect(listPairings().map((p) => p.roomId)).toEqual([A]);
    // A QR re-pair takes the room back.
    upsertPairing({ roomId: B, serverKey: KEY, token: "qr" }, 40);
    expect(declinedRooms()).toEqual([]);
    expect(map.has(DECLINED_KEY)).toBe(false);
    expect(listPairings().map((p) => p.roomId)).toEqual([A, B]);
  });

  it("connects to a declined room directly: undeclined, then the desktops asked to link it", async () => {
    upsertPairing({ roomId: A, serverKey: KEY, token: "desk" }, 10);
    linkPairing({ roomId: B, serverKey: KEY, token: "box", name: "me@box" }, 20);
    declinePairing(listPairings()[1]);
    expect(declinedRooms()).toEqual([B]);
    // What install-web.ts's relink does: the desktop mints, the page links it.
    const relink = vi.fn(async () => {
      linkPairing({ roomId: B, serverKey: KEY, token: "box-2", name: "me@box" }, 30);
    });
    registerRelink(relink);
    await connectRoomDirectly(B);
    expect(relink).toHaveBeenCalledOnce();
    expect(declinedRooms()).toEqual([]);
    expect(listPairings().map((p) => p.roomId)).toEqual([A, B]);
  });

  it("returns the same declined list until it changes", () => {
    upsertPairing({ roomId: A, serverKey: KEY, token: "a" }, 10);
    const first = declinedRooms();
    expect(declinedRooms()).toBe(first);
    declinePairing(listPairings()[0]);
    const second = declinedRooms();
    expect(second).toEqual([A]);
    expect(declinedRooms()).toBe(second);
  });

  it("has the room declined by the time a subscriber hears of its removal", () => {
    upsertPairing({ roomId: A, serverKey: KEY, token: "a" }, 10);
    const seen: string[][] = [];
    const off = subscribePairings(() => seen.push(declinedRooms()));
    declinePairing(listPairings()[0]);
    off();
    expect(seen).toEqual([[A]]);
  });

  it("notifies when connecting directly to a declined room", async () => {
    upsertPairing({ roomId: A, serverKey: KEY, token: "a" }, 10);
    declinePairing(listPairings()[0]);
    const cb = vi.fn();
    const off = subscribePairings(cb);
    await connectRoomDirectly(A);
    off();
    expect(cb).toHaveBeenCalled();
    expect(declinedRooms()).toEqual([]);
  });

  it("reuses the smallest free Host number", () => {
    const a = upsertPairing({ roomId: A, serverKey: KEY, token: "a" });
    upsertPairing({ roomId: B, serverKey: KEY, token: "b" });
    removePairing(a);
    upsertPairing({ roomId: A, serverKey: KEY, token: "a" });
    expect(listPairings().find((p) => p.roomId === A)?.name).toBe("Host 1");
  });
});
