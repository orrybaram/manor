import React, { Suspense } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { rootLoaderFor } from "./lib/window-root";
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

// Detached popup windows (ADR-156) boot a trimmed-down renderer that hosts a
// single handed-off tab; every other window is the full primary app. Each is
// its own chunk graph, so a popout never downloads or parses the primary
// window's chrome. (The entry module is never hot-swapped, so fast refresh
// has nothing to preserve here.)
// eslint-disable-next-line react-refresh/only-export-components
const Root = React.lazy(rootLoaderFor(window.electronAPI?.isDetached === true));

// Start the terminal fonts now so they are usually in by the time the first
// pane asks, but render without them: only terminal creation waits on them
// (see `lib/terminal-font`).
void terminalFontsReady();

/** What both roots show while they boot, painted while the root itself loads. */
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
        <Root />
      </Suspense>
    </QueryClientProvider>
  </React.StrictMode>,
);
