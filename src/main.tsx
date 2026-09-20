// Must stay the first import in this file. `./bridge/install-desktop` builds
// `window.electronAPI` as it is evaluated, and the stores imported by `./App`
// reach for it as *they* are evaluated — see that module's header.
import { bridgeInstalled } from "./bridge/install-desktop";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { loadTerminalFonts } from "./lib/terminal-font";

/**
 * The desktop's entry (ADR-180 D3).
 *
 * `window.electronAPI` used to arrive from the preload, fully built. It is
 * now built in the page by the same client the web app runs
 * (`bridge/client.ts`), over the preload's IPC transport instead of a
 * WebSocket — because `contextBridge` copies the shape it is handed across
 * the isolated-world boundary and a `Proxy`'s members are not there to copy.
 * Every namespace still lives in the preload for now (`manorHost.native`), so
 * every call lands exactly where it landed before; the ones that leave
 * `native` in the tickets after this one need no change here.
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

const root = document.getElementById("root") as HTMLElement;

if (!bridgeInstalled) {
  // The preload did not run, so there is no host to talk to and nothing the
  // app could do. Say so, rather than paint a black window and throw into a
  // console nobody has open.
  root.textContent = "Manor could not start: the preload script did not load.";
} else {
  // One renderer for every window (ADR-179 D4). A detached window is not a
  // different app: it is `App` with a claim on one tab of the shared layout,
  // which it reads from `window.electronAPI.claim` and reports as viewport.
  // Before the first pane exists, not after: a terminal measures its cell from
  // the font it can draw right now, and a pane that opens ahead of the webfont
  // keeps the wrong size for the session. See `lib/terminal-font`.
  await loadTerminalFonts();

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
