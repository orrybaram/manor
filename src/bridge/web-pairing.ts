/**
 * What this browser is paired with, read from the URL fragment and
 * `localStorage` (ADR-178 D1, ADR-206 D3), and the relay's version redirect
 * (ADR-206 D4). Pure enough to test without importing `install-web.ts`,
 * which installs the bridge as a side effect.
 *
 * Two link forms, both in the fragment — which no browser sends to any
 * server, the relay and Cloudflare's logs included:
 *
 * - **Listener:** `https://<listener>/app#<token>`. Unchanged since ADR-178.
 * - **Relay:** `https://<relay-origin>/app/<version>/#relay=<roomId>.<x25519Pub>&t=<token>`,
 *   with `roomId` and the key base64url, and the token as the device store
 *   minted it.
 *
 * **Which pipe a page uses** is decided by one rule: *relay mode iff relay
 * credentials are known* — from this load's fragment, or stored under
 * `WEB_RELAY_KEY`. A page served by a Manor listener can never hold them:
 * relay links name the relay origin, and `localStorage` is per origin, so the
 * listener origin's storage only ever sees listener tokens. A fresh fragment
 * of either form also clears the stored credentials of the other form, so the
 * most recent link is the one that counts — with one exception below.
 *
 * **Which fragments count as a link at all.** A fragment is also what an
 * ordinary in-page anchor (`#details`, a markdown footnote opened in a new
 * tab) leaves behind, so only two shapes are read:
 *
 * - `relay=…` — the relay form; one that does not parse is `invalid`
 *   (stripped, nothing stored).
 * - exactly a device token as `devices.ts` mints it: 32 random bytes in
 *   base64url, 43 characters of `[A-Za-z0-9_-]` (`TOKEN_PATTERN`).
 *
 * Anything else is `none`: left in the URL, nothing read, nothing forgotten.
 *
 * **A relay-served page never takes a listener token.** A page is
 * relay-served when its path is under `/app/<version>/` (`isRelayPath`):
 * that versioned base is the relay build's (`scripts/build-web-relay.mjs`);
 * the listener build's base is `/app/` and the listener serves nothing under
 * a version segment. On such a page a listener-form fragment is stripped (it
 * looks like a credential) but neither stored nor allowed to clear stored
 * relay credentials — a listener token cannot work against the relay origin
 * (it would dial the relay's nonexistent `/ws` forever), so accepting it
 * could only break a working relay pairing.
 */

import { ROOM_ID_LENGTH, base64urlDecode } from "../lib/relay-crypto";
import { WEB_TOKEN_KEY } from "./transports/ws";

/** Where a relay pairing is kept: `{ roomId, serverKey, token }` as JSON. */
export const WEB_RELAY_KEY = "manor.web.relay";

/** `sessionStorage`: the versions this tab already redirected to (JSON array). */
export const VERSION_REDIRECT_KEY = "manor.web.versionRedirect";

export interface RelayCredentials {
  roomId: string;
  /** The desktop's X25519 static public key, base64url. */
  serverKey: string;
  token: string;
}

export type Pairing =
  | { mode: "listener"; token: string | null }
  | { mode: "relay"; relay: RelayCredentials };

/** What one fragment says, before anything is stored. */
export type FragmentPairing =
  | { kind: "none" }
  | { kind: "listener"; token: string }
  | { kind: "relay"; relay: RelayCredentials }
  /** Looked like a relay link but did not parse. Nothing is stored. */
  | { kind: "invalid" };

const ROOM_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${ROOM_ID_LENGTH}}$`);
/**
 * A device token exactly as `electron/remote-control/devices.ts` mints it:
 * `randomBytes(32).toString("base64url")`, unpadded — 43 characters.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** A path under a versioned base, `/app/<version>/…` — the relay's only. */
const RELAY_PATH_PATTERN = /^\/app\/[^/]+\//;

/** Whether a page at `pathname` is relay-served (see the header). */
function isRelayPath(pathname: string): boolean {
  return RELAY_PATH_PATTERN.test(pathname);
}
const X25519_KEY_BYTES = 32;

function decodeKey(text: string): Uint8Array | null {
  try {
    const key = base64urlDecode(text);
    return key.length === X25519_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/** The desktop's key as bytes, or null if the stored text is not one. */
export function serverKeyBytes(relay: RelayCredentials): Uint8Array | null {
  return decodeKey(relay.serverKey);
}

function isRelayCredentials(value: unknown): value is RelayCredentials {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.roomId === "string" &&
    ROOM_ID_PATTERN.test(v.roomId) &&
    typeof v.serverKey === "string" &&
    decodeKey(v.serverKey) !== null &&
    typeof v.token === "string" &&
    v.token.length > 0
  );
}

/** Parse `location.hash` (with or without the leading `#`). */
export function parseFragment(hash: string): FragmentPairing {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!fragment) return { kind: "none" };
  if (!fragment.startsWith("relay=")) {
    // Not token-shaped: an in-page anchor or some other app's fragment.
    return TOKEN_PATTERN.test(fragment)
      ? { kind: "listener", token: fragment }
      : { kind: "none" };
  }

  const params = new Map<string, string>();
  for (const part of fragment.split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return { kind: "invalid" };
    try {
      params.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)));
    } catch {
      return { kind: "invalid" };
    }
  }
  const relay = params.get("relay") ?? "";
  const dot = relay.indexOf(".");
  const candidate = {
    roomId: dot < 0 ? "" : relay.slice(0, dot),
    serverKey: dot < 0 ? "" : relay.slice(dot + 1),
    token: params.get("t") ?? "",
  };
  return isRelayCredentials(candidate)
    ? { kind: "relay", relay: candidate }
    : { kind: "invalid" };
}

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage denied (private browsing): this session still works, the
    // next reload asks for the link again.
  }
}

