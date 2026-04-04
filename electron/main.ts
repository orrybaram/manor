// electron/main.ts — Thin entry point
import { app } from "electron";
import { execFileSync } from "node:child_process";
import { readBranchSync } from "./ipc/pty";
import { initApp } from "./app-lifecycle";

// When launched from Finder/Dock, macOS gives the app a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) that doesn't include Homebrew paths
// where tools like `gh` live. Spawn a login shell to get the real PATH.
// TODO(adr-107): execFileSync here is intentional — this is a synchronous startup
// path that must complete before any async work begins. Cannot use backend abstraction.
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
