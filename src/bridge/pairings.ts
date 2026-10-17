/**
 * Every host this browser is paired with (ADR-225 D7), kept in `localStorage`
 * keyed by relay room id. A phone can hold a pairing for the desktop and one
 * for each host server, and the page dials them all at once (ADR-228 D8):
 * `install-web.ts` holds a server per pairing, and follows this list as it
 * changes — a pairing removed in the Hosts sheet, or added in another tab.
 *
 * Which one is the page's **home** server (D1): the paired desktop, known
 * from an earlier hello (`hostServer: false`), else the most recently used —
 * the one with the greatest `lastUsedAt`, which a fresh link stamps.
 * Before this list existed a single pairing lived at `manor.web.relay`; the
 * first load carries it into the list (named "Host 1") and drops the old key
 * (`migrateLegacyPairing`, run by `readPairing` at boot).
 *
 * Pure storage, no bridge: `web-pairing.ts` turns links into records here and
 * `install-web.ts` reads the record it dials. Which room the page dials is
 * `connection.ts`'s.
 */

import { ROOM_ID_LENGTH, base64urlDecode } from "../lib/relay-crypto";

/** The pairing list: `StoredPairing[]` as JSON. */
export const PAIRINGS_KEY = "manor.web.pairings";

/**
 * Rooms this browser has let go of (ADR-228 D9): a pairing removed by hand in
 * the Hosts sheet. A host's 4401 refusal does not decline (ADR-238). Sent with the held
 * rooms to `remoteControl.linkHostPairings`, so a desktop does not mint the
 * room again on its next hello. A link for the room (`upsertPairing`, a QR
 * re-pair) takes it back. JSON `string[]`, newest last.
 */
export const DECLINED_KEY = "manor.web.declinedRooms";

/** At most this many declined rooms are remembered; the oldest go first. */
const MAX_DECLINED = 64;

/** The single pairing an earlier build kept: `{ roomId, serverKey, token }`. */
export const LEGACY_RELAY_KEY = "manor.web.relay";

/** What a pairing link carries: enough to dial a host's relay room. */
export interface RelayCredentials {
  roomId: string;
  /** The host's X25519 static public key, base64url. */
  serverKey: string;
  token: string;
}

/** One host in the list: its credentials and what the Hosts sheet shows. */
export interface StoredPairing extends RelayCredentials {
  /** The host's own `hostName`, else "Host N" — or the user's own name. */
  name: string;
  addedAt: number;
  lastUsedAt: number;
  /** The user named it (`renamePairing`): a hello's name no longer applies. */
  customName?: boolean;
  /** What its last hello said: a host server, not a desktop. */
  hostServer?: boolean;
  /**
   * A desktop's remote hosts, by its id for each, with the room each one's
   * server reported, or null (ADR-228 D2) — so a reload names them as before
   * its `hosts.list` has answered.
   */
  hosts?: Record<string, string | null>;
}

