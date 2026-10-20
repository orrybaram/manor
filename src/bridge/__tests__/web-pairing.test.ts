/**
 * The pairing link, and the relay's
 * version redirect guard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { base64urlEncode } from "../../lib/relay-crypto";
import { LEGACY_RELAY_KEY, PAIRINGS_KEY, declinedRooms, listPairings } from "../pairings";
import {
  VERSION_REDIRECT_KEY,
  forgetPairing,
  parseFragment,
  readPairing,
  versionRedirectTarget,
} from "../web-pairing";

const ROOM = "AbCdEfGhIjKlMnOpQr_-01";
const ROOM2 = "ZyXwVuTsRqPoNmLkJi_-02";
const KEY = base64urlEncode(new Uint8Array(32).fill(9));
const RELAY_HASH = `#relay=${ROOM}.${KEY}&t=tok_en-1`;
/** Shaped like a minted device token: 32 bytes, base64url, 43 characters. */
const TOKEN = base64urlEncode(new Uint8Array(32).fill(7));
/** The stored relay pairing `RELAY_HASH` makes. */
const RELAY = { roomId: ROOM, serverKey: KEY, token: "tok_en-1" };

function memoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

describe("parseFragment", () => {
  it("reads nothing from an empty fragment", () => {
    expect(parseFragment("")).toEqual({ kind: "none" });
    expect(parseFragment("#")).toEqual({ kind: "none" });
  });

  it("reads the old loopback listener's bare token as an unusable credential", () => {
    expect(TOKEN).toHaveLength(43);
    expect(parseFragment(`#${TOKEN}`)).toEqual({ kind: "invalid" });
  });

  it.each([
    ["an in-page anchor", "#details"],
    ["a footnote anchor", "#user-content-fn-1"],
    ["one character short", `#${TOKEN.slice(1)}`],
    ["one character long", `#${TOKEN}A`],
    ["padding", `#${TOKEN.slice(0, 42)}=`],
    ["a query-like fragment", "#foo=bar"],
  ])("ignores %s: not a token", (_, hash) => {
    expect(parseFragment(hash)).toEqual({ kind: "none" });
  });

  it("reads the relay form", () => {
    expect(parseFragment(RELAY_HASH)).toEqual({
      kind: "relay",
      relay: { roomId: ROOM, serverKey: KEY, token: "tok_en-1" },
    });
  });

  it("reads the single-use form", () => {
    expect(parseFragment(`#relay=${ROOM}.${KEY}&ticket=${TOKEN}`)).toEqual({
      kind: "ticket",
      link: { roomId: ROOM, serverKey: KEY, ticket: TOKEN },
    });
  });

  it.each([
    ["both a token and a ticket", `#relay=${ROOM}.${KEY}&t=x&ticket=${TOKEN}`],
    ["a ticket before a token", `#relay=${ROOM}.${KEY}&ticket=${TOKEN}&t=x`],
    ["an empty ticket", `#relay=${ROOM}.${KEY}&ticket=`],
    ["a ticket with a short key", `#relay=${ROOM}.${KEY.slice(0, 20)}&ticket=${TOKEN}`],
  ])("rejects a ticket link with %s", (_, hash) => {
    expect(parseFragment(hash)).toEqual({ kind: "invalid" });
  });

  it("reads a fragment given without its '#'", () => {
    expect(parseFragment(`relay=${ROOM}.${KEY}&t=x`).kind).toBe("relay");
  });

  it.each([
    ["no token", `#relay=${ROOM}.${KEY}`],
    ["empty token", `#relay=${ROOM}.${KEY}&t=`],
    ["no dot", `#relay=${ROOM}${KEY}&t=x`],
    ["short room", `#relay=abc.${KEY}&t=x`],
    ["bad room characters", `#relay=${ROOM.slice(0, 21)}!.${KEY}&t=x`],
    ["short key", `#relay=${ROOM}.${KEY.slice(0, 20)}&t=x`],
    ["bad key characters", `#relay=${ROOM}.${KEY.slice(0, 42)}*&t=x`],
    ["malformed pair", `#relay=${ROOM}.${KEY}&t`],
    ["bad escape", `#relay=${ROOM}.${KEY}&t=%E0%A4%A`],
  ])("rejects a relay link with %s", (_, hash) => {
    expect(parseFragment(hash)).toEqual({ kind: "invalid" });
  });
});

