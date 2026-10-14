/**
 * `window.electronAPI`, installed as a side effect of being imported — the
 * web half of the invariant `install-desktop.ts` states and holds for the
 * desktop: **no store module may evaluate before `window.electronAPI`
 * exists.** Imported first by `web-main.tsx`, before `./App`, for the same
 * reason `install-desktop.ts`'s header spells out: the stores reach for
 * `window.electronAPI` at module scope, inside `create()`'s initializer, and
 * ES module evaluation runs every static import of a module before the first
 * statement of the module itself — so a `web-main.tsx` that imported `./App`
 * and only then built the bridge would run every one of those calls against a
 * `window.electronAPI` that does not exist yet. Every one of those calls is
 * written `window.electronAPI?.…`, so none of them would throw: they would
 * silently never run, and a browser tab would come up with no preferences, no
 * theme and no agent updates until something else happened to re-read them.
 *
 * The complication the desktop does not have: this bridge needs the pairing
 * token, which lives in the URL fragment on first load and in
 * `localStorage` after, and `web-main.tsx` still owns the decision to render
 * `NoTokenScreen` / `KeyMismatchScreen` instead of `<App />` — a decision that
 * cannot move into a side-effect module because it is what to *render*, not
 * a side effect. So this module reads the token and exports it, and turns
 * `onUnauthorized` / `onKeyMismatch` into a tiny outcome `web-main.tsx` asks
 * for once it is ready to act on it — late, if the socket has not said
 * anything yet, or immediately, if it already has.
 *
 * The page is served only by the relay origin (ADR-206, ADR-207 D2): paired
 * by a `#relay=…` link, it dials the relay's `/join/<roomId>` through a Noise
 * channel. `./web-pairing.ts` reads the link; this module builds the pipes,
 * reports reachability (relay 4404/4429) and follows the version redirect.
 *
 * **Every pairing at once** (ADR-228 D8). The page holds one relay bridge per
 * stored pairing, each a server in the page's set (`./server-set.ts`) under
 * its room id, and installs the router over them (`./router.ts`):
 *
 * - **Home** is the paired desktop (a hello with `hostServer: false`), else
 *   the most recently used pairing (`homePairing`). A desktop's hello moves
 *   home to it, if home was not a desktop already.
 * - **A desktop's remote hosts** are named by the rooms its `hosts.list`
 *   reports (D2), and listed as its (D3): a host with a pairing of its own is
 *   answered by that pairing while it is reachable, else by the desktop.
 * - **4401** forgets only that pairing and takes its server out of the set;
 *   the pairing screen shows only once no pairing is left. Likewise
 *   key-mismatch: its screen shows once every pairing has been refused.
 * - **The version redirect** follows the home server only. Another server on
 *   another version stays in the set, its version recorded.
 * - **The list is followed.** A pairing removed in the Hosts sheet leaves the
 *   set; one added in another tab (or by a later link) joins it.
 *
 * Each server's last merged answers are kept in IndexedDB (`./last-known.ts`),
 * so a reload with a server away still shows what it last said (D6).
 */

import type { HostStatusInfo } from "../store/host-store";
import { LOCAL_HOST_ID } from "../lib/workspace-key";
import { createLastKnownStore } from "./last-known";
import {
  decodeX25519,
  homePairing,
  listPairings,
  recordPairingHello,
  recordPairingHosts,
  subscribePairings,
  type StoredPairing,
} from "./pairings";
import { emitBridgeResync, registerRefresh } from "./resync";
import { createRouter } from "./router";
import {
  servers,
  subscribeSelected,
  viaServer,
  type BridgeOutcome,
  type Reachability,
} from "./server-set";
import { relayJoinUrl, relayPipe } from "./transports/relay-pipe";
import {
  createWsTransport,
  type HelloReply,
  type Pipe,
  type WsBridgeTransport,
} from "./transports/ws";
import {
  forgetPairing,
  readPairing,
  versionRedirectTarget,
} from "./web-pairing";

/** One pairing the page holds a bridge for. */
interface Held {
  pairing: StoredPairing;
  transport: WsBridgeTransport;
  /** What its hellos said it is, or null before one (and none stored). */
  kind: "desktop" | "host" | null;
  /**
   * Whether its next hello re-fetches: it joined after the stores' boot
   * fetches, or a dial failed before it answered — either way the stores
   * have not heard from it.
   */
  needsResync: boolean;
  /** Stops following a desktop's `hosts.onStatusChanged`. */
  stopHosts: (() => void) | null;
}

/** The pairings the page holds, by room. */
const held = new Map<string, Held>();

