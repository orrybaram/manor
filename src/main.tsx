// Must stay the first import in this file. `./bridge/install-desktop` builds
// `window.electronAPI` as it is evaluated, and the stores imported by `./App`
// reach for it as *they* are evaluated — see that module's header.
import { bridgeInstalled } from "./bridge/install-desktop";
import React from "react";
import ReactDOM from "react-dom/client";
import { createQueryClient, AppRoot } from "./app-root";
import { terminalFontsReady } from "./lib/terminal-font";
import { ManorLogo } from "./components/ui/ManorLogo";
import "./App.css";

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

const queryClient = createQueryClient();

/** What the window shows while it boots, painted while `App` itself loads. */
const splash = (
  <div className="app splash-screen">
    <div className="splash-logo">
      <ManorLogo />
    </div>
  </div>
);

const root = document.getElementById("root") as HTMLElement;

if (!bridgeInstalled) {
  // The preload did not run, so there is no host to talk to and nothing the
  // app could do. Say so, rather than paint a black window and throw into a
  // console nobody has open.
  root.textContent = "Manor could not start: the preload script did not load.";
} else {
  // Start the terminal fonts now so they are usually in by the time the first
  // pane asks, but render without them: only terminal creation waits on them
  // (see `lib/terminal-font`).
  void terminalFontsReady();

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <AppRoot queryClient={queryClient} fallback={splash} />
    </React.StrictMode>,
  );
}
