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

export function agentsFile(): string {
  return path.join(manorDataDir(), "agents.json");
}

export function preferencesFile(): string {
  return path.join(manorDataDir(), "preferences.json");
}

export function notificationsFile(): string {
  return path.join(manorDataDir(), "notifications.json");
}

export function statsFile(): string {
  return path.join(manorDataDir(), "stats.json");
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

export function remoteDevicesFile(): string {
  return path.join(manorDataDir(), "remote-devices.enc");
}

export function remoteAuditFile(): string {
  return path.join(manorDataDir(), "remote-audit.jsonl");
}

export function remoteVapidFile(): string {
  return path.join(manorDataDir(), "remote-vapid.enc");
}

export function loginPathFile(): string {
  return path.join(manorDataDir(), "login-path.json");
}

/** The relay identity keys (ADR-206 D3), `safeStorage`-encrypted. */
export function relayIdentityFile(): string {
  return path.join(manorDataDir(), "remote-relay-identity.enc");
}

export function shellZdotdir(): string {
  return path.join(manorDataDir(), "zdotdir");
}

/** The rcfile bash panes start with (`bash --rcfile`), beside the zdotdir. */
export function shellBashrc(): string {
  return path.join(manorDataDir(), "bash", "bashrc");
}

export function recordingsDir(): string {
  return path.join(manorDataDir(), "recordings");
}

// ── Home-dir (~/.manor) getters — each has an external reader, do not move ──

/**
 * Which daemon a path belongs to (ADR-178 §2). A machine can run two
 * terminal-host daemons side by side, and they must never share state:
 *
 *   - `local`  — the one Manor desktop spawns for its own panes, under
 *                ~/.manor/daemon/, with the desktop's hook server behind
 *                ~/.manor/hook-port.
 *   - `remote` — the one `manor-host remote-bridge` spawns for a Manor on
 *                another machine, under ~/.manor/remote/. It journals the
 *                box's agent hooks behind its own listener and port file.
 *
 * Keeping them apart is what makes `ssh localhost`, or a box that also runs
 * Manor desktop, safe: neither daemon can see the other's socket, token or
 * hook port.
 */
export type DaemonNamespace = "local" | "remote";

/** Root of everything the `remote` daemon namespace owns. */
export function remoteNamespaceDir(): string {
  return path.join(manorHomeDir(), "remote");
}

export function daemonDir(namespace: DaemonNamespace = "local"): string {
  return namespace === "remote"
    ? path.join(remoteNamespaceDir(), "daemon")
    : path.join(manorHomeDir(), "daemon");
}

export function daemonSocketFile(namespace: DaemonNamespace = "local"): string {
  return path.join(daemonDir(namespace), "terminal-host.sock");
}

export function daemonPidFile(namespace: DaemonNamespace = "local"): string {
  return path.join(daemonDir(namespace), "terminal-host.pid");
}

export function daemonTokenFile(namespace: DaemonNamespace = "local"): string {
  return path.join(daemonDir(namespace), "terminal-host.token");
}

export function daemonLogFile(namespace: DaemonNamespace = "local"): string {
  return path.join(daemonDir(namespace), "terminal-host.log");
}

/** The remote daemon's hook journal (ADR-178 §2). NDJSON, mode 0600. */
export function hookJournalFile(): string {
  return path.join(daemonDir("remote"), "hook-journal.ndjson");
}

/**
 * Manor desktop's hook server port (a bare port number). Read by the hook
 * script when `MANOR_HOOK_PORT_FILE` is unset.
 */
export function hookPortFile(): string {
  return path.join(manorHomeDir(), "hook-port");
}

/**
 * The remote daemon's hook listener: `<port>\n<token>`, mode 0600. Remote
 * PTYs get its path as `MANOR_HOOK_PORT_FILE`.
 */
export function remoteHookPortFile(): string {
  return path.join(remoteNamespaceDir(), "hook-port");
}

/**
 * The remote daemon's control relay listener, for the `manor` CLI (ADR-189
 * §1): `<port>\n<token>`, mode 0600. Remote PTYs get its path as
 * `MANOR_CONTROL_PORT_FILE`.
 */
export function remoteControlPortFile(): string {
  return path.join(remoteNamespaceDir(), "control-port");
}

/**
 * The host server's state (ADR-225 D1): a headless Manor server beside the
 * `remote` daemon, for the phone to reach with the laptop's lid closed. Kept
 * apart from `manorDataDir()` so a box that also runs Manor desktop (WSL, a
 * Mac mini) never mixes the two servers' agents, pairings or keys.
 */
export function remoteServerDir(): string {
  return path.join(remoteNamespaceDir(), "server");
}

/**
 * Every file a host server keeps in `dataDir` (default `remoteServerDir()`).
 * One table so `serve`, `server-bridge` (which reads the owner token) and
 * the lifecycle check (which reads the pid and version) agree on names.
 */
export interface HostServerPaths {
  dataDir: string;
  /** Unix socket the owner channel's `server-bridge` pipes to; NDJSON frames. */
  socket: string;
  /** 0600 token a bridge hello on `socket` must present. */
  ownerToken: string;
  /** The running server's pid. */
  pid: string;
  /** The running server's version, for upgrade-on-mismatch. */
  version: string;
  /** How far into the daemon's hook journal agents.json reflects. */
  hookCursor: string;
  /** Which SecretBox backend sealed this server's keys (`pickHostSecretBox`). */
  secretBackend: string;
  /** This host's projects and workspace records (ADR-227 D2). */
  projects: string;
  /** This host's layout, keyed by bare workspace path (ADR-227 D2). */
  layout: string;
  /** Whether the host has been adopted yet (ADR-227 D3). */
  ownership: string;
  /**
   * Slice 1's owner snapshots (ADR-225 D4, D5), discarded at boot: the
   * desktop's manifest, and the layout snapshot `layout` used to hold.
   */
  legacyManifest: string;
  /** This server's relay identity: its own room (ADR-225 D3). Sealed. */
  relayIdentity: string;
  /** Phones paired to this server's room, token hashes only. Sealed. */
  devices: string;
  /** This server's VAPID key pair, for its own push (ADR-225 D3). Sealed. */
  vapid: string;
  logsDir: string;
}

export function hostServerPaths(dataDir: string = remoteServerDir()): HostServerPaths {
  return {
    dataDir,
    socket: path.join(dataDir, "server.sock"),
    ownerToken: path.join(dataDir, "owner-token"),
    pid: path.join(dataDir, "server.pid"),
    version: path.join(dataDir, "server.version"),
    hookCursor: path.join(dataDir, "hook-cursor.json"),
    secretBackend: path.join(dataDir, "secret-backend"),
    projects: path.join(dataDir, "projects.json"),
    layout: path.join(dataDir, "layout.json"),
    ownership: path.join(dataDir, "ownership.json"),
    legacyManifest: path.join(dataDir, "manifest.json"),
    relayIdentity: path.join(dataDir, "relay-identity.enc"),
    devices: path.join(dataDir, "remote-devices.enc"),
    vapid: path.join(dataDir, "remote-vapid.enc"),
    logsDir: path.join(dataDir, "logs"),
  };
}

export function hooksDir(): string {
  return path.join(manorHomeDir(), "hooks");
}

export function hookScriptPath(): string {
  return path.join(hooksDir(), "notify.sh");
}

export function hookScriptJsPath(): string {
  return path.join(hooksDir(), "notify.js");
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

/**
 * One renderer's viewport — what the primary desktop window is looking at
 * (ADR-179 D3). Beside `layout.json` because it is read at the same moment,
 * and separate from it because layout is the host's and this is one window's.
 */
export function viewportFile(): string {
  return path.join(manorHomeDir(), "viewport.json");
}

/**
 * Copies of records Manor removed from its own files, kept for the user to
 * restore by hand — `pre-adr-227-<hostId>.json`, what the desktop held for a
 * host before that host's server adopted it (ADR-227 D3).
 */
export function backupsDir(): string {
  return path.join(manorHomeDir(), "backups");
}

/**
 * Each remote host's last projects, agents and layout, as its host server
 * last told them (ADR-227 D4): what the desktop shows while the host is away.
 */
export function hostCacheDir(): string {
  return path.join(manorHomeDir(), "host-cache");
}

/** `hostId`'s cache file in `dir`, `<hostId>.json` (`HostProxy`). */
export function hostCacheFile(hostId: string, dir: string = hostCacheDir()): string {
  return path.join(dir, `${hostId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function worktreesDir(): string {
  return path.join(manorHomeDir(), "worktrees");
}

export function manorBinDir(): string {
  return path.join(manorHomeDir(), "bin");
}

/**
 * Resolve a renderer-supplied workspace path to a real filesystem cwd — the
 * single boundary where opaque workspace paths become spawn directories.
 * null/empty falls back to `$HOME`.
 */
export function resolveSpawnCwd(cwd: string | null): string {
  return cwd || os.homedir() || "/";
}
