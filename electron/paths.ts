/**
 * Central filesystem-path registry for Manor.
 *
 * Two roots:
 *   - manorDataDir()  — app-internal state (~/Library/Application Support/Manor on macOS).
 *                       Only Electron main reads/writes these files.
 *   - manorHomeDir()  — ~/.manor.  A stable, well-known path for anything an
 *                       external process needs to find: the detached daemon,
 *                       shell-level agent hooks, the standalone MCP webview
 *                       server, and `git worktree` (user-facing).
 *
 * Rule: if a new file has an external reader (another process, a shell script,
 * git, the user's file manager), put it under manorHomeDir().  Otherwise put
 * it under manorDataDir().
 *
 * This module must stay Electron-free — the daemon and MCP server import it
 * from standalone Node processes.  Do not import `electron` here.
 */

import os from "node:os";
import path from "node:path";

// ── Root resolvers ──

export function manorDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Manor");
  }
  return path.join(os.homedir(), ".local", "share", "Manor");
}

export function manorHomeDir(): string {
  return path.join(os.homedir(), ".manor");
}

// ── Data-dir getters ──

export function projectsFile(): string {
  return path.join(manorDataDir(), "projects.json");
}

export function tasksFile(): string {
  return path.join(manorDataDir(), "tasks.json");
}

export function preferencesFile(): string {
  return path.join(manorDataDir(), "preferences.json");
}

export function keybindingsFile(): string {
  return path.join(manorDataDir(), "keybindings.json");
}

export function windowBoundsFile(): string {
  return path.join(manorDataDir(), "window-bounds.json");
}

export function zoomLevelFile(): string {
  return path.join(manorDataDir(), "zoom-level.json");
}

export function linearTokenFile(): string {
  return path.join(manorDataDir(), "linear-token.enc");
}

export function shellSessionsDir(): string {
  return path.join(manorDataDir(), "sessions");
}

export function shellZdotdir(): string {
  return path.join(manorDataDir(), "zdotdir");
}

// ── Home-dir (~/.manor) getters — each has an external reader, do not move ──

export function daemonDir(): string {
  return path.join(manorHomeDir(), "daemon");
}

export function daemonSocketFile(): string {
  return path.join(daemonDir(), "terminal-host.sock");
}

export function daemonPidFile(): string {
  return path.join(daemonDir(), "terminal-host.pid");
}

export function daemonTokenFile(): string {
  return path.join(daemonDir(), "terminal-host.token");
}

export function hookPortFile(): string {
  return path.join(manorHomeDir(), "hook-port");
}

export function hooksDir(): string {
  return path.join(manorHomeDir(), "hooks");
}

export function hookScriptPath(): string {
  return path.join(hooksDir(), "notify.sh");
}

export function webviewServerPortFile(): string {
  return path.join(manorHomeDir(), "webview-server-port");
}

export function portlessProxyPortFile(): string {
  return path.join(manorHomeDir(), "portless-proxy-port");
}

export function scrollbackSessionsDir(): string {
  return path.join(manorHomeDir(), "sessions");
}

export function layoutFile(): string {
  return path.join(manorHomeDir(), "layout.json");
}

export function worktreesDir(): string {
  return path.join(manorHomeDir(), "worktrees");
}