function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to forget.
  }
}

function storedRelay(): RelayCredentials | null {
  const raw = storageGet(WEB_RELAY_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRelayCredentials(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Take a pairing out of the fragment on this load, store it, and strip the
 * fragment so it cannot linger in history or a screenshot; otherwise read
 * what was stored. See the header for the mode rule.
 */
export function readPairing(): Pairing {
  const fresh = parseFragment(location.hash);
  if (fresh.kind !== "none") {
    history.replaceState(null, "", location.pathname + location.search);
  }
  if (fresh.kind === "listener" && !isRelayPath(location.pathname)) {
    storageRemove(WEB_RELAY_KEY);
    storageSet(WEB_TOKEN_KEY, fresh.token);
    return { mode: "listener", token: fresh.token };
  }
  if (fresh.kind === "relay") {
    storageRemove(WEB_TOKEN_KEY);
    storageSet(WEB_RELAY_KEY, JSON.stringify(fresh.relay));
    return { mode: "relay", relay: fresh.relay };
  }
  const relay = storedRelay();
  if (relay) return { mode: "relay", relay };
  return { mode: "listener", token: storageGet(WEB_TOKEN_KEY) };
}

/**
 * The host refused `pairing` (4401): drop it — but only if it is still what
 * is stored. Another tab may have taken a newer link since this one loaded,
 * and a stale tab's refusal must not erase that.
 */
export function forgetPairing(pairing: Pairing): void {
  if (pairing.mode === "listener") {
    if (pairing.token !== null && storageGet(WEB_TOKEN_KEY) === pairing.token) {
      storageRemove(WEB_TOKEN_KEY);
    }
    return;
  }
  const stored = storedRelay();
  if (
    stored !== null &&
    stored.roomId === pairing.relay.roomId &&
    stored.serverKey === pairing.relay.serverKey &&
    stored.token === pairing.relay.token
  ) {
    storageRemove(WEB_RELAY_KEY);
  }
}

/** A version that can be put in a path without saying anything else. */
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/**
 * Where a relay-served page should go when the desktop runs a different
 * version from the one it was built as (ADR-206 D4), or null to stay.
 *
 * Guarded in `sessionStorage` by target: this tab goes to a given version at
 * most once per session (`VERSION_REDIRECT_KEY` holds the versions it has
 * gone to, as a JSON array). If `/app/<v>/` serves a build that still
 * disagrees (a mis-upload), the page stays rather than bouncing — every
 * target is spent after one use, so no sequence of redirects can loop. A
 * page whose own version matches the host's has arrived, and clears the
 * guard: a later desktop update (or downgrade) is followed again. Without
 * `sessionStorage` there is no guard, so no redirect. A version with no
 * uploaded build 404s at the relay, which has its own screen for it.
 */
export function versionRedirectTarget(
  ownVersion: string,
  hostVersion: string | null,
): string | null {
  if (hostVersion === null) return null;
  try {
    if (hostVersion === ownVersion) {
      sessionStorage.removeItem(VERSION_REDIRECT_KEY);
      return null;
    }
    if (!VERSION_PATTERN.test(hostVersion)) return null;
    const visited = redirectedVersions();
    if (visited.includes(hostVersion)) return null;
    sessionStorage.setItem(
      VERSION_REDIRECT_KEY,
      JSON.stringify([...visited, hostVersion].slice(-MAX_REDIRECT_TARGETS)),
    );
  } catch {
    return null;
  }
  return `/app/${hostVersion}/`;
}

/** Plenty for real updates; bounds the guard if something goes very wrong. */
const MAX_REDIRECT_TARGETS = 16;

/** The versions this tab already redirected to. Throws without storage. */
function redirectedVersions(): string[] {
  const raw = sessionStorage.getItem(VERSION_REDIRECT_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // An older build stored the bare version string.
  }
  return [raw];
}
