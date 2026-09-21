import { onBridgeOutcome, webToken } from "./bridge/install-web";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { loadTerminalFonts } from "./lib/terminal-font";
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
 * `window.electronAPI` as something the preload already installed — here it
 * has to be built in the page. `./bridge/install-web` does that, as a side
 * effect of being imported first (ADR-180 ticket 14): the stores reach for
 * `window.electronAPI` at module scope, and ES modules evaluate every static
 * import of a module — `./App` and everything under it — before the first
 * statement of this file, so the bridge has to exist before that import
 * line runs, not after it.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2, // 2 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes
      refetchOnWindowFocus: false,
    },
  },
});

const token = webToken;
const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement,
);

function show(screen: React.ReactNode): void {
  root.render(<React.StrictMode>{screen}</React.StrictMode>);
}

/**
 * Whether the bridge has already decided this tab never gets `<App />`.
 *
 * `onBridgeOutcome`'s callback can run before the `show()` below does — the
 * socket's hello round-trip races `loadTerminalFonts()`, and a fast local
 * connection (or, since ADR-179, the earlier `layout.onChanged` subscribe
 * inside `./App`'s store tree) can easily win. Without this flag the
 * unconditional `show()` after the await stomps right back over whichever
 * refusal screen just rendered, and `<App />` (or a blank `NoTokenScreen`)
 * briefly shows for a device that was just told no.
 */
let settled = false;

onBridgeOutcome((outcome) => {
  settled = true;
  show(outcome === "unauthorized" ? <NoTokenScreen /> : <ForbiddenScreen />);
});

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
