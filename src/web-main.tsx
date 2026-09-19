import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { loadTerminalFonts } from "./lib/terminal-font";
import {
  bridgeUrlFromLocation,
  createWsBridge,
  forgetWebToken,
  WEB_TOKEN_KEY,
} from "./web/ws-bridge";

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
 * Take the token out of the URL fragment on first load, store it, and strip
 * it from the address bar so it cannot linger in history or a screenshot.
 * Copied from `src/remote-client/main.ts`'s `readToken` rather than shared —
 * the remote client is its own bundle, built by a different Vite config, and
 * cannot be imported from here. The key itself lives in `ws-bridge.ts`, which
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

/** One message, centred, on nothing. Every dead end here renders as one. */
function FullPageMessage(props: {
  children: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <div
      data-testid={props.testId}
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
      {props.children}
    </div>
  );
}

/** "Open the link from the pairing dialog" — the whole screen, deliberately. */
function NoTokenScreen(): React.JSX.Element {
  return (
    <FullPageMessage testId="web-app-no-token">
      This device isn&apos;t paired. Open the link from the pairing dialog in
      Manor &rarr; Settings &rarr; Remote control.
    </FullPageMessage>
  );
}

/**
 * Paired, but below `full` (ADR-178 D3). The token is good — it is a `read`
 * or `send` device, and those tiers are an allowlist of routes, not this
 * surface. Said plainly, and without forgetting the token: the same device
 * still works in the remote client at `/`.
 */
function ForbiddenScreen(): React.JSX.Element {
  return (
    <FullPageMessage testId="web-app-forbidden">
      This device isn&apos;t paired with full access, so it can&apos;t open the
      full Manor app. Re-pair it at full access in Manor &rarr; Settings &rarr;
      Remote control, or use the lightweight client at{" "}
      <code style={{ marginLeft: "0.25rem" }}>/</code>.
    </FullPageMessage>
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
const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
);

function show(screen: React.ReactNode): void {
  root.render(<React.StrictMode>{screen}</React.StrictMode>);
}

/**
 * Installed before anything renders: the 66 files that call
 * `window.electronAPI` do so from their first effect, and the bridge is what
 * they find there. It dials lazily, so nothing here races the first paint.
 */
window.electronAPI = createWsBridge({
  token,
  url: bridgeUrlFromLocation(),
  onUnauthorized: () => {
    // The token was revoked, or the host forgot it. Drop it and start over
    // rather than reconnecting forever against an answer that will not change.
    forgetWebToken();
    show(<NoTokenScreen />);
  },
  onForbidden: () => {
    show(<ForbiddenScreen />);
  },
});

await loadTerminalFonts();

show(
  token ? (
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  ) : (
    <NoTokenScreen />
  ),
);
