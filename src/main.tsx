import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { terminalFontsReady } from "./lib/terminal-font";
import { ManorLogo } from "./components/ui/ManorLogo";
import "./App.css";

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
// Loaded lazily so the splash paints while its chunk graph loads. (The entry
// module is never hot-swapped, so fast refresh has nothing to preserve here.)
// eslint-disable-next-line react-refresh/only-export-components
const App = React.lazy(() => import("./App"));

// Start the terminal fonts now so they are usually in by the time the first
// pane asks, but render without them: only terminal creation waits on them
// (see `lib/terminal-font`).
void terminalFontsReady();

/** What the window shows while it boots, painted while `App` itself loads. */
const splash = (
  <div className="app splash-screen">
    <div className="splash-logo">
      <ManorLogo />
    </div>
  </div>
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={splash}>
        <App />
      </Suspense>
    </QueryClientProvider>
  </React.StrictMode>,
);
