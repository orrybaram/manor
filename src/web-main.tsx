import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { loadTerminalFonts } from "./lib/terminal-font";
import { createStubBridge } from "./web/stub-bridge";

/**
 * The web app's entry (ADR-178 D1): the desktop renderer, served to a
 * browser at `/app` instead of run inside Electron. Built by
 * `vite.web.config.ts`; unauthenticated at the HTTP layer, the same trade
 * `electron/remote-control/static.ts` documents for the remote client — the
 * pairing token rides in the URL fragment, which browsers never send to a
 * server, so the page has to load before it can authenticate anything.
 *
 * Deliberately not `src/main.tsx` with a flag: that file also boots
 * `DetachedApp` for popup windows (ADR-156), which has no meaning in a
 * browser tab, and it reads `window.electronAPI` as something the preload
 * script already installed — here this module has to install it first.
 */

/**
 * Distinct from the remote client's `manor.remote.token` key (see
 * `src/remote-client/main.ts`): the two are separate bundles, separate
 * paired devices, and a shared key would let one client silently clobber the
 * other's stored token.
 */
const TOKEN_KEY = "manor.web.token";

/**
 * Take the token out of the URL fragment on first load, store it, and strip
 * it from the address bar so it cannot linger in history or a screenshot.
 * Copied from `src/remote-client/main.ts`'s `readToken` rather than shared —
 * the remote client is its own bundle, built by a different Vite config, and
 * cannot be imported from here.
 */
function readToken(): string | null {
  const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (fragment) {
    try {
      localStorage.setItem(TOKEN_KEY, fragment);
    } catch {
      // Private mode: keep it in memory for this load only.
    }
    history.replaceState(null, "", location.pathname + location.search);
    return fragment;
  }
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Forget a revoked or invalid token. Unused until ticket 4's bridge can
 * detect a 401 over `/ws` and call it — kept here now so the pair this
 * module copies from `remote-client/main.ts` stays a pair, not a half.
 */
export function forgetToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** "Open the link from the pairing dialog" — the whole screen, deliberately. */
function NoTokenScreen(): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        fontFamily: "system-ui, sans-serif",
        color: "#ccc",
        background: "#1e1e2e",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      This device isn&apos;t paired. Open the link from the pairing dialog in
      Manor &rarr; Settings &rarr; Remote control.
    </div>
  );
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

// Ticket 4 replaces this with `createWsBridge({ token })` from
// `src/web/ws-bridge.ts` — same shape, so this is the only line that changes.
window.electronAPI = createStubBridge({ token });

// Before anything renders, same as `main.tsx`: a pane that mounts ahead of
// the webfont measures its cell from the fallback and keeps the wrong size.
await loadTerminalFonts();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {token ? (
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    ) : (
      <NoTokenScreen />
    )}
  </React.StrictMode>,
);
