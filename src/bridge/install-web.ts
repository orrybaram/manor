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
 * channel. `./web-pairing.ts` reads the link; this module builds the pipe,
 * reports reachability (relay 4404/4429) and follows the version redirect.
 */

import { createBridge } from "./client";
import { recordHello, setActiveRoom } from "./connection";
import { decodeX25519, renamePairing } from "./pairings";
import { emitBridgeResync, registerRefresh } from "./resync";
import { relayJoinUrl, relayPipe } from "./transports/relay-pipe";
import { createWsTransport, type Pipe } from "./transports/ws";
import {
  forgetPairing,
  readPairing,
  versionRedirectTarget,
} from "./web-pairing";

const pairing = readPairing();

/**
 * The relay pipe, or null with no pairing. A stored key that no longer
 * decodes is treated as no pairing at all.
 */
function relayPipeFor(): Pipe | null {
  if (pairing === null) return null;
  const serverKey = decodeX25519(pairing.serverKey);
  if (serverKey === null) return null;
  return relayPipe({ url: relayJoinUrl(pairing.roomId), serverKey });
}

const pipe = relayPipeFor();

/**
 * Unpaired: the transport never dials (its token is null), so this is never
 * connected. It exists only so there is always a pipe to hand over.
 */
const UNPAIRED_PIPE: Pipe = {
  connect() {
    throw new Error("This browser is not paired with Manor");
  },
};

/** The pairing token this tab is dialling with, or `null` for none found. */
export const webToken: string | null = pipe && pairing ? pairing.token : null;

/** The room this tab dials, or `null` when unpaired. */
const webRoomId: string | null = pipe && pairing ? pairing.roomId : null;

setActiveRoom(webRoomId);

/** What the socket has said about `webToken`, once it has said anything. */
export type BridgeOutcome = "unauthorized" | "key-mismatch";

let outcome: BridgeOutcome | null = null;
let listener: ((outcome: BridgeOutcome) => void) | null = null;

function settle(next: BridgeOutcome): void {
  outcome = next;
  listener?.(next);
}

/**
 * `web-main.tsx`'s hook onto a refusal that may already have happened by the
 * time it calls this — the hello round-trip can beat `loadTerminalFonts()`
 * on a fast local connection — or may not happen until later. Either way
 * `cb` runs exactly once, with whichever refusal arrives first.
 */
export function onBridgeOutcome(cb: (outcome: BridgeOutcome) => void): void {
  listener = cb;
  if (outcome) cb(outcome);
}

/**
 * Whether the host can be reached right now, for the "not reachable"
 * overlay. Unlike a refusal this comes and goes: `unreachable` on a relay
 * 4404/4429 (the dial keeps retrying), `connected` on the next hello. Shaped
 * for `useSyncExternalStore`.
 */
export type Reachability = "unknown" | "connected" | "unreachable";

let reachability: Reachability = "unknown";
const reachabilityListeners = new Set<() => void>();

export function getReachability(): Reachability {
  return reachability;
}

export function subscribeReachability(cb: () => void): () => void {
  reachabilityListeners.add(cb);
  return () => reachabilityListeners.delete(cb);
}

function setReachability(next: Reachability): void {
  if (next === reachability) return;
  reachability = next;
  for (const cb of [...reachabilityListeners]) cb();
}

/** How long a refresh waits for a redial's hello and its resync. */
const REFRESH_REDIAL_TIMEOUT_MS = 10_000;

/** Refreshes waiting on the next hello, handed that hello's resync. */
const helloWaiters: ((resynced: Promise<void>) => void)[] = [];

/** The next hello's resync settling, or `timeoutMs`, whichever is first. */
function nextHelloResync(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const waiter = (resynced: Promise<void>): void => {
      void resynced.then(() => {
        clearTimeout(timer);
        resolve();
      });
    };
    const timer = setTimeout(() => {
      const at = helloWaiters.indexOf(waiter);
      if (at !== -1) helloWaiters.splice(at, 1);
      resolve();
    }, timeoutMs);
    helloWaiters.push(waiter);
  });
}

const transport = createWsTransport({
  token: webToken,
  pipe: pipe ?? UNPAIRED_PIPE,
  onUnauthorized: () => {
    // The token was revoked, the host forgot it, or the desktop's key is
    // no longer the one this page was paired with. Drop it —
    // `web-main` renders `NoTokenScreen` rather than reconnecting forever
    // against an answer that will not change.
    forgetPairing(pairing);
    settle("unauthorized");
  },
  // Repeated bad Noise message 2s: the desktop's relay address was reset.
  // The pairing is kept (this may just be a stale tab); the transport has
  // stopped, so the screen offers a reload rather than a redial.
  onKeyMismatch: () => settle("key-mismatch"),
  onStatus: setReachability,
  onHello: ({ appVersion, resumed, hostName, hostServer }) => {
    // The host names itself (ADR-225 D7) so the switcher shows the name
    // instead of "Host N"; `hostServer` alone says it is a host server.
    recordHello({ hostName, hostServer });
    if (webRoomId && hostName) renamePairing(webRoomId, hostName);
    const target = versionRedirectTarget(__APP_VERSION__, appVersion);
    if (target) {
      // This page is going away; nothing here needs to re-fetch.
      location.replace(target);
      return;
    }
    // The first hello is the cold start the stores' boot fetches already
    // cover; a resumed one is a reconnect after which pushes may have been
    // missed, so the stores re-fetch (ADR-220 D1).
    const resynced = resumed ? emitBridgeResync() : Promise.resolve();
    for (const waiter of helloWaiters.splice(0)) waiter(resynced);
  },
});

/**
 * "Try again now" on the not-reachable overlay, and a phone that comes back
 * — unlocked, switched back to, restored from the back-forward cache, or back
 * on a network: dial now rather than sitting out a backoff that grew to 30s
 * while it was away, and probe a socket that still looks open, since iOS
 * often kills a backgrounded one without a close event.
 */
export function retryBridgeNow(): void {
  void transport.probeNow();
}
window.addEventListener("online", retryBridgeNow);
window.addEventListener("pageshow", retryBridgeNow);
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") retryBridgeNow();
  });
}

/**
 * The manual refresh (ADR-220 D5): probe the line, and re-fetch everything
 * over it if it is alive. If it is not, the transport is redialling, and the
 * hello that ends that emits the resync itself; either way this resolves once
 * the stores have re-fetched (or the redial took too long to wait on).
 */
export async function refreshBridge(): Promise<void> {
  const outcome = await transport.probeNow();
  if (outcome === "alive") await emitBridgeResync();
  else if (outcome === "redialing") {
    await nextHelloResync(REFRESH_REDIAL_TIMEOUT_MS);
  }
}
registerRefresh(refreshBridge);

window.electronAPI = createBridge(transport);
