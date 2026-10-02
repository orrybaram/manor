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
import { relayJoinUrl, relayPipe } from "./transports/relay-pipe";
import { createWsTransport, type Pipe } from "./transports/ws";
import {
  forgetPairing,
  readPairing,
  serverKeyBytes,
  versionRedirectTarget,
} from "./web-pairing";

const pairing = readPairing();

/**
 * The relay pipe, or null with no pairing. A stored key that no longer
 * decodes is treated as no pairing at all.
 */
function relayPipeFor(): Pipe | null {
  if (pairing === null) return null;
  const serverKey = serverKeyBytes(pairing);
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
  onHello: ({ appVersion }) => {
    const target = versionRedirectTarget(__APP_VERSION__, appVersion);
    if (target) location.replace(target);
  },
});

/** "Try again now" on the not-reachable overlay: skip the backoff wait. */
export function retryBridgeNow(): void {
  transport.retryNow();
}

window.electronAPI = createBridge(transport);
