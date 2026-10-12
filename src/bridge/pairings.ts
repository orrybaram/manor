/**
 * Every host this browser is paired with (ADR-218 D7), kept in `localStorage`
 * keyed by relay room id. A phone can hold a pairing for the desktop and one
 * for each host server; the tab dials one at a time, and switching reloads
 * the page against another (`selectPairing`, then `location.reload()`).
 *
 * The last-used pairing is simply the one with the greatest `lastUsedAt`: a
 * fresh link or a switch stamps it, and a load with no link opens that one.
 * Before this list existed a single pairing lived at `manor.web.relay`; the
 * first load carries it into the list (named "Host 1") and drops the old key.
 *
 * Pure storage, no bridge: `web-pairing.ts` turns links into records here and
 * `install-web.ts` reads the record it dials.
 */

import { ROOM_ID_LENGTH, base64urlDecode } from "../lib/relay-crypto";

/** The pairing list: `StoredPairing[]` as JSON. */
export const PAIRINGS_KEY = "manor.web.pairings";

/** The single pairing an earlier build kept: `{ roomId, serverKey, token }`. */
export const LEGACY_RELAY_KEY = "manor.web.relay";

export interface StoredPairing {
  roomId: string;
  /** The host's X25519 static public key, base64url. */
  x25519Pub: string;
  token: string;
  /** What the switcher shows: the host's own `hostName`, else "Host N". */
  name: string;
  addedAt: number;
  lastUsedAt: number;
}

const ROOM_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${ROOM_ID_LENGTH}}$`);
const X25519_KEY_BYTES = 32;

export function isValidRoomId(text: string): boolean {
  return ROOM_ID_PATTERN.test(text);
}

/** A base64url X25519 public key as bytes, or null if it is not one. */
export function decodeX25519(text: string): Uint8Array | null {
  try {
    const key = base64urlDecode(text);
    return key.length === X25519_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

function isStoredPairing(value: unknown): value is StoredPairing {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.roomId === "string" &&
    isValidRoomId(v.roomId) &&
    typeof v.x25519Pub === "string" &&
    decodeX25519(v.x25519Pub) !== null &&
    typeof v.token === "string" &&
    v.token.length > 0 &&
    typeof v.name === "string" &&
    typeof v.addedAt === "number" &&
    typeof v.lastUsedAt === "number"
  );
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

const listeners = new Set<() => void>();
const EMPTY: StoredPairing[] = [];
/** The parsed list for `useSyncExternalStore`: stable until it changes. */
let snapshot: { raw: string | null; list: StoredPairing[] } | null = null;

function notify(): void {
  snapshot = null;
  for (const cb of [...listeners]) cb();
}

/** The legacy single pairing as a list entry, or null for none. */
function legacyPairing(now: number): StoredPairing | null {
  const raw = storageGet(LEGACY_RELAY_KEY);
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const candidate = {
      roomId: v.roomId,
      x25519Pub: v.serverKey,
      token: v.token,
      name: "Host 1",
      addedAt: now,
      lastUsedAt: now,
    };
    return isStoredPairing(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function parseList(raw: string): StoredPairing[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStoredPairing) : [];
  } catch {
    return [];
  }
}

function write(list: StoredPairing[]): void {
  storageSet(PAIRINGS_KEY, JSON.stringify(list));
  notify();
}

/**
 * Every stored pairing, oldest first. Carries the legacy single pairing into
 * the list the first time it finds no list.
 */
export function listPairings(): StoredPairing[] {
  const raw = storageGet(PAIRINGS_KEY);
  if (raw === null) {
    const legacy = legacyPairing(Date.now());
    if (legacy === null) return EMPTY;
    write([legacy]);
    storageRemove(LEGACY_RELAY_KEY);
    return [legacy];
  }
  if (snapshot?.raw === raw) return snapshot.list;
  const list = parseList(raw);
  snapshot = { raw, list };
  return list;
}

/** The pairing a load with no link opens: the most recently used. */
export function lastUsedPairing(): StoredPairing | null {
  let best: StoredPairing | null = null;
  for (const p of listPairings()) {
    if (best === null || p.lastUsedAt >= best.lastUsedAt) best = p;
  }
  return best;
}

/** "Host 1", "Host 2", … — the smallest number no stored pairing uses. */
function fallbackName(list: StoredPairing[]): string {
  const used = new Set(list.map((p) => p.name));
  for (let n = 1; ; n++) {
    if (!used.has(`Host ${n}`)) return `Host ${n}`;
  }
}

/**
 * Add a pairing, or update the one for the same room (new key and token,
 * name kept) — a link never replaces the others — and mark it last used.
 */
export function upsertPairing(
  link: { roomId: string; x25519Pub: string; token: string },
  now: number = Date.now(),
): StoredPairing {
  const list = listPairings();
  const existing = list.find((p) => p.roomId === link.roomId);
  const next: StoredPairing = existing
    ? { ...existing, ...link, lastUsedAt: now }
    : { ...link, name: fallbackName(list), addedAt: now, lastUsedAt: now };
  write(existing ? list.map((p) => (p === existing ? next : p)) : [...list, next]);
  return next;
}

/** Mark `roomId` the last used, so the next load opens it. */
export function selectPairing(roomId: string, now: number = Date.now()): void {
  const list = listPairings();
  if (!list.some((p) => p.roomId === roomId)) return;
  write(list.map((p) => (p.roomId === roomId ? { ...p, lastUsedAt: now } : p)));
}

/** Show the host's own name for `roomId`, once its hello has told us. */
export function renamePairing(roomId: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const list = listPairings();
  const current = list.find((p) => p.roomId === roomId);
  if (!current || current.name === trimmed) return;
  write(list.map((p) => (p === current ? { ...p, name: trimmed } : p)));
}

/**
 * Drop `roomId`. With `token`, only if that is still the stored token: a
 * stale tab refused by the host must not erase a newer link another tab took.
 */
export function removePairing(roomId: string, token?: string): void {
  const list = listPairings();
  const next = list.filter(
    (p) => !(p.roomId === roomId && (token === undefined || p.token === token)),
  );
  if (next.length !== list.length) write(next);
}

export function subscribePairings(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === PAIRINGS_KEY) {
      snapshot = null;
      cb();
    }
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

let activeRoomId: string | null = null;

/** `install-web.ts` records the room this page dials. */
export function setActiveRoom(roomId: string | null): void {
  activeRoomId = roomId;
}

/** The room this page dials, for the switcher to mark. */
export function getActiveRoom(): string | null {
  return activeRoomId;
}
