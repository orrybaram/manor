// electron/main.ts — Thin entry point
import { app, crashReporter } from "electron";
import { execFileSync } from "node:child_process";
import { readBranchSync } from "./ipc/pty";
import { initApp } from "./app-lifecycle";

// Local minidumps, uploaded nowhere. A browser-process crash leaves nothing
// usable in Apple's report — the release Electron framework symbolicates to the
// nearest exported symbol, so every frame reads as unrelated noise (#164). The
// dumps land in `app.getPath("crashDumps")`. Must be started before `ready`.
crashReporter.start({ uploadToServer: false });

// When launched from Finder/Dock, macOS gives the app a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) that doesn't include Homebrew paths
// where tools like `gh` live. Spawn a login shell to get the real PATH.
if (app.isPackaged) {
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const result = execFileSync(shell, ["-lc", "echo $PATH"], {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    if (result) {
      process.env.PATH = result;
    }
  } catch {
    // If the login shell fails, fall back to adding common paths
    const common = ["/opt/homebrew/bin", "/usr/local/bin"];
    const current = process.env.PATH || "";
    const segments = current.split(":");
    const missing = common.filter((p) => !segments.includes(p));
    if (missing.length) {
      process.env.PATH = [...missing, current].join(":");
    }
  }
}

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

initApp(devTitle);

// Note: We intentionally do NOT disconnect the client or kill the daemon on quit.
// The daemon survives app restarts for session persistence.
