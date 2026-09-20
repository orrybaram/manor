/**
 * `window.electronAPI`, installed as a side effect of being imported — the
 * web half of the invariant `install-desktop.ts` states and holds for the
 * desktop: **no store module may evaluate before `window.electronAPI`
 * exists.** Imported first by `web-main.tsx`, before `./App`, for the same
 * reason that file's header spelled out (ADR-180 ticket 14 fixed the bug it
 * described but had not yet fixed): the stores reach for `window.electronAPI`
 * at module scope, inside `create()`'s initializer, and ES module evaluation
 * runs every static import of a module before the first statement of the
 * module itself — so a `web-main.tsx` that imported `./App` and only then
 * built the bridge ran every one of those calls against a
 * `window.electronAPI` that did not exist yet. Every one of those calls is
 * written `window.electronAPI?.…`, so none of them threw: they silently
 * never ran, and a browser tab came up with no preferences, no theme and no
 * agent updates until something else happened to re-read them.
 *
 * The complication the desktop does not have: this bridge needs the pairing
 * token, which lives in the URL fragment on first load and in
 * `localStorage` after, and `web-main.tsx` still owns the decision to render
 * `NoTokenScreen` / `ForbiddenScreen` instead of `<App />` — a decision that
 * cannot move into a side-effect module because it is what to *render*, not
 * a side effect. So this module reads the token and exports it, and turns
 * `onUnauthorized` / `onForbidden` into a tiny outcome `web-main.tsx` asks
 * for once it is ready to act on it — late, if the socket has not said
 * anything yet, or immediately, if it already has.
 */

import { createBridge } from "./client";
import {
  bridgeUrlFromLocation,
  createWsTransport,
  forgetWebToken,
  WEB_TOKEN_KEY,
} from "./transports/ws";

/**
 * Take the token out of the URL fragment on first load, store it, and strip
 * it from the address bar so it cannot linger in history or a screenshot.
 * Copied from `src/remote-client/main.ts`'s `readToken` rather than shared —
 * the remote client is its own bundle, built by a different Vite config, and
 * cannot be imported from here. The key itself lives in
 * `bridge/transports/ws.ts`, which is the half of this pair that finds out
 * when a token has died.
 */
function readToken(): string | null {
  const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (fragment) {
    try {
      localStorage.setItem(WEB_TOKEN_KEY, fragment);
    } catch {
      // Storage denied (private browsing): this session still works, the
      // next reload asks for the link again.
    }
    history.replaceState(null, "", location.pathname + location.search);
    return fragment;
  }
  try {
    return localStorage.getItem(WEB_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** The pairing token this tab is dialling with, or `null` for none found. */
export const webToken: string | null = readToken();

/** What the socket has said about `webToken`, once it has said anything. */
export type BridgeOutcome = "unauthorized" | "forbidden";

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

window.electronAPI = createBridge(
  createWsTransport({
    token: webToken,
    url: bridgeUrlFromLocation(),
    onUnauthorized: () => {
      // The token was revoked, or the host forgot it. Drop it — `web-main`
      // renders `NoTokenScreen` rather than reconnecting forever against an
      // answer that will not change.
      forgetWebToken();
      settle("unauthorized");
    },
    onForbidden: () => settle("forbidden"),
  }),
);
