import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { loadTerminalFonts } from "./lib/terminal-font";
import { createBridge } from "./bridge/client";
import {
  bridgeUrlFromLocation,
  createWsTransport,
  forgetWebToken,
  WEB_TOKEN_KEY,
} from "./bridge/transports/ws";
import { NoTokenScreen, ForbiddenScreen } from "./web/screens";

/**
 * The web app's entry (ADR-178 D1): the desktop renderer, served to a
 * browser at `/app` instead of run inside Electron. Built by
 * `vite.web.config.ts`; unauthenticated at the HTTP layer, the same trade
 * `electron/remote-control/static.ts` documents for the remote client — the
 * pairing token rides in the URL fragment, which browsers never send to a
 * server, so the page has to load before it can authenticate anything.
 *
 * Deliberately not `src/main.tsx` with a flag: that file reads
 * `window.electronAPI` as something the preload script already installed —
 * here this module has to install it first.
 */

/**
 * Take the token out of the URL fragment on first load, store it, and strip
 * it from the address bar so it cannot linger in history or a screenshot.
 * Copied from `src/remote-client/main.ts`'s `readToken` rather than shared —
 * the remote client is its own bundle, built by a different Vite config, and
 * cannot be imported from here. The key itself lives in `bridge/transports/ws.ts`, which
 * is the half of this pair that finds out when a token has died.
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2, // 2 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes
      refetchOnWindowFocus: false,
    },
  },
});

const token = readToken();
const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
);

function show(screen: React.ReactNode): void {
  root.render(<React.StrictMode>{screen}</React.StrictMode>);
}

/**
 * Whether the bridge has already decided this tab never gets `<App />`.
 *
 * `onUnauthorized`/`onForbidden` can fire before the `show()` below does —
 * the socket's hello round-trip races `loadTerminalFonts()`, and a fast
 * local connection (or, since ADR-179, the earlier `layout.onChanged`
 * subscribe below) can easily win. Without this flag the unconditional
 * `show()` after the await stomps right back over whichever refusal screen
 * just rendered, and `<App />` (or a blank `NoTokenScreen`) briefly shows
 * for a device that was just told no.
 */
let settled = false;

/**
 * Installed before anything renders: the 66 files that call
 * `window.electronAPI` do so from their first effect, and the bridge is what
 * they find there. It dials lazily, so nothing here races the first paint.
 */
window.electronAPI = createBridge(
  createWsTransport({
    token,
    url: bridgeUrlFromLocation(),
    onUnauthorized: () => {
      // The token was revoked, or the host forgot it. Drop it and start over
      // rather than reconnecting forever against an answer that will not
      // change.
      settled = true;
      forgetWebToken();
      show(<NoTokenScreen />);
    },
    onForbidden: () => {
      settled = true;
      show(<ForbiddenScreen />);
    },
  }),
);

await loadTerminalFonts();

if (!settled) {
  show(
    token ? (
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    ) : (
      <NoTokenScreen />
    ),
  );
}