/** A stored pairing whose key no longer decodes is no pairing at all. */
function dialable(): StoredPairing[] {
  return listPairings().filter((p) => decodeX25519(p.serverKey) !== null);
}

readPairing();
const atBoot = dialable();
const homeAtBoot = homePairing(atBoot);

/** A pairing token this tab dials with, or `null` for none found. */
export const webToken: string | null = homeAtBoot?.token ?? null;

/**
 * Unpaired: the transport never dials (its token is null), so this is never
 * connected. It exists only so there is always a home server to hand over.
 */
const UNPAIRED_PIPE: Pipe = {
  connect() {
    throw new Error("This browser is not paired with Manor");
  },
};

/** What the socket has said about `webToken`, once it has said anything. */
export type { BridgeOutcome };

/** The page's refusal: home's, once every pairing has been refused. */
function pageOutcome(): BridgeOutcome | null {
  if (held.size === 0) return null;
  for (const roomId of held.keys()) {
    if (servers.facts(roomId).outcome === null) return null;
  }
  return servers.facts(servers.homeId).outcome;
}

/**
 * `web-main.tsx`'s hook onto a refusal that may already have happened by the
 * time it calls this — the hello round-trip can beat `loadTerminalFonts()`
 * on a fast local connection — or may not happen until later. Either way
 * `cb` runs exactly once, with whichever refusal arrives first.
 */
export function onBridgeOutcome(cb: (outcome: BridgeOutcome) => void): void {
  const now = pageOutcome();
  if (now) {
    cb(now);
    return;
  }
  const off = subscribeSelected(servers, pageOutcome, () => {
    const next = pageOutcome();
    if (!next) return;
    off();
    cb(next);
  });
}

/**
 * Whether the page can reach anything right now, for the "not reachable"
 * overlay: `connected` while any pairing is, `unreachable` once every one is
 * (each dial keeps retrying), else `unknown`. Shaped for
 * `useSyncExternalStore`. One server's own reachability is its entry's.
 */
export type { Reachability };

export function getReachability(): Reachability {
  if (held.size === 0) return servers.facts(servers.homeId).reachability;
  let unknown = false;
  for (const roomId of held.keys()) {
    const reachability = servers.facts(roomId).reachability;
    if (reachability === "connected") return "connected";
    if (reachability === "unknown") unknown = true;
  }
  return unknown ? "unknown" : "unreachable";
}

export function subscribeReachability(cb: () => void): () => void {
  return subscribeSelected(servers, getReachability, cb);
}

/** How long a refresh waits for a redial's hello and its resync. */
const REFRESH_REDIAL_TIMEOUT_MS = 10_000;

/** Refreshes waiting on the next hello, handed that hello's resync. */
const helloWaiters: ((resynced: Promise<void>) => void)[] = [];

/**
 * The next hello's resync settling — true — or `timeoutMs` passing — false
 * — whichever is first.
 */
function nextHelloResync(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const waiter = (resynced: Promise<void>): void => {
      void resynced.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    };
    const timer = setTimeout(() => {
      const at = helloWaiters.indexOf(waiter);
      if (at !== -1) helloWaiters.splice(at, 1);
      resolve(false);
    }, timeoutMs);
    helloWaiters.push(waiter);
  });
}

// ── home ──

/**
 * Who should be home among the pairings held now, skipping refused ones:
 * a desktop first, then the most recently used.
 */
function bestHome(except?: string): string | null {
  const candidates = [...held.values()].filter(
    (h) => h.pairing.roomId !== except && servers.facts(h.pairing.roomId).outcome === null,
  );
  const best = homePairing(
    candidates.map((h) => ({
      ...h.pairing,
      hostServer: h.kind === null ? h.pairing.hostServer : h.kind === "host",
    })),
  );
  return best?.roomId ?? null;
}

/**
 * Make `roomId` home. Every home-answered store (preferences, the selected
 * project, …) re-reads from it, and its version is the one the page follows.
 */
function moveHome(roomId: string): void {
  if (servers.homeId === roomId) return;
  servers.setHome(roomId);
  const hello = servers.facts(roomId).hello;
  if (followVersion(hello.version)) return;
  void emitBridgeResync();
}

/** Go to the build of `version`, if it is not this one. True when leaving. */
function followVersion(version: string | null): boolean {
  const target = versionRedirectTarget(__APP_VERSION__, version);
  if (!target) return false;
  location.replace(target);
  return true;
}

// ── a desktop's hosts (D2, D3) ──

