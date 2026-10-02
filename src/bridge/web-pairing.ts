/**
 * What this browser is paired with, read from the URL fragment and
 * `localStorage` (ADR-178 D1, ADR-206 D3), and the relay's version redirect
 * (ADR-206 D4). Pure enough to test without importing `install-web.ts`,
 * which installs the bridge as a side effect.
 *
 * One link form, in the fragment — which no browser sends to any server, the
 * relay and Cloudflare's logs included:
 * `https://<relay-origin>/app/<version>/#relay=<roomId>.<x25519Pub>&t=<token>`,
 * with `roomId` and the key base64url, and the token as the device store
 * minted it. The relay origin is the only server the web app has (ADR-207
 * D2); a page with no relay credentials is simply not paired.
 *
 * **Which fragments count as a link at all.** A fragment is also what an
 * ordinary in-page anchor (`#details`, a markdown footnote opened in a new
 * tab) leaves behind, so only two shapes are read:
 *
 * - `relay=…` — the link; one that does not parse is `invalid` (stripped,
 *   nothing stored).
 * - exactly a device token as `devices.ts` mints it: 32 random bytes in
 *   base64url, 43 characters of `[A-Za-z0-9_-]` (`TOKEN_PATTERN`) — the old
 *   loopback listener's `/app#<token>` link. Nothing can use it any more, but
 *   it is a credential: also `invalid`, so it is stripped from the URL and
 *   history without being stored or touching a stored relay pairing.
 *
 * Anything else is `none`: left in the URL, nothing read, nothing forgotten.
 */

import { ROOM_ID_LENGTH, base64urlDecode } from "../lib/relay-crypto";

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

/** The relay pairing this page holds, or null for none. */
export type Pairing = RelayCredentials | null;

/** What one fragment says, before anything is stored. */
export type FragmentPairing =
  | { kind: "none" }
  | { kind: "relay"; relay: RelayCredentials }
  /**
   * Looked like a credential but is not a usable link: a relay link that did
   * not parse, or a bare token. Stripped; nothing is stored.
   */
  | { kind: "invalid" };

const ROOM_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${ROOM_ID_LENGTH}}$`);
/**
 * A device token exactly as `electron/remote-control/devices.ts` mints it:
 * `randomBytes(32).toString("base64url")`, unpadded — 43 characters.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
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
      ? { kind: "invalid" }
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
 * what was stored. A fresh link replaces whatever was stored before it, so
 * the most recent link is the one that counts.
 */
export function readPairing(): Pairing {
  const fresh = parseFragment(location.hash);
  if (fresh.kind !== "none") {
    history.replaceState(null, "", location.pathname + location.search);
  }
  if (fresh.kind === "relay") {
    storageSet(WEB_RELAY_KEY, JSON.stringify(fresh.relay));
    return fresh.relay;
  }
  return storedRelay();
}

/**
 * The host refused `pairing` (4401): drop it — but only if it is still what
 * is stored. Another tab may have taken a newer link since this one loaded,
 * and a stale tab's refusal must not erase that.
 */
export function forgetPairing(pairing: Pairing): void {
  if (pairing === null) return;
  const stored = storedRelay();
  if (
    stored !== null &&
    stored.roomId === pairing.roomId &&
    stored.serverKey === pairing.serverKey &&
    stored.token === pairing.token
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
