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

/** The relay identity keys, `safeStorage`-encrypted. */
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
 * Which daemon a path belongs to. A machine can run two
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

/** The remote daemon's hook journal. NDJSON, mode 0600. */
export function hookJournalFile(): string {
  return path.join(daemonDir("remote"), "hook-journal.ndjson");
}

/**
 * Manor desktop's hook server: `<port>\n<token>`, mode 0600, the same shape
 * as `remoteHookPortFile()`. Read by the hook script when
 * `MANOR_HOOK_PORT_FILE` is unset.
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
 * The remote daemon's control relay listener, for the `manor` CLI: `<port>\n<token>`, mode 0600. Remote PTYs get its path as
 * `MANOR_CONTROL_PORT_FILE`.
 */
export function remoteControlPortFile(): string {
  return path.join(remoteNamespaceDir(), "control-port");
}

/**
 * The host server's state: a headless Manor server beside the
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
  /** The desktop's Linear key, when the user turned Linear on for this host. */
  linearToken: string;
  /** This host's projects and workspace records. */
  projects: string;
  /** This host's layout, keyed by bare workspace path. */
  layout: string;
  /** Whether the host has been adopted yet. */
  ownership: string;
  /** The instance this data dir was created under, to spot a copy. */
  instance: string;
  /**
   * Slice 1's owner snapshots, discarded at boot: the
   * desktop's manifest, and the layout snapshot `layout` used to hold.
   */
  legacyManifest: string;
  /** This server's relay identity: its own room. Sealed. */
  relayIdentity: string;
  /** Phones paired to this server's room, token hashes only. Sealed. */
  devices: string;
  /** This server's VAPID key pair, for its own push. Sealed. */
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
    linearToken: path.join(dataDir, "linear-token.enc"),
    projects: path.join(dataDir, "projects.json"),
    layout: path.join(dataDir, "layout.json"),
    ownership: path.join(dataDir, "ownership.json"),
    instance: path.join(dataDir, "instance.json"),
    legacyManifest: path.join(dataDir, "manifest.json"),
    relayIdentity: path.join(dataDir, "relay-identity.enc"),
    devices: path.join(dataDir, "remote-devices.enc"),
    vapid: path.join(dataDir, "remote-vapid.enc"),
    logsDir: path.join(dataDir, "logs"),
  };
}

/**
 * Which supervisor keeps this box's daemon and host server running across a
 * reboot: `{kind: "systemd" | "launchd" | "container"}`, written
 * by `manor-host supervisor install`. Absent: nothing supervises them, and
 * they are spawned detached on connect.
 */
export function supervisorMarkerFile(): string {
  return path.join(remoteNamespaceDir(), "supervisor.json");
}

/**
 * The host's environment file:
 * `MANOR_SECRET_KEY_FILE`, `MANOR_SECRET_KEY` and `MANOR_INSTANCE_ID`. The
 * supervised units start with it, and `manor-host serve` reads it too, for
 * whichever of them its environment lacks, so an unsupervised server gets
 * them as well. Kept when supervision is turned off. Mode 0600.
 */
export function supervisorEnvFile(): string {
  return path.join(remoteNamespaceDir(), "supervisor.env");
}

/**
 * The key file Manor makes to seal a host's pairing keys when nothing
 * stronger works: `$XDG_CONFIG_HOME/manor/secret.key`, default
 * `~/.config/manor/secret.key`. Outside `~/.manor`, so a copy of the data dir
 * alone cannot read them.
 */
export function hostSecretKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(config, "manor", "secret.key");
}

/** `manor-host supervise`'s pid, while it runs as a container's entrypoint. */
export function supervisePidFile(): string {
  return path.join(remoteNamespaceDir(), "supervise.pid");
}

/**
 * The launcher shim bootstrap writes (`remote-bootstrap.ts`): it pins the
 * installed version, so whatever runs it runs that version.
 */
export function hostShimFile(): string {
  return path.join(manorBinDir(), "manor-host");
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

/**
 * The webview server's per-launch token, mode 0600. Every request to that
 * server sends it as `x-manor-control-token`.
 */
export function webviewServerTokenFile(): string {
  return path.join(manorHomeDir(), "webview-server-token");
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
 * One renderer's viewport — what the primary desktop window is looking at.
 * Beside `layout.json` because it is read at the same moment,
 * and separate from it because layout is the host's and this is one window's.
 */
export function viewportFile(): string {
  return path.join(manorHomeDir(), "viewport.json");
}

/**
 * Copies of records Manor removed from its own files, kept for the user to
 * restore by hand — `pre-adr-227-<hostId>.json`, what the desktop held for a
 * host before that host's server adopted it.
 */
export function backupsDir(): string {
  return path.join(manorHomeDir(), "backups");
}

/**
 * Each remote host's last projects, agents and layout, as its host server
 * last told them: what the desktop shows while the host is away.
 */
export function hostCacheDir(): string {
  return path.join(manorHomeDir(), "host-cache");
}

/** `hostId`'s cache file in `dir`, `<hostId>.json` (`HostProxy`). */
export function hostCacheFile(hostId: string, dir: string = hostCacheDir()): string {
  return path.join(dir, `${hostId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/**
 * The user's host recipes: `<recipeId>/recipe.json` and its
 * scripts. Recipes are only ever read from here — never from a repository.
 */
export function hostRecipesDir(): string {
  return path.join(manorHomeDir(), "host-recipes");
}

/**
 * Each recipe host's own `known_hosts`: `<hostId>` holds the
 * one key Manor trusts for it.
 */
export function hostKnownHostsDir(): string {
  return path.join(manorHomeDir(), "ssh", "known_hosts.d");
}

/** `hostId`'s own `known_hosts` in `dir` (`hostKnownHostsDir()`). */
export function hostKnownHostsFile(hostId: string, dir: string = hostKnownHostsDir()): string {
  return path.join(dir, hostId.replace(/[^A-Za-z0-9._-]/g, "_"));
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
