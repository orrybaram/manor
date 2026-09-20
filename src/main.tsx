import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { loadTerminalFonts } from "./lib/terminal-font";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2, // 2 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes
      refetchOnWindowFocus: false,
    },
  },
});

// One renderer for every window (ADR-179 D4). A detached window is not a
// different app: it is `App` with a claim on one tab of the shared layout,
// which it reads from `window.electronAPI.claim` and reports as viewport.
// Before the first pane exists, not after: a terminal measures its cell from
// the font it can draw right now, and a pane that opens ahead of the webfont
// keeps the wrong size for the session. See `lib/terminal-font`.
await loadTerminalFonts();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