const ROOM_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${ROOM_ID_LENGTH}}$`);
const X25519_KEY_BYTES = 32;

function isValidRoomId(text: string): boolean {
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

export function isRelayCredentials(value: unknown): value is RelayCredentials {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.roomId === "string" &&
    isValidRoomId(v.roomId) &&
    typeof v.serverKey === "string" &&
    decodeX25519(v.serverKey) !== null &&
    typeof v.token === "string" &&
    v.token.length > 0
  );
}

function isStoredPairing(value: unknown): value is StoredPairing {
  if (!isRelayCredentials(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.addedAt === "number" &&
    typeof v.lastUsedAt === "number" &&
    (v.customName === undefined || typeof v.customName === "boolean") &&
    (v.hostServer === undefined || typeof v.hostServer === "boolean") &&
    (v.hosts === undefined || isHostRooms(v.hosts))
  );
}

function isHostRooms(value: unknown): value is Record<string, string | null> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((room) => room === null || typeof room === "string")
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
let snapshot: { raw: string | null; list: StoredPairing[] } = {
  raw: null,
  list: EMPTY,
};

function notify(): void {
  for (const cb of [...listeners]) cb();
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
 * Carry the legacy single pairing into the list, the first time there is no
 * list, and drop the old key. Run once at boot, by `readPairing`, before
 * anything reads the list.
 */
export function migrateLegacyPairing(now: number = Date.now()): void {
  const raw = storageGet(LEGACY_RELAY_KEY);
  if (raw === null) return;
  storageRemove(LEGACY_RELAY_KEY);
  if (storageGet(PAIRINGS_KEY) !== null) return;
  let legacy: unknown;
  try {
    legacy = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRelayCredentials(legacy)) return;
  const { roomId, serverKey, token } = legacy;
  write([{ roomId, serverKey, token, name: "Host 1", addedAt: now, lastUsedAt: now }]);
}

/**
 * Every stored pairing, oldest first. Only reads: the same array until the
 * stored list changes, as `useSyncExternalStore` needs.
 */
export function listPairings(): StoredPairing[] {
  const raw = storageGet(PAIRINGS_KEY);
  if (raw === snapshot.raw) return snapshot.list;
  snapshot = { raw, list: raw === null ? EMPTY : parseList(raw) };
  return snapshot.list;
}

/** The pairing a load with no link opens: the most recently used. */
export function lastUsedPairing(): StoredPairing | null {
  let best: StoredPairing | null = null;
  for (const p of listPairings()) {
    if (best === null || p.lastUsedAt >= best.lastUsedAt) best = p;
  }
  return best;
}

/**
 * The page's home server (ADR-228 D1): the most recently used pairing whose
 * last hello came from a desktop, else the most recently used of all.
 */
export function homePairing(list: readonly StoredPairing[] = listPairings()): StoredPairing | null {
  let best: StoredPairing | null = null;
  for (const p of list) {
    if (best === null) {
      best = p;
      continue;
    }
    const desktop = p.hostServer === false;
    const bestDesktop = best.hostServer === false;
    if (desktop !== bestDesktop ? desktop : p.lastUsedAt >= best.lastUsedAt) best = p;
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
  link: RelayCredentials,
  now: number = Date.now(),
): StoredPairing {
  const { roomId, serverKey, token } = link;
  undeclineRoom(roomId);
  const list = listPairings();
  const existing = list.find((p) => p.roomId === roomId);
  const next: StoredPairing = existing
    ? { ...existing, serverKey, token, lastUsedAt: now }
    : { roomId, serverKey, token, name: fallbackName(list), addedAt: now, lastUsedAt: now };
  write(existing ? list.map((p) => (p === existing ? next : p)) : [...list, next]);
  return next;
}

/**
 * A pairing a desktop minted for this browser on one of its hosts
 * (`remoteControl.linkHostPairings`, ADR-228 D9): added, or its key and
 * token renewed. Named as the desktop names the host, unless the user named
 * it; known to be a host server before its first hello; and never marked last
 * used, which is the user's choice of where to land. A room the user let go
 * of (`declinedRooms`) is not taken back this way.
 */
export function linkPairing(
  link: RelayCredentials & { name: string },
  now: number = Date.now(),
): void {
  if (!isRelayCredentials(link)) return;
  if (declinedRooms().includes(link.roomId)) return;
  const { roomId, serverKey, token } = link;
  const name = link.name.trim();
  const list = listPairings();
  const existing = list.find((p) => p.roomId === roomId);
  const next: StoredPairing = existing
    ? {
        ...existing,
        serverKey,
        token,
        name: name && !existing.customName ? name : existing.name,
        hostServer: true,
      }
    : {
        roomId,
        serverKey,
        token,
        name: name || fallbackName(list),
        addedAt: now,
        lastUsedAt: 0,
        hostServer: true,
      };
  if (existing && JSON.stringify(next) === JSON.stringify(existing)) return;
  write(existing ? list.map((p) => (p === existing ? next : p)) : [...list, next]);
}

/** Mark `roomId` the last used, so the next load opens it. */
export function selectPairing(roomId: string, now: number = Date.now()): void {
  const list = listPairings();
  if (!list.some((p) => p.roomId === roomId)) return;
  write(list.map((p) => (p.roomId === roomId ? { ...p, lastUsedAt: now } : p)));
}

/** `roomId`'s pairing with `change` made, unless that changes nothing. */
function updatePairing(
  roomId: string,
  change: (current: StoredPairing) => StoredPairing,
): void {
  const list = listPairings();
  const current = list.find((p) => p.roomId === roomId);
  if (!current) return;
  const next = change(current);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  write(list.map((p) => (p === current ? next : p)));
}

/** The user's own name for `roomId`'s host, which a hello no longer replaces. */
export function renamePairing(roomId: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  updatePairing(roomId, (p) => ({ ...p, name: trimmed, customName: true }));
}

/**
 * What `roomId`'s hello said: the host's own name (shown unless the user
 * named it) and whether it is a host server.
 */
export function recordPairingHello(
  roomId: string,
  hello: { hostName: string | null; hostServer: boolean },
): void {
  const name = hello.hostName?.trim();
  updatePairing(roomId, (p) => ({
    ...p,
    name: name && !p.customName ? name : p.name,
    hostServer: hello.hostServer,
  }));
}

/** A desktop's remote hosts and their rooms, as its `hosts.list` said. */
export function recordPairingHosts(
  roomId: string,
  hosts: Record<string, string | null>,
): void {
  updatePairing(roomId, (p) => ({ ...p, hosts }));
}

/**
 * Drop the pairing with exactly these credentials. A stale tab refused by
 * the host must not erase a newer link another tab took for the same room.
 */
export function removePairing(credentials: RelayCredentials): boolean {
  const list = listPairings();
  const next = list.filter(
    (p) =>
      !(
        p.roomId === credentials.roomId &&
        p.serverKey === credentials.serverKey &&
        p.token === credentials.token
      ),
  );
  if (next.length === list.length) return false;
  write(next);
  return true;
}

/**
 * The user removed `credentials`' pairing: drop it (as `removePairing`) and
 * remember the room as declined, so a desktop's `linkHostPairings` does not
 * hand it back (ADR-228 D9). The declined list is written first, so a
 * subscriber notified of the removal already sees the room declined.
 */
export function declinePairing(credentials: RelayCredentials): void {
  // A stale tab's removal finds no such pairing, and declines nothing either.
  const exists = listPairings().some(
    (p) =>
      p.roomId === credentials.roomId &&
      p.serverKey === credentials.serverKey &&
      p.token === credentials.token,
  );
  if (!exists) return;
  const declined = declinedRooms().filter((room) => room !== credentials.roomId);
  declined.push(credentials.roomId);
  storageSet(DECLINED_KEY, JSON.stringify(declined.slice(-MAX_DECLINED)));
  removePairing(credentials);
}

const NO_ROOMS: readonly string[] = [];
/** The parsed declined list for `useSyncExternalStore`: stable until it changes. */
let declinedSnapshot: { raw: string | null; list: readonly string[] } = {
  raw: null,
  list: NO_ROOMS,
};

/** Rooms this browser has let go of, which no desktop should mint again. */
export function declinedRooms(): readonly string[] {
  const raw = storageGet(DECLINED_KEY);
  if (raw === declinedSnapshot.raw) return declinedSnapshot.list;
  let list = NO_ROOMS;
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        list = parsed.filter((room): room is string => typeof room === "string");
      }
    } catch {
      // Unreadable: nothing is declined.
    }
  }
  declinedSnapshot = { raw, list };
  return list;
}

/** A fresh link for `roomId`: it is no longer declined. */
function undeclineRoom(roomId: string): void {
  const declined = declinedRooms();
  if (!declined.includes(roomId)) return;
  const next = declined.filter((room) => room !== roomId);
  if (next.length === 0) storageRemove(DECLINED_KEY);
  else storageSet(DECLINED_KEY, JSON.stringify(next));
  notify();
}

let relinker: (() => Promise<void>) | null = null;

/** Called by `install-web.ts` with what asks each desktop to link its hosts. */
export function registerRelink(fn: () => Promise<void>): void {
  relinker = fn;
}

/**
 * The user asked for `roomId`'s host directly, though this browser let it go
 * (`declinedRooms`) — removed by hand. It is no longer declined, and each reachable
 * desktop is asked to mint this browser a pairing there now. Resolves once
 * they have answered.
 */
export async function connectRoomDirectly(roomId: string): Promise<void> {
  undeclineRoom(roomId);
  await relinker?.();
}

export function subscribePairings(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === PAIRINGS_KEY || e.key === DECLINED_KEY) cb();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