/**
 * Name and list a desktop's remote hosts: `hosts` is its id for each → the
 * room that host's server reported, or null.
 */
function applyHosts(roomId: string, hosts: Record<string, string | null>): boolean {
  const before = servers.facts(roomId).aliases;
  const aliases = Object.entries(hosts).map(
    ([hostId, room]) => [hostId, room ?? viaServer(roomId, hostId)] as const,
  );
  servers.setAliases(roomId, aliases);
  servers.setLists(roomId, aliases.map(([, alias]) => alias));
  return servers.facts(roomId).aliases !== before;
}

/** A desktop's `hosts.list`, as the room each one goes by. */
function hostRooms(
  roomId: string,
  list: readonly HostStatusInfo[],
): Record<string, string | null> {
  const known = held.get(roomId)?.pairing.hosts ?? {};
  const out: Record<string, string | null> = {};
  for (const host of list) {
    if (host.hostId === LOCAL_HOST_ID) continue;
    // Absent until the desktop has read the host's status: keep what it said.
    out[host.hostId] = host.roomId === undefined ? (known[host.hostId] ?? null) : host.roomId;
  }
  return out;
}

/** Follow desktop `roomId`'s hosts: listed now, and as they change. */
function watchHosts(entry: Held): void {
  const { roomId } = entry.pairing;
  const bridge = servers.get(roomId)?.bridge;
  if (!bridge) return;
  const apply = (list: readonly HostStatusInfo[]): void => {
    if (held.get(roomId) !== entry || !Array.isArray(list)) return;
    const hosts = hostRooms(roomId, list);
    recordPairingHosts(roomId, hosts);
    // A host now goes by another name: the stores re-read in it.
    if (applyHosts(roomId, hosts)) void emitBridgeResync(roomId);
  };
  entry.stopHosts ??= bridge.hosts.onStatusChanged(apply);
  void bridge.hosts.list().then(apply, () => {});
}

// ── each pairing ──

function onHello(entry: Held, reply: HelloReply): void {
  const { roomId } = entry.pairing;
  if (held.get(roomId) !== entry) return;
  servers.recordHello(roomId, reply);
  servers.setReachability(roomId, "connected");
  recordPairingHello(roomId, reply);
  entry.kind = reply.hostServer ? "host" : "desktop";
  if (entry.kind === "desktop") watchHosts(entry);

  const home = held.get(servers.homeId);
  const rehome = entry.kind === "desktop" && home !== entry && home?.kind !== "desktop";
  if (rehome) {
    servers.setHome(roomId);
  }
  // The version redirect is home's alone; anyone else's is just recorded.
  if (servers.homeId === roomId && followVersion(reply.appVersion)) return;

  // The first hello of a server the stores booted with is the cold start
  // their boot fetches cover; a resumed one is a reconnect after which pushes
  // may have been missed, and one that joined later has not been read at all
  // (ADR-220 D1). A new home re-reads everything home answers.
  let resynced = Promise.resolve();
  if (rehome) resynced = emitBridgeResync();
  else if (reply.resumed || entry.needsResync) resynced = emitBridgeResync(roomId);
  entry.needsResync = false;
  for (const waiter of helloWaiters.splice(0)) waiter(resynced);
}

/** Refused: 4401 (the pairing is dead) or key-mismatch (it may not be). */
function refuse(entry: Held, outcome: BridgeOutcome): void {
  const { roomId } = entry.pairing;
  if (held.get(roomId) !== entry) return;
  if (outcome === "unauthorized") {
    // The token was revoked, the host forgot it, or the host's key is no
    // longer the one this page was paired with. Drop it — only it — and its
    // server, rather than reconnecting forever against an answer that will
    // not change. The last one left stays, for `web-main` to say so.
    if (held.size === 1) servers.setOutcome(roomId, outcome);
    forgetPairing(entry.pairing);
    if (held.size > 1) {
      drop(roomId);
      return;
    }
  }
  // Repeated bad Noise message 2s: the host's relay address was reset. The
  // pairing is kept (this may just be a stale tab); its transport has
  // stopped, and the screen offers a reload once nothing else answers.
  servers.setOutcome(roomId, outcome);
  if (servers.homeId === roomId) {
    const next = bestHome(roomId);
    if (next) moveHome(next);
  }
}

