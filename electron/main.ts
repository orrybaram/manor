// electron/main.ts — Thin entry point
import { app, crashReporter } from "electron";
import { readBranchSync } from "./bridge/handlers/pty";
import { initApp } from "./app-lifecycle";
import { installMainLog } from "./main-log";
import { startLoginPathResolution } from "./login-path";
import { applyE2eBackgroundSwitches } from "./e2e-background";

// Local minidumps, uploaded nowhere. A browser-process crash leaves nothing
// usable in Apple's report — the release Electron framework symbolicates to the
// nearest exported symbol, so every frame reads as unrelated noise (#164). The
// dumps land in `app.getPath("crashDumps")`. Must be started before `ready`.
crashReporter.start({ uploadToServer: false });

// E2E runs keep the app behind the user's windows; a no-op otherwise.
applyE2eBackgroundSwitches();

// When launched from Finder/Dock, macOS gives the app a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) that doesn't include Homebrew paths
// where tools like `gh` live. Apply the cached login PATH now and resolve the
// real one from a login shell in the background, off the startup path.
if (app.isPackaged) startLoginPathResolution();

/**
 * Opt-in remote debugging, for profiling the renderer from outside the app.
 *
 * DevTools shares the renderer's main thread, so on a pane that is already
 * janking it is the worst possible place to measure from — it competes with
 * the thing it is measuring, and on a busy window it can hang outright. A
 * debugging port lets a profiler attach over CDP from another process and
 * record without taking a share of the thread it is recording.
 *
 * Off unless `MANOR_DEBUG_PORT` is set, and never in a packaged build: this
 * opens a port that can drive the renderer, and it is a development tool, not
 * something to ship listening.
 */
if (!app.isPackaged && process.env.MANOR_DEBUG_PORT) {
  app.commandLine.appendSwitch(
    "remote-debugging-port",
    process.env.MANOR_DEBUG_PORT,
  );
  // Bind to loopback explicitly rather than relying on the default.
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

// In dev mode, include the git branch in the app name so multiple
// instances (e.g. from different worktrees) are distinguishable in
// the Dock, App Switcher, and Mission Control.
// Must be set before app.whenReady() so macOS picks it up for the menu bar.
let devTitle: string | null = null;
if (!app.isPackaged) {
  const branch = readBranchSync(process.cwd());
  if (branch) {
    devTitle = `Manor (${branch})`;
    app.name = devTitle;
  }
}

// Mirror console output to disk (ADR-188 §4), so incidents survive a launch
// from Finder/Dock where stdout goes nowhere. Must come after the app name is
// set above, since `app.getPath("logs")` is name-dependent on macOS
// (~/Library/Logs/<name>/main.log). Guarded so a logging failure can never
// block startup — `installMainLog` also swallows its own fs errors.
try {
  installMainLog();
} catch (err) {
  console.error("[main] installMainLog failed:", err);
}

initApp(devTitle);

// Note: We intentionally do NOT disconnect the client or kill the daemon on quit.
// The daemon survives app restarts for session persistence.
