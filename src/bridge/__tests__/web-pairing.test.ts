/**
 * The pairing link, both forms (ADR-178 D1, ADR-206 D3), and the relay's
 * version redirect guard (ADR-206 D4).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { base64urlEncode } from "../../lib/relay-crypto";
import { WEB_TOKEN_KEY } from "../transports/ws";
import {
  VERSION_REDIRECT_KEY,
  WEB_RELAY_KEY,
  forgetPairing,
  parseFragment,
  readPairing,
  versionRedirectTarget,
} from "../web-pairing";

const ROOM = "AbCdEfGhIjKlMnOpQr_-01";
const KEY = base64urlEncode(new Uint8Array(32).fill(9));
const RELAY_HASH = `#relay=${ROOM}.${KEY}&t=tok_en-1`;
/** Shaped like a minted device token: 32 bytes, base64url, 43 characters. */
const TOKEN = base64urlEncode(new Uint8Array(32).fill(7));
const OTHER_TOKEN = base64urlEncode(new Uint8Array(32).fill(8));

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

  it("reads the legacy listener form as a bare token", () => {
    expect(TOKEN).toHaveLength(43);
    expect(parseFragment(`#${TOKEN}`)).toEqual({
      kind: "listener",
      token: TOKEN,
    });
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

  /** A relay-served page by default; pass `/app/` for the listener's. */
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

  it("stores a relay link, strips the fragment, and picks relay mode", () => {
    at(RELAY_HASH);
    expect(readPairing()).toEqual({
      mode: "relay",
      relay: { roomId: ROOM, serverKey: KEY, token: "tok_en-1" },
    });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/app/1.0.0/");
    expect(JSON.parse(local.map.get(WEB_RELAY_KEY) ?? "null")).toEqual({
      roomId: ROOM,
      serverKey: KEY,
      token: "tok_en-1",
    });
  });

  it("stays in relay mode on the next load, from storage", () => {
    at(RELAY_HASH);
    readPairing();
    at("");
    expect(readPairing().mode).toBe("relay");
    expect(replaceState).toHaveBeenCalledOnce();
  });

  it("keeps the legacy form exactly as before", () => {
    at(`#${TOKEN}`, "/app/");
    expect(readPairing()).toEqual({ mode: "listener", token: TOKEN });
    expect(local.map.get(WEB_TOKEN_KEY)).toBe(TOKEN);
    at("", "/app");
    expect(readPairing()).toEqual({ mode: "listener", token: TOKEN });
  });

  it("leaves an anchor fragment alone on a relay-paired page", () => {
    at(RELAY_HASH);
    readPairing();
    at("#details");
    expect(readPairing().mode).toBe("relay");
    expect(replaceState).toHaveBeenCalledOnce();
    expect(local.map.has(WEB_RELAY_KEY)).toBe(true);
    expect(local.map.has(WEB_TOKEN_KEY)).toBe(false);
  });

  it("never lets a listener token replace relay credentials on a relay page", () => {
    at(RELAY_HASH);
    readPairing();
    at(`#${TOKEN}`, "/app/1.0.0/web.html");
    expect(readPairing()).toEqual({
      mode: "relay",
      relay: { roomId: ROOM, serverKey: KEY, token: "tok_en-1" },
    });
    // Stripped, since it looks like a credential, but not stored.
    expect(replaceState).toHaveBeenCalledTimes(2);
    expect(local.map.has(WEB_TOKEN_KEY)).toBe(false);
  });

  it("does not store a listener token on a relay page with no pairing", () => {
    at(`#${TOKEN}`);
    expect(readPairing()).toEqual({ mode: "listener", token: null });
    expect(local.map.size).toBe(0);
  });

  it("is in listener mode with no token when nothing is known", () => {
    at("");
    expect(readPairing()).toEqual({ mode: "listener", token: null });
  });

  it("lets the newest link win over the other form", () => {
    // `localStorage` is per origin, so this only happens on one origin in a
    // test: a listener page under `/app/`.
    at(`#${TOKEN}`, "/app/");
    readPairing();
    at(RELAY_HASH, "/app/");
    readPairing();
    expect(local.map.has(WEB_TOKEN_KEY)).toBe(false);
    at(`#${OTHER_TOKEN}`, "/app/");
    expect(readPairing().mode).toBe("listener");
    expect(local.map.has(WEB_RELAY_KEY)).toBe(false);
  });

  it("strips an invalid relay link without storing it", () => {
    at(`#relay=nope&t=x`);
    expect(readPairing()).toEqual({ mode: "listener", token: null });
    expect(replaceState).toHaveBeenCalledOnce();
    expect(local.map.size).toBe(0);
  });

  it("ignores stored relay credentials that do not parse", () => {
    local.map.set(WEB_RELAY_KEY, JSON.stringify({ roomId: "x" }));
    at("");
    expect(readPairing().mode).toBe("listener");
  });

  it("forgetPairing drops the relay pairing this tab used", () => {
    at(RELAY_HASH);
    const pairing = readPairing();
    forgetPairing(pairing);
    expect(local.map.size).toBe(0);
  });

  it("forgetPairing drops the listener token this tab used", () => {
    at(`#${TOKEN}`, "/app/");
    const pairing = readPairing();
    forgetPairing(pairing);
    expect(local.map.size).toBe(0);
  });

  it("forgetPairing keeps a newer relay pairing another tab stored", () => {
    at(RELAY_HASH);
    const stale = readPairing();
    const newer = { roomId: ROOM, serverKey: KEY, token: "newer" };
    local.map.set(WEB_RELAY_KEY, JSON.stringify(newer));
    forgetPairing(stale);
    expect(JSON.parse(local.map.get(WEB_RELAY_KEY) ?? "null")).toEqual(newer);
  });

  it("forgetPairing keeps a newer listener token another tab stored", () => {
    at(`#${TOKEN}`, "/app/");
    const stale = readPairing();
    local.map.set(WEB_TOKEN_KEY, OTHER_TOKEN);
    forgetPairing(stale);
    expect(local.map.get(WEB_TOKEN_KEY)).toBe(OTHER_TOKEN);
    forgetPairing({ mode: "listener", token: null });
    expect(local.map.get(WEB_TOKEN_KEY)).toBe(OTHER_TOKEN);
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