/** Hold a bridge to `pairing`'s room. */
function open(pairing: StoredPairing, options: { home?: boolean; joined: boolean }): void {
  const { roomId } = pairing;
  const serverKey = decodeX25519(pairing.serverKey);
  if (serverKey === null) return;
  const hooks = servers.hooks(roomId);
  const entry: Held = {
    pairing,
    transport: null as unknown as WsBridgeTransport,
    kind: pairing.hostServer === undefined ? null : pairing.hostServer ? "host" : "desktop",
    needsResync: options.joined,
    stopHosts: null,
  };
  entry.transport = createWsTransport({
    token: pairing.token,
    pipe: relayPipe({ url: relayJoinUrl(roomId), serverKey }),
    onUnauthorized: () => refuse(entry, "unauthorized"),
    onKeyMismatch: () => refuse(entry, "key-mismatch"),
    onStatus: (status) => {
      if (held.get(roomId) !== entry) return;
      if (status === "unreachable") entry.needsResync = true;
      hooks.onStatus(status);
    },
    onHello: (reply) => onHello(entry, reply),
  });
  held.set(roomId, entry);
  servers.add(roomId, entry.transport, { home: options.home, roomId });
  applyHosts(roomId, pairing.hosts ?? {});
  if (options.joined) entry.transport.start();
}

/** Let go of `roomId`'s bridge: the set, the stores and the transport. */
function drop(roomId: string): void {
  const entry = held.get(roomId);
  if (!entry || held.size === 1) return;
  if (servers.homeId === roomId) {
    const next = bestHome(roomId) ?? [...held.keys()].find((id) => id !== roomId);
    if (next) moveHome(next);
  }
  held.delete(roomId);
  servers.remove(roomId);
  entry.stopHosts?.();
  entry.transport.close();
  // Its projects, agents and layouts leave the merged stores.
  void emitBridgeResync();
}

/** Follow the stored list: removed pairings leave, new ones join. */
function syncPairings(): void {
  const stored = dialable();
  if (stored.length === 0) {
    // The last pairing was removed — unless refused, which `web-main` is
    // already saying — and there is nothing left to show.
    if (pageOutcome() === null) location.reload();
    return;
  }
  for (const pairing of stored) {
    const entry = held.get(pairing.roomId);
    if (!entry) {
      open(pairing, { joined: true });
    } else if (
      entry.pairing.token !== pairing.token ||
      entry.pairing.serverKey !== pairing.serverKey
    ) {
      // A newer link for the same room: dial with it instead.
      entry.stopHosts?.();
      entry.transport.close();
      held.delete(pairing.roomId);
      open(pairing, { joined: true });
    } else {
      entry.pairing = pairing;
    }
  }
  for (const roomId of [...held.keys()]) {
    if (!stored.some((p) => p.roomId === roomId)) drop(roomId);
  }
}

/**
 * "Try again now" on the not-reachable overlay, and a phone that comes back
 * — unlocked, switched back to, restored from the back-forward cache, or back
 * on a network: dial now rather than sitting out a backoff that grew to 30s
 * while it was away, and probe a socket that still looks open, since iOS
 * often kills a backgrounded one without a close event.
 */
export function retryBridgeNow(): void {
  for (const entry of held.values()) void entry.transport.probeNow();
}
window.addEventListener("online", retryBridgeNow);
window.addEventListener("pageshow", retryBridgeNow);
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") retryBridgeNow();
  });
}

/**
 * The manual refresh (ADR-220 D5): probe every line, and re-fetch everything
 * over them if they are alive. A line that is not is redialling, and the
 * hello that ends that emits the resync itself; this waits for it (or a
 * redial that takes too long), then re-fetches over the live ones if that
 * hello never came. Resolves once the stores have re-fetched.
 */
export async function refreshBridge(): Promise<void> {
  const outcomes = await Promise.all(
    [...held.values()].map((entry) => entry.transport.probeNow()),
  );
  const alive = outcomes.includes("alive");
  if (outcomes.includes("redialing")) {
    const resynced = await nextHelloResync(REFRESH_REDIAL_TIMEOUT_MS);
    if (!resynced && alive) await emitBridgeResync();
  } else if (alive) {
    await emitBridgeResync();
  }
}
registerRefresh(refreshBridge);

if (homeAtBoot === null) {
  servers.add(
    LOCAL_HOST_ID,
    createWsTransport({ token: null, pipe: UNPAIRED_PIPE }),
    { home: true, lists: "all" },
  );
  window.electronAPI = createRouter(servers);
} else {
  open(homeAtBoot, { home: true, joined: false });
  for (const pairing of atBoot) {
    if (pairing.roomId !== homeAtBoot.roomId) open(pairing, { joined: false });
  }
  subscribePairings(syncPairings);
  window.electronAPI = createRouter(servers, undefined, {
    lastKnown: createLastKnownStore(),
  });
}
