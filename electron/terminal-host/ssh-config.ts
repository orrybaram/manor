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
 * embedded `'` written as `'"'"'`.
 *
 * That spelling (rather than the usual `'\''`) keeps the result free of
 * backslashes, so quoting it a second time — see `remoteShellCommand` —
 * still reads the same in fish and csh, whose single quotes treat `\'` as an
 * escape.
 */
export function shellQuote(value: string): string {
  if (value !== "" && SHELL_SAFE.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Wrap a POSIX `sh` snippet so it runs under `sh` whatever the remote user's
 * login shell is. sshd hands the remote command to that shell (`$SHELL -c`),
 * and fish or tcsh would choke on `if …; then`, `$(…)`, `2>/dev/null` and
 * friends.
 *
 * Every login shell we care about (sh, bash, zsh, fish, csh/tcsh) agrees on
 * `exec`, on single quotes, and on a `"'"` between them, as long as the
 * quoted text holds no newline (csh rejects it), no backslash followed by
 * `\` or `'` (fish unescapes those inside single quotes), and no `!` that
 * csh would read as a history reference (it does so even inside single
 * quotes; `! ` with a space is safe). Snippets are checked for all three.
 */
export function remoteShellCommand(snippet: string): string {
  if (
    /[\r\n]/.test(snippet) ||
    /\\[\\']/.test(snippet) ||
    /![^\s=(]/.test(snippet)
  ) {
    throw new Error(
      "Remote shell snippets must be single-line and must not contain \\\\, \\' or " +
        "a `!` history reference (they have to survive the login shell's quoting): " +
        JSON.stringify(snippet),
    );
  }
  return `exec sh -c ${shellQuote(snippet)}`;
}

// ── Managed config directory ──

export interface ManagedSshConfig {
  /** The 0700 directory holding everything below. Removed on dispose. */
  dir: string;
  /** The config file passed with `-F`. */
  configPath: string;
  /**
   * The ControlPath *pattern* (`<dir>/%C`) — ssh expands `%C` to a hash of
   * the local host, remote host, port, user and jump host, so each hop of a
   * ProxyJump chain gets its own master. See `SshTransport.resolveControlPath`
   * for the expanded path.
   */
  controlPath: string;
}

/** `%C` expands to 40 hex digits. */
const CONTROL_HASH_LEN = 40;
/** ssh creates the socket as `<path>.<16 random chars>` and renames it. */
const CONTROL_TEMP_SUFFIX_LEN = 17;
/** `mkdtemp`'s `manor-ssh-XXXXXX`, plus the separators around it. */
const MANAGED_DIR_NAME_LEN = "/manor-ssh-XXXXXX/".length;
/** Unix socket paths are capped at 104 bytes on macOS (108 on Linux). */
const MAX_SOCKET_PATH = 103;

/**
 * Base directory for the managed config. The ControlMaster socket lives
 * inside it, so the whole socket path — hash and ssh's temporary suffix
 * included — has to fit under the unix socket limit. macOS's `os.tmpdir()`
 * is already ~50 bytes; fall back to the short `/tmp` whenever it is too long.
 */
function defaultBaseDir(): string {
  const budget =
    MAX_SOCKET_PATH -
    MANAGED_DIR_NAME_LEN -
    CONTROL_HASH_LEN -
    CONTROL_TEMP_SUFFIX_LEN;
  const tmp = os.tmpdir();
  return tmp.length <= budget ? tmp : "/tmp";
}

/**
 * The config text. ssh keeps the *first* value it reads for each option, so
 * Manor's settings come first and the user's own config is included after
 * them: host aliases, users, keys and proxies from `~/.ssh/config` still
 * apply, but they cannot redirect the ControlMaster socket we rely on.
 * (`-F` otherwise suppresses both the user and system config files.)
 *
 * `testConfig` is a TEST-ONLY hook (defaults to `$MANOR_E2E_SSH_CONFIG`): an
 * extra config file included ahead of the user's, so the real-sshd E2E suite
 * (scripts/test-remote-e2e.mjs) can define its `manor-e2e` host alias without
 * touching ~/.ssh/config. Unset in normal use, which leaves the config
 * exactly as before.
 */
export function renderSshConfig(
  controlPath: string,
  testConfig: string | undefined = process.env.MANOR_E2E_SSH_CONFIG,
  hostStanza?: string,
): string {
  return [
    "# Written by Manor for its remote host bridge. Safe to delete.",
    // A recipe host's own stanza goes first: ssh keeps the
    // first value it reads, so neither `Host *` below nor the user's config
    // can change where the alias points or which key it trusts.
    ...(hostStanza ? [hostStanza] : []),
    "Host *",
    "  ControlMaster auto",
    `  ControlPath ${controlPath}`,
    "  ControlPersist 60",
    "  ServerAliveInterval 30",
    "  ServerAliveCountMax 3",
    // No tty to prompt on: fail fast rather than hang waiting for a password.
    "  BatchMode yes",
    ...(testConfig ? [`  Include ${testIncludePath(testConfig)}`] : []),
    "  Include ~/.ssh/config",
    "  Include /etc/ssh/ssh_config",
    "",
  ].join("\n");
}

/** Validate the test-only include: an absolute path ssh can read unquoted-safe. */
function testIncludePath(file: string): string {
  if (!path.isAbsolute(file) || /[\s"'\\]/.test(file)) {
    throw new Error(
      `MANOR_E2E_SSH_CONFIG must be an absolute path without spaces or quotes: ${JSON.stringify(file)}`,
    );
  }
  return file;
}

/**
 * Create a fresh 0700 config directory with its config file inside.
 * `hostStanza` is a recipe host's own `Host` block (`renderHostStanza`).
 */
export function createManagedSshConfig(
  baseDir: string = defaultBaseDir(),
  hostStanza?: string,
): ManagedSshConfig {
  const dir = fs.mkdtempSync(path.join(baseDir, "manor-ssh-"));
  fs.chmodSync(dir, 0o700);
  const controlPath = path.join(dir, "%C");
  const configPath = path.join(dir, "config");
  fs.writeFileSync(configPath, renderSshConfig(controlPath, undefined, hostStanza), {
    mode: 0o600,
  });
  return { dir, configPath, controlPath };
}

// ── A recipe host's own stanza ──

/** Where a recipe's `up` says the box is, as its stanza needs it. */
export interface ManagedHostTarget {
  host: string;
  port: number;
  username: string;
  identityFile?: string;
  identitiesOnly?: boolean;
  jumpHost?: string;
  proxyCommand?: string;
}

/** The alias a recipe host is reached by: `manor-<hostId>`. */
export function recipeHostAlias(hostId: string): string {
  const alias = `manor-${hostId}`;
  assertValidTarget(alias);
  return alias;
}

/** A config value, double-quoted when it has spaces. Refuses what can't be. */
function configValue(value: string, what: string): string {
  if (/["\r\n\0]/.test(value)) throw new Error(`Invalid ${what} for ssh config: ${JSON.stringify(value)}`);
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * The `Host <alias>` block for a recipe host: where the box is,
 * and its own `known_hosts`. Keys are stored under the alias
 * (`HostKeyAlias`), so a box re-provisioned at a new address keeps its
 * entry, and nothing else in the user's `known_hosts` is read or written.
 *
 * `strict` is `StrictHostKeyChecking yes`: the file already holds the key,
 * or `up` returned one. Otherwise `accept-new`, which takes the first key
 * into that file and refuses a changed one after.
 */
export function renderHostStanza(
  alias: string,
  target: ManagedHostTarget,
  knownHostsFile: string,
  strict: boolean,
): string {
  assertValidTarget(alias);
  const lines = [
    `Host ${alias}`,
    `  HostName ${configValue(target.host, "host")}`,
    `  Port ${target.port}`,
    `  User ${configValue(target.username, "user")}`,
  ];
  if (target.identityFile) lines.push(`  IdentityFile ${configValue(target.identityFile, "identity file")}`);
  if (target.identitiesOnly !== undefined) {
    lines.push(`  IdentitiesOnly ${target.identitiesOnly ? "yes" : "no"}`);
  }
  if (target.jumpHost) lines.push(`  ProxyJump ${configValue(target.jumpHost, "jump host")}`);
  else if (target.proxyCommand) {
    if (/[\r\n\0]/.test(target.proxyCommand)) throw new Error("Invalid proxy command for ssh config");
    lines.push(`  ProxyCommand ${target.proxyCommand}`);
  }
  lines.push(
    `  HostKeyAlias ${alias}`,
    `  UserKnownHostsFile ${configValue(knownHostsFile, "known_hosts path")}`,
    "  GlobalKnownHostsFile /dev/null",
    `  StrictHostKeyChecking ${strict ? "yes" : "accept-new"}`,
    "  CheckHostIP no",
  );
  return lines.join("\n");
}

/** Whether `file` holds a host key already (a non-comment line). */
export function knownHostsHasKey(file: string): boolean {
  try {
    return fs
      .readFileSync(file, "utf-8")
      .split(/\r?\n/)
      .some((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  } catch {
    return false;
  }
}

/**
 * Trust `hostKey` (`<type> <base64>`) for `alias` alone: `file` is replaced
 * with that one line, dropping any key it held before. Only the recipe that
 * started the box can vouch for a new key.
 */
export function writeKnownHostKey(file: string, alias: string, hostKey: string): void {
  if (/[\r\n]/.test(hostKey)) throw new Error("A host key must be one line");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${alias} ${hostKey}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
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
 * `[user@]host[:port]`-ish targets — alias names, IPv4/IPv6 (bracketed or
 * not, with a `%zone`), user names with dots and dashes — optionally in the
 * `ssh://user@host:port` form.
 */
const VALID_TARGET = /^(?:ssh:\/\/)?[A-Za-z0-9._@:[\]%-]+$/;

/**
 * Accept only targets made of the characters a host alias, user@host or
 * ssh:// URI can contain, and never one ssh would parse as an option. The
 * target is handed to ssh as its own argv entry (never through a local
 * shell), so the allowlist is about ssh's own parsing, not quoting.
 */
export function assertValidTarget(target: string): void {
  const bare = target.replace(/^ssh:\/\//, "");
  if (!VALID_TARGET.test(target) || bare === "" || bare.startsWith("-")) {
    throw new Error(`Invalid ssh target: ${JSON.stringify(target)}`);
  }
}

/** The remote command that starts a bridge connection. */
export function remoteBridgeCommand(): string {
  return `exec ${REMOTE_HOST_BIN} remote-bridge`;
}

/**
 * The remote command that opens the owner channel to the box's host server:
 * `manor-host server-bridge` pipes the stream to the server's
 * socket after saying the owner hello for us. `viewer` opens a desktop
 * window's own viewer stream instead.
 */
export function remoteServerBridgeCommand(opts: { viewer?: boolean } = {}): string {
  return `exec ${REMOTE_HOST_BIN} server-bridge${opts.viewer ? " --viewer" : ""}`;
}

/**
 * The remote command that replaces a stale daemon: `manor-host restart`
 * SIGTERMs the box's remote-namespace daemon (~/.manor/remote/daemon/, the
 * one `remote-bridge` spawns) and clears its socket and pid file, so the next
 * `remote-bridge` starts a fresh one. A Manor desktop daemon on the same box
 * is never touched.
 */
export function remoteRestartCommand(): string {
  return `exec ${REMOTE_HOST_BIN} restart`;
}

/**
 * `ssh -F <config> -T <target> 'exec sh -c <snippet>'` — `snippet` is POSIX
 * sh and runs under `sh` whatever the remote login shell is (see
 * `remoteShellCommand`).
 */
export function buildSshArgs(
  configPath: string,
  target: string,
  snippet: string,
): string[] {
  assertValidTarget(target);
  return ["-F", configPath, "-T", target, remoteShellCommand(snippet)];
}

/**
 * `ssh -F <config> -O <op> [forward options] <target>` — talk to the
 * ControlMaster itself. Passing the managed config lets ssh expand the `%C`
 * in its ControlPath to the same socket the master created. For `forward`
 * and `cancel`, `forwardArgs` names the forward (e.g. `["-L", "8080:localhost:80"]`).
 */
export function buildControlArgs(
  configPath: string,
  target: string,
  op: "check" | "exit" | "forward" | "cancel",
  forwardArgs: string[] = [],
): string[] {
  assertValidTarget(target);
  return ["-F", configPath, "-O", op, ...forwardArgs, target];
}

/** `ssh -F <config> -G <target>` — print the effective config for `target`. */
export function buildResolveConfigArgs(configPath: string, target: string): string[] {
  assertValidTarget(target);
  return ["-F", configPath, "-G", target];
}

/** Pull the expanded `controlpath` out of `ssh -G` output. */
export function parseControlPath(sshG: string): string | null {
  for (const line of sshG.split(/\r?\n/)) {
    const m = /^controlpath\s+(.+)$/i.exec(line.trim());
    if (m && m[1] !== "none") return m[1];
  }
  return null;
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

/** ssh refused the host because its key is unknown (or changed) and BatchMode forbids asking. */
export function isHostKeyError(stderr: string): boolean {
  return (
    stderr.includes("Host key verification failed") ||
    stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")
  );
}

/**
 * ssh would not connect to `target` because it does not (yet) trust the host
 * key. Manor runs ssh with BatchMode, so it cannot show the "are you sure you
 * want to continue connecting" prompt; the user has to accept the key once
 * from a terminal.
 */
export class SshHostKeyError extends Error {
  constructor(
    readonly target: string,
    readonly stderr: string,
    /** Replaces the wording, for a host whose keys Manor manages. */
    message?: string,
  ) {
    super(
      message ??
      (stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED")
        ? `The host key for ${target} has changed since you last connected. ` +
            "If that is expected, remove the old key with `ssh-keygen -R <host>` " +
            `and then ssh to ${target} once from a terminal to accept the new one.`
        : `${target}'s host key is not trusted yet. ssh to ${target} once from a ` +
            "terminal to accept its host key, then try again."),
    );
    this.name = "SshHostKeyError";
  }
}

/** ssh could not authenticate to `target`; the message says what to try. */
export class SshAuthError extends Error {
  constructor(
    readonly target: string,
    readonly stderr: string,
    /**
     * Replaces the wording, for a host reached at an alias only Manor's own
     * config has, where `ssh <alias>` from a terminal means nothing.
     */
    message?: string,
  ) {
    super(
      message ??
        `ssh could not authenticate to ${target}. ` +
          `Verify that \`ssh ${shellQuote(target)}\` works from a terminal first. ` +
          "If your key is passphrase-protected, add it to your agent with `ssh-add` — " +
          "Manor cannot answer a passphrase prompt.",
    );
    this.name = "SshAuthError";
  }
}
