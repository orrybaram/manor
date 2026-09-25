/**
 * ssh plumbing for `SshTransport`: the Manor-owned throwaway ssh config
 * directory, ssh argument construction, shell quoting, and recognizing the
 * failures worth translating for the user.
 *
 * Kept free of process spawning so all of it is testable as plain functions.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where `remote-bridge` lives on the far side. `$HOME` is expanded by the remote shell. */
export const REMOTE_HOST_BIN = '"$HOME/.manor/bin/manor-host"';

// ── Shell quoting ──

const SHELL_SAFE = /^[A-Za-z0-9@%_+=:,./-]+$/;

/**
 * Quote `value` for a POSIX shell. Values made only of alphanumerics and
 * `@%_+=:,./-` pass through untouched; anything else is single-quoted, with
 * embedded `'` written as `'\''`.
 */
export function shellQuote(value: string): string {
  if (value !== "" && SHELL_SAFE.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ── Managed config directory ──

export interface ManagedSshConfig {
  /** The 0700 directory holding everything below. Removed on dispose. */
  dir: string;
  /** The config file passed with `-F`. */
  configPath: string;
  /** The ControlMaster socket both bridge connections share. */
  controlPath: string;
}

/**
 * Base directory for the managed config. ControlPath is a unix socket, and
 * ssh appends a ~17-character suffix while creating it; macOS caps socket
 * paths at 104 bytes and its `os.tmpdir()` is already ~50, so use the short
 * `/tmp` there.
 */
function defaultBaseDir(): string {
  return process.platform === "darwin" ? "/tmp" : os.tmpdir();
}

/**
 * The config text. ssh keeps the *first* value it reads for each option, so
 * Manor's settings come first and the user's own config is included after
 * them: host aliases, users, keys and proxies from `~/.ssh/config` still
 * apply, but they cannot redirect the ControlMaster socket we rely on.
 * (`-F` otherwise suppresses both the user and system config files.)
 */
export function renderSshConfig(controlPath: string): string {
  return [
    "# Written by Manor for its remote host bridge. Safe to delete.",
    "Host *",
    "  ControlMaster auto",
    `  ControlPath ${controlPath}`,
    "  ControlPersist 60",
    "  ServerAliveInterval 30",
    "  ServerAliveCountMax 3",
    // No tty to prompt on: fail fast rather than hang waiting for a password.
    "  BatchMode yes",
    "  Include ~/.ssh/config",
    "  Include /etc/ssh/ssh_config",
    "",
  ].join("\n");
}

/** Create a fresh 0700 config directory with its config file inside. */
export function createManagedSshConfig(
  baseDir: string = defaultBaseDir(),
): ManagedSshConfig {
  const dir = fs.mkdtempSync(path.join(baseDir, "manor-ssh-"));
  fs.chmodSync(dir, 0o700);
  const controlPath = path.join(dir, "ctl");
  const configPath = path.join(dir, "config");
  fs.writeFileSync(configPath, renderSshConfig(controlPath), { mode: 0o600 });
  return { dir, configPath, controlPath };
}

/** Remove a managed config directory. Never throws. */
export function removeManagedSshConfig(config: ManagedSshConfig): void {
  try {
    fs.rmSync(config.dir, { recursive: true, force: true });
  } catch {
    // Best effort — it lives in a temp dir either way.
  }
}

// ── Argument construction ──

/**
 * Reject targets ssh would parse as an option. Everything else is handed to
 * ssh as its own argv entry (never through a local shell), so it needs no
 * quoting there.
 */
export function assertValidTarget(target: string): void {
  if (!target || target.startsWith("-") || /\s/.test(target)) {
    throw new Error(`Invalid ssh target: ${JSON.stringify(target)}`);
  }
}

/** The remote command that starts a bridge connection. */
export function remoteBridgeCommand(stream: boolean): string {
  return `exec ${REMOTE_HOST_BIN} remote-bridge${stream ? " --stream" : ""}`;
}

/**
 * The remote command that replaces a stale daemon: `manor-host restart`
 * SIGTERMs it and clears its socket and pid file (resolving the daemon
 * directory exactly as a local client does), so the next `remote-bridge`
 * starts a fresh one.
 */
export function remoteRestartCommand(): string {
  return `exec ${REMOTE_HOST_BIN} restart`;
}

/** `ssh -F <config> -T <target> <remoteCommand>` */
export function buildSshArgs(
  configPath: string,
  target: string,
  remoteCommand: string,
): string[] {
  assertValidTarget(target);
  return ["-F", configPath, "-T", target, remoteCommand];
}

/** `ssh -F <config> -O <op> <target>` — talk to the ControlMaster itself. */
export function buildControlArgs(
  configPath: string,
  target: string,
  op: "check" | "exit",
): string[] {
  assertValidTarget(target);
  return ["-F", configPath, "-O", op, target];
}

// ── Failure recognition ──

/** Shape of herdr's `is_remote_auth_error`. */
export function isRemoteAuthError(stderr: string): boolean {
  return (
    stderr.includes("Permission denied") &&
    (stderr.includes("(publickey") ||
      stderr.includes("(keyboard-interactive") ||
      stderr.includes("(password"))
  );
}

/** ssh could not authenticate to `target`; the message says what to try. */
export class SshAuthError extends Error {
  constructor(
    readonly target: string,
    readonly stderr: string,
  ) {
    super(
      `ssh could not authenticate to ${target}. ` +
        `Verify that \`ssh ${shellQuote(target)}\` works from a terminal first. ` +
        "If your key is passphrase-protected, add it to your agent with `ssh-add` — " +
        "Manor cannot answer a passphrase prompt.",
    );
    this.name = "SshAuthError";
  }
}