describe("readPairing", () => {
  let local: ReturnType<typeof memoryStorage>;
  let replaceState: ReturnType<typeof vi.fn>;

  function at(hash: string, pathname = "/app/1.0.0/"): void {
    vi.stubGlobal("location", { hash, pathname, search: "" });
  }

  beforeEach(() => {
    local = memoryStorage();
    replaceState = vi.fn();
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("history", { replaceState });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores a relay link and strips the fragment", () => {
    at(RELAY_HASH);
    expect(readPairing()).toMatchObject(RELAY);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/app/1.0.0/");
    const stored = JSON.parse(local.map.get(PAIRINGS_KEY) ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      roomId: ROOM,
      serverKey: KEY,
      token: "tok_en-1",
      name: "Host 1",
    });
  });

  it("reads the pairing from storage on the next load", () => {
    at(RELAY_HASH);
    readPairing();
    at("");
    expect(readPairing()).toMatchObject(RELAY);
    expect(replaceState).toHaveBeenCalledOnce();
  });

  it("leaves an anchor fragment alone on a paired page", () => {
    at(RELAY_HASH);
    readPairing();
    at("#details");
    expect(readPairing()).toMatchObject(RELAY);
    expect(replaceState).toHaveBeenCalledOnce();
    expect(local.map.has(PAIRINGS_KEY)).toBe(true);
  });

  it("strips an old listener token without letting it touch the pairing", () => {
    at(RELAY_HASH);
    readPairing();
    at(`#${TOKEN}`, "/app/1.0.0/web.html");
    expect(readPairing()).toMatchObject(RELAY);
    // Stripped, since it looks like a credential, but not stored.
    expect(replaceState).toHaveBeenCalledTimes(2);
    expect([...local.map.keys()]).toEqual([PAIRINGS_KEY]);
  });

  it("does not store an old listener token on an unpaired page", () => {
    at(`#${TOKEN}`, "/app/");
    expect(readPairing()).toBeNull();
    expect(replaceState).toHaveBeenCalledOnce();
    expect(local.map.size).toBe(0);
  });

  it("is unpaired when nothing is known", () => {
    at("");
    expect(readPairing()).toBeNull();
  });

  it("lets the newest link win", () => {
    at(RELAY_HASH);
    readPairing();
    at(`#relay=${ROOM}.${KEY}&t=newer`);
    expect(readPairing()).toMatchObject({ ...RELAY, token: "newer" });
    at("");
    expect(readPairing()).toMatchObject({ ...RELAY, token: "newer" });
  });

  it("stores a ticket link with a token of its own and strips the fragment", () => {
    at(`#relay=${ROOM}.${KEY}&ticket=${TOKEN}`);
    const pairing = readPairing();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/app/1.0.0/");
    expect(pairing).toMatchObject({ roomId: ROOM, serverKey: KEY, ticket: TOKEN });
    expect(pairing?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pairing?.token).not.toBe(TOKEN);
    const stored = JSON.parse(local.map.get(PAIRINGS_KEY) ?? "[]");
    expect(stored).toEqual([expect.objectContaining({ token: pairing?.token, ticket: TOKEN })]);
  });

  it("keeps the token when the same ticket link is opened again", () => {
    at(`#relay=${ROOM}.${KEY}&ticket=${TOKEN}`);
    const first = readPairing();
    at(`#relay=${ROOM}.${KEY}&ticket=${TOKEN}`);
    expect(readPairing()?.token).toBe(first?.token);
    expect(listPairings()).toHaveLength(1);
  });

  it("still reads a token link from an older desktop", () => {
    at(RELAY_HASH);
    expect(readPairing()).toEqual(expect.objectContaining(RELAY));
    expect(listPairings()[0]).not.toHaveProperty("ticket");
  });

  it("strips an invalid relay link without storing it", () => {
    at(`#relay=nope&t=x`);
    expect(readPairing()).toBeNull();
    expect(replaceState).toHaveBeenCalledOnce();
    expect(local.map.size).toBe(0);
  });

  it("ignores stored relay credentials that do not parse", () => {
    local.map.set(LEGACY_RELAY_KEY, JSON.stringify({ roomId: "x" }));
    at("");
    expect(readPairing()).toBeNull();
  });

  it("forgetPairing drops the relay pairing this tab used", () => {
    at(RELAY_HASH);
    const pairing = readPairing();
    forgetPairing(pairing);
    expect(listPairings()).toEqual([]);
    // Only the pairing goes: the room is not declined.
    expect(declinedRooms()).toEqual([]);
  });

  it("forgetPairing keeps a newer relay pairing another tab stored", () => {
    at(RELAY_HASH);
    const stale = readPairing();
    at(`#relay=${ROOM}.${KEY}&t=newer`);
    readPairing();
    forgetPairing(stale);
    at("");
    expect(readPairing()).toMatchObject({ ...RELAY, token: "newer" });
    forgetPairing(null);
    expect(readPairing()).toMatchObject({ ...RELAY, token: "newer" });
  });

  it("forgetPairing leaves the other rooms' pairings", () => {
    at(RELAY_HASH);
    const first = readPairing();
    at(`#relay=${ROOM2}.${KEY}&t=second`);
    readPairing();
    forgetPairing(first);
    at("");
    expect(readPairing()).toMatchObject({ roomId: ROOM2, serverKey: KEY, token: "second" });
    expect(listPairings()).toHaveLength(1);
    expect(declinedRooms()).toEqual([]);
  });

  it("a new link adds to the stored pairings rather than replacing them", () => {
    at(RELAY_HASH);
    readPairing();
    at(`#relay=${ROOM2}.${KEY}&t=second`);
    expect(readPairing()).toMatchObject({ roomId: ROOM2, serverKey: KEY, token: "second" });
    expect(listPairings().map((p) => p.roomId)).toEqual([ROOM, ROOM2]);
    expect(replaceState).toHaveBeenCalledTimes(2);
    // No link next time: the one used last is the one dialled.
    at("");
    expect(readPairing()?.roomId).toBe(ROOM2);
  });

  it("carries the legacy single pairing into the list", () => {
    local.map.set(LEGACY_RELAY_KEY, JSON.stringify(RELAY));
    at("");
    expect(readPairing()).toMatchObject(RELAY);
    expect(local.map.has(LEGACY_RELAY_KEY)).toBe(false);
    expect(listPairings()).toHaveLength(1);
    // And a link then adds beside it.
    at(`#relay=${ROOM2}.${KEY}&t=second`);
    readPairing();
    expect(listPairings().map((p) => p.roomId)).toEqual([ROOM, ROOM2]);
  });
});

describe("versionRedirectTarget", () => {
  let session: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    session = memoryStorage();
    vi.stubGlobal("sessionStorage", session);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays when the versions match or the host did not say", () => {
    expect(versionRedirectTarget("1.0.0", "1.0.0")).toBeNull();
    expect(versionRedirectTarget("1.0.0", null)).toBeNull();
    expect(session.map.size).toBe(0);
  });

  it("goes to a given version at most once per session", () => {
    expect(versionRedirectTarget("1.0.0", "1.1.0")).toBe("/app/1.1.0/");
    expect(JSON.parse(session.map.get(VERSION_REDIRECT_KEY) ?? "")).toEqual([
      "1.1.0",
    ]);
    // The build at /app/1.1.0/ turned out to be something else: no bounce.
    expect(versionRedirectTarget("1.0.0", "1.1.0")).toBeNull();
  });

  it("follows a later desktop update after arriving", () => {
    expect(versionRedirectTarget("1.0.0", "1.1.0")).toBe("/app/1.1.0/");
    // The 1.1.0 page matches the host: arrived, guard cleared.
    expect(versionRedirectTarget("1.1.0", "1.1.0")).toBeNull();
    expect(session.map.has(VERSION_REDIRECT_KEY)).toBe(false);
    // The desktop updates again while the tab stays open.
    expect(versionRedirectTarget("1.1.0", "1.2.0")).toBe("/app/1.2.0/");
  });

  it("follows a different target even without arriving, and cannot loop", () => {
    // A mis-uploaded 1.1.0 build that still says 1.0.0 bounces back once…
    expect(versionRedirectTarget("1.0.0", "1.1.0")).toBe("/app/1.1.0/");
    expect(versionRedirectTarget("1.1.0", "1.0.0")).toBe("/app/1.0.0/");
    // …and then both targets are spent.
    expect(versionRedirectTarget("1.0.0", "1.1.0")).toBeNull();
    expect(versionRedirectTarget("1.1.0", "1.0.0")).toBeNull();
    // A genuinely new version is still followed.
    expect(versionRedirectTarget("1.0.0", "1.2.0")).toBe("/app/1.2.0/");
  });

  it("reads a guard an older build stored as a bare version", () => {
    session.map.set(VERSION_REDIRECT_KEY, "1.1.0");
    expect(versionRedirectTarget("1.0.0", "1.1.0")).toBeNull();
    expect(versionRedirectTarget("1.0.0", "1.2.0")).toBe("/app/1.2.0/");
  });

  it("refuses a version that is not a plain version string", () => {
    expect(versionRedirectTarget("1.0.0", "../../evil")).toBeNull();
    expect(versionRedirectTarget("1.0.0", "1.0.0/x")).toBeNull();
    expect(versionRedirectTarget("1.0.0", "")).toBeNull();
  });

  it("does not redirect without sessionStorage to guard the loop", () => {
    const denied = () => {
      throw new Error("denied");
    };
    vi.stubGlobal("sessionStorage", {
      getItem: denied,
      setItem: denied,
      removeItem: denied,
    });
    expect(versionRedirectTarget("1.0.0", "1.1.0")).toBeNull();
    expect(versionRedirectTarget("1.0.0", "1.0.0")).toBeNull();
  });
});
