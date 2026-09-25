/**
 * Remote bootstrap — make sure a remote box has a `manor-host` matching this
 * app's version before `SshTransport` bridges to it (ADR-160, ticket 6).
 *
 * The shape follows herdr's `src/remote/attach.rs`: detect the platform, look
 * for an installed host, and if it is missing or the wrong version, install
 * one with a prepare → stream → commit split so a failed transfer never
 * replaces a working install.
 *
 * Unlike herdr we cannot ship one static binary — the daemon depends on
 * `node-pty`, a native addon — so v1 requires Node >= 20 on the remote and
 * ships a version-pinned npm tarball (`scripts/build-host-tarball.mjs`),
 * installed with `npm install --omit=dev` so node-pty resolves (or builds)
 * for the remote's platform.
 *
 * Remote layout (all under the remote `$HOME/.manor/`):
 *   host/                       the unpacked package + node_modules
 *   .host-staging-<id>/         an install in progress; renamed to host/
 *   bin/manor-host              launcher shim: pins MANOR_VERSION and the
 *                               absolute node path, then execs the daemon entry
 *   remote/daemon/              the daemon `manor-host remote-bridge` spawns:
 *                               socket, token, pid, log, hook journal
 *   remote/hook-port            its hook listener's `<port>\n<token>`
 *
 * Nothing here touches ~/.manor/daemon/ or ~/.manor/hook-port, which belong
 * to a Manor desktop that may also run on the box (or be this very machine,
 * over `ssh localhost`).
 *
 * Every step runs through an injected `RemoteExec`, so all of the decision
 * logic is testable without an sshd. Snippets here are POSIX sh, single-line
 * and backslash-free: `SshTransport` runs each one as `exec sh -c '…'` so the
 * remote login shell (fish, tcsh, …) never has to parse it (see
 * `remoteShellCommand`).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  EnsureRemoteHost,
  RemoteExec,
  RemoteExecResult,
} from "../terminal-host/transport-ssh";
import { shellQuote } from "../terminal-host/ssh-config";

export const MIN_NODE_MAJOR = 20;

/** npm install of node-pty may compile from source; give it room. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
/**
 * The remote `timeout` wrapped around npm fires this much before our ssh
 * timeout, so a stuck install is stopped *on the remote* (killing the local
 * ssh does not stop a command running without a pty).
 */
const REMOTE_TIMEOUT_MARGIN_S = 30;
/** Searching login-shell rc files and version managers for node. */
const NODE_SEARCH_TIMEOUT_MS = 60_000;
/** The commit step may wait up to ~45s for a concurrent install's lock. */
const COMMIT_TIMEOUT_MS = 2 * 60_000;
/** How long the commit step waits for another install's lock. */
const INSTALL_LOCK_WAIT_S = 45;
/** A lock older than this (minutes) is left over from a dead install. */
const INSTALL_LOCK_STALE_MIN = 2;
/** Transfer of a sub-megabyte tarball; generous for slow links. */
const STREAM_TIMEOUT_MS = 2 * 60_000;
/** Tail of remote stderr quoted in errors. */
const MAX_ERROR_DETAIL = 2_000;

/** The daemon entry inside the package — `LocalTransport` respawns it by this name. */
const HOST_ENTRY = "terminal-host-index.js";

// ── Errors ──

export type RemoteBootstrapErrorCode =
  | "unsupported-platform"
  | "node-missing"
  | "node-too-old"
  | "toolchain-missing"
  | "tarball-missing"
  | "install-failed";

export class RemoteBootstrapError extends Error {
  constructor(
    readonly code: RemoteBootstrapErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RemoteBootstrapError";
  }
}

/**
 * ssh itself failed (exit 255: unreachable, connection dropped) partway
 * through the bootstrap. Deliberately not a `RemoteBootstrapError`: those
 * describe the host and will not fix themselves, while this is the network
 * and a reconnect may well succeed.
 */
class SshSessionError extends Error {
  constructor(target: string, command: string, res: RemoteExecResult) {
    super(
      `ssh to ${target} failed while bootstrapping (exit 255 running \`${command.split("\n")[0].slice(0, 80)}\`)` +
        detail(res),
    );
    this.name = "SshSessionError";
  }
}

// ── Progress ──

export type BootstrapPhase =
  | "detect"
  | "check-node"
  | "check-host"
  | "install"
  | "done";

export interface BootstrapProgress {
  phase: BootstrapPhase;
  target: string;
  /** Human-readable, suitable for a status line. */
  message: string;
}

// ── Pure parsing ──

export interface RemotePlatform {
  os: "linux" | "darwin";
  arch: "x64" | "arm64";
}

const OS_NAMES: Record<string, RemotePlatform["os"]> = {
  Linux: "linux",
  Darwin: "darwin",
};

const ARCH_NAMES: Record<string, RemotePlatform["arch"]> = {
  x86_64: "x64",
  amd64: "x64",
  aarch64: "arm64",
  arm64: "arm64",
};

/**
 * Parse `uname -sm` output. Only the last non-empty line counts — login
 * shells may print banners ahead of it.
 */
export function parseRemotePlatform(target: string, unameOutput: string): RemotePlatform {
  const line = lastLine(unameOutput);
  const [sys, machine] = line.split(/\s+/);
  const os = sys ? OS_NAMES[sys] : undefined;
  const arch = machine ? ARCH_NAMES[machine] : undefined;
  if (!os || !arch) {
    throw new RemoteBootstrapError(
      "unsupported-platform",
      `Remote platform not supported on ${target}: ${JSON.stringify(line || unameOutput.trim())}. ` +
        "Manor hosts run on Linux or macOS, on x86_64 or arm64.",
    );
  }
  return { os, arch };
}

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** Parse `v20.11.1` / `20.11.1` (surrounding noise and pre-release tags tolerated). */
export function parseVersion(text: string): SemVer | null {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Negative, zero, or positive as `a` is older than, equal to, or newer than `b`. */
export function compareVersions(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** Strip whitespace and a leading `v`, so `v1.2.3\n` matches `1.2.3`. */
export function normalizeVersion(text: string): string {
  return text.trim().replace(/^v/, "");
}

function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function tail(text: string): string {
  const t = text.trim();
  return t.length > MAX_ERROR_DETAIL ? `…${t.slice(-MAX_ERROR_DETAIL)}` : t;
}

// ── Remote commands ──

const MANOR = '"$HOME/.manor"';
const HOST_DIR = '"$HOME/.manor/host"';
const BIN_DIR = '"$HOME/.manor/bin"';
const HOST_BIN = '"$HOME/.manor/bin/manor-host"';

export const DETECT_COMMAND = "uname -sm";

/** Prints node's absolute path, then its version. */
export const NODE_CHECK_COMMAND = "command -v node && node --version";

/** Prefix of each candidate line `NODE_SEARCH_COMMAND` prints. */
const NODE_CANDIDATE = "__MANOR_NODE__";
/** Marks where the login shell's own output starts, past any rc-file noise. */
const LOGIN_SHELL_MARK = "__MANOR_BEGIN__";

/**
 * The fallback when `node` is not on a plain ssh session's PATH (or is too
 * old there): ask the user's login shell, which sources the rc files that
 * set up nvm/fnm/Homebrew, and look in the places those put node. Prints one
 * `__MANOR_NODE__ <source> <version> <path>` line per executable found.
 */
export const NODE_SEARCH_COMMAND = [
  `emit() { case "$2" in /*) if [ -x "$2" ]; then printf '${NODE_CANDIDATE} %s %s %s\\n' "$1" "$("$2" --version 2>/dev/null)" "$2"; fi;; esac; }`,
  'T=; if command -v timeout >/dev/null 2>&1; then T="timeout 20"; fi',
  `if [ -n "$SHELL" ]; then emit login "$($T "$SHELL" -lic 'echo ${LOGIN_SHELL_MARK}; command -v node' </dev/null 2>/dev/null | sed -n '/${LOGIN_SHELL_MARK}/,$p' | grep '^/' | head -n 1)"; fi`,
  'for n in "$HOME"/.nvm/versions/node/*/bin/node; do emit nvm "$n"; done',
  'for n in "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node "$HOME/Library/Application Support/fnm/node-versions/"*/installation/bin/node "$HOME"/.fnm/node-versions/*/installation/bin/node; do emit fnm "$n"; done',
  "for n in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do emit common \"$n\"; done",
  "true",
].join("; ");

/** Prefix of each line `TOOLCHAIN_CHECK_COMMAND` prints for a missing tool. */
const MISSING_TOOL = "__MANOR_MISSING__";

/** What node-gyp needs to build node-pty from source. Prints what is missing. */
export const TOOLCHAIN_CHECK_COMMAND = [
  `for t in python3 make; do command -v "$t" >/dev/null 2>&1 || echo "${MISSING_TOOL} $t"; done`,
  `command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 || echo "${MISSING_TOOL} c++"`,
].join("; ");

/**
 * Platforms node-pty ships a prebuilt binary for (its npm package carries
 * `prebuilds/<os>-<arch>`), so `npm install` needs no compiler there. Linux
 * has none and always builds from source.
 */
const NODE_PTY_PREBUILT = new Set(["darwin-x64", "darwin-arm64"]);

export const HOST_VERSION_COMMAND = `${HOST_BIN} --version 2>/dev/null`;

/** The launcher shim written to `~/.manor/bin/manor-host`. */
export function renderLauncherShim(version: string, nodePath: string): string {
  return [
    "#!/bin/sh",
    `# Written by Manor ${version}. Launches its terminal host; reinstalled on version change.`,
    `MANOR_VERSION=${shellQuote(version)}`,
    "export MANOR_VERSION",
    `exec ${shellQuote(nodePath)} "$HOME/.manor/host/${HOST_ENTRY}" "$@"`,
    "",
  ].join("\n");
}

export interface InstallCommands {
  /** Create an empty staging dir. Touches nothing in use. */
  prepare: string;
  /** Unpack the tarball from stdin into staging. */
  stream: string;
  /** `npm install` inside staging and prove node-pty loads. */
  install: string;
  /** Swap staging into place and write the launcher shim. */
  commit: string;
  /** Best-effort removal of staging after a failure. */
  cleanup: string;
}

/**
 * The remote shell snippets for one install. `stagingId` names the staging
 * dir — it must be shared across several ssh invocations, so it is chosen
 * here rather than with the remote's `$$`.
 */
export function buildInstallCommands(
  version: string,
  nodePath: string,
  stagingId: string,
): InstallCommands {
  if (!/^[A-Za-z0-9_-]+$/.test(stagingId)) {
    throw new Error(`Invalid staging id: ${JSON.stringify(stagingId)}`);
  }
  const staging = `"$HOME/.manor/.host-staging-${stagingId}"`;
  const lock = `"$HOME/.manor/.host-install.lock"`;
  const npm = shellQuote(path.posix.join(path.posix.dirname(nodePath), "npm"));
  // One printf argument per line: snippets must stay single-line (see top).
  const [shebang, ...shimBody] = renderLauncherShim(version, nodePath)
    .replace(/\n$/, "")
    .split("\n");
  if (shebang !== "#!/bin/sh") throw new Error(`Unexpected shim shebang: ${shebang}`);
  const installTimeoutS = INSTALL_TIMEOUT_MS / 1000 - REMOTE_TIMEOUT_MARGIN_S;

  return {
    prepare: [
      "set -e",
      `rm -rf ${staging}`,
      `mkdir -p ${staging} ${BIN_DIR}`,
    ].join("; "),

    // npm tarballs nest everything under `package/`.
    stream: ["set -e", `tar -xzf - -C ${staging} --strip-components=1`].join("; "),

    install: [
      "set -e",
      `cd ${staging}`,
      // Prefer the npm beside the node we checked; fall back to PATH.
      `if [ -x ${npm} ]; then NPM=${npm}; else NPM=npm; fi`,
      // Put that node first so npm's install scripts (node-gyp) use it too.
      `PATH=${shellQuote(path.posix.dirname(nodePath))}:"$PATH"; export PATH`,
      // Stop npm (and the compiler under it) on the remote if it overruns;
      // our ssh timeout alone would leave it running there.
      `T=; if command -v timeout >/dev/null 2>&1; then T="timeout ${installTimeoutS}"; fi`,
      '$T "$NPM" install --omit=dev --no-audit --no-fund --no-package-lock',
      `${shellQuote(nodePath)} -e 'require("node-pty")'`,
    ].join("; "),

    // Two renames rather than one (POSIX `mv` cannot replace a non-empty
    // dir), with the old install restored if the second fails. Serialized
    // with a mkdir lock: two installs committing at once could otherwise
    // move one staging dir *into* the host/ the other just put in place.
    commit: [
      "set -e",
      "i=0",
      `while ! mkdir ${lock} 2>/dev/null; do` +
        ` if [ -n "$(find ${lock} -maxdepth 0 -mmin +${INSTALL_LOCK_STALE_MIN} 2>/dev/null)" ]; then rm -rf ${lock}; continue; fi;` +
        ` i=$((i+1)); if [ "$i" -ge ${INSTALL_LOCK_WAIT_S} ]; then echo "another Manor host install is still running on this machine" >&2; exit 1; fi;` +
        " sleep 1; done",
      `trap 'rmdir ${lock} 2>/dev/null || true' EXIT`,
      `rm -rf ${MANOR}/host.old`,
      `if [ -d ${HOST_DIR} ]; then mv ${HOST_DIR} ${MANOR}/host.old; fi`,
      `if ! mv ${staging} ${HOST_DIR}; then` +
        ` if [ -d ${MANOR}/host.old ]; then mv ${MANOR}/host.old ${HOST_DIR}; fi; exit 1; fi`,
      // The shebang is spelled with an octal escape: csh expands `!/…` as
      // history even inside single quotes.
      `{ printf '#\\041/bin/sh\\n'; printf '%s\\n' ${shimBody.map(shellQuote).join(" ")}; } > ${HOST_BIN}.tmp.$$`,
      `chmod 0755 ${HOST_BIN}.tmp.$$`,
      `mv -f ${HOST_BIN}.tmp.$$ ${HOST_BIN}`,
      `rm -rf ${MANOR}/host.old`,
    ].join("; "),

    cleanup: `rm -rf ${staging}`,
  };
}

// ── Tarball ──

/** Where the release build puts the tarball: beside the bundled main process. */
export function hostTarballPath(version: string, dir: string = __dirname): string {
  return path.join(dir, `manor-host-${version}.tgz`);
}

function readTarball(version: string): Buffer {
  const file = hostTarballPath(version);
  try {
    return fs.readFileSync(file);
  } catch {
    throw new RemoteBootstrapError(
      "tarball-missing",
      `The Manor host package for ${version} is missing (${file}). ` +
        "Build it with `node scripts/build-host-tarball.mjs` after `pnpm build`.",
    );
  }
}

// ── Orchestration ──

export interface EnsureRemoteHostOptions {
  onProgress?: (progress: BootstrapProgress) => void;
  /** The tarball for `version`. Defaults to reading `hostTarballPath(version)`. */
  loadTarball?: (version: string) => Buffer | Promise<Buffer>;
  /** Names the staging dir. Defaults to random hex. For tests. */
  stagingId?: () => string;
}

export interface EnsureRemoteHostResult {
  /** True when this call installed or replaced the remote host. */
  installed: boolean;
  version: string;
}

/**
 * Detect the remote platform and Node, then return early if `manor-host
 * --version` already reports `appVersion`; otherwise install it.
 */
export async function ensureRemoteHost(
  target: string,
  appVersion: string,
  rawSsh: RemoteExec,
  opts: EnsureRemoteHostOptions = {},
): Promise<EnsureRemoteHostResult> {
  // ssh exits 255 for its own failures. Surface those as such, rather than
  // letting a dropped connection read as "unsupported platform" or "node
  // missing" — the caller retries the one and gives up on the other.
  const ssh: RemoteExec = async (command, execOpts) => {
    const res = await rawSsh(command, execOpts);
    if (res.code === 255) throw new SshSessionError(target, command, res);
    return res;
  };
  const report = (phase: BootstrapPhase, message: string): void => {
    opts.onProgress?.({ phase, target, message });
  };
  const version = normalizeVersion(appVersion);

  // 1. Detect
  report("detect", `Checking ${target}…`);
  const uname = await ssh(DETECT_COMMAND);
  if (uname.code !== 0) {
    throw new RemoteBootstrapError(
      "unsupported-platform",
      `Could not detect the platform of ${target} (\`uname -sm\` exited ${uname.code})` +
        detail(uname),
    );
  }
  const platform = parseRemotePlatform(target, uname.stdout);

  // 2. Node
  report("check-node", `Checking Node.js on ${target}…`);
  const nodePath = await checkNode(target, ssh);

  // 3. Existing host
  report("check-host", `Checking Manor host on ${target}…`);
  const existing = await ssh(HOST_VERSION_COMMAND);
  if (existing.code === 0 && normalizeVersion(lastLine(existing.stdout)) === version) {
    report("done", `Manor host ${version} is ready on ${target}`);
    return { installed: false, version };
  }

  // 4. Install
  report("install", `Installing Manor host ${version} on ${target}…`);
  if (!NODE_PTY_PREBUILT.has(`${platform.os}-${platform.arch}`)) {
    await checkToolchain(target, ssh);
  }
  const tarball = await (opts.loadTarball ?? readTarball)(version);
  const stagingId = opts.stagingId?.() ?? crypto.randomBytes(6).toString("hex");
  const cmds = buildInstallCommands(version, nodePath, stagingId);

  await step(target, "prepare", ssh(cmds.prepare));
  try {
    await step(target, "transfer", ssh(cmds.stream, { stdin: tarball, timeoutMs: STREAM_TIMEOUT_MS }));
    await step(target, "npm install", ssh(cmds.install, { timeoutMs: INSTALL_TIMEOUT_MS }));
  } catch (err) {
    // Never commit a partial install; leave whatever was there untouched.
    await ssh(cmds.cleanup).catch(() => {});
    throw err;
  }
  await step(target, "commit", ssh(cmds.commit, { timeoutMs: COMMIT_TIMEOUT_MS }));

  report("done", `Manor host ${version} is ready on ${target}`);
  return { installed: true, version };
}

interface NodeCandidate {
  source: string;
  path: string;
  version: SemVer | null;
  versionText: string;
}

/** Parse `NODE_SEARCH_COMMAND` output, ignoring anything that is not a candidate line. */
export function parseNodeCandidates(output: string): NodeCandidate[] {
  const found: NodeCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const m = new RegExp(`^${NODE_CANDIDATE} (\\S+) (\\S*) (/.*)$`).exec(raw.trim());
    if (!m || seen.has(m[3])) continue;
    seen.add(m[3]);
    found.push({ source: m[1], versionText: m[2], version: parseVersion(m[2]), path: m[3] });
  }
  return found;
}

function isNewEnough(c: NodeCandidate): boolean {
  return !!c.version && c.version.major >= MIN_NODE_MAJOR;
}

/**
 * The node to use: the login shell's (the user's own default) if it is new
 * enough, otherwise the newest new-enough one found anywhere.
 */
export function pickNode(candidates: NodeCandidate[]): NodeCandidate | null {
  const login = candidates.find((c) => c.source === "login" && isNewEnough(c));
  if (login) return login;
  const usable = candidates.filter(isNewEnough);
  usable.sort((a, b) => compareVersions(b.version!, a.version!));
  return usable[0] ?? null;
}

/**
 * Returns an absolute path to a node >= MIN_NODE_MAJOR, or throws an
 * actionable error. Tries the plain ssh PATH first; if that has no node or
 * an old one, searches the login shell and the usual version-manager and
 * Homebrew locations.
 */
async function checkNode(target: string, ssh: RemoteExec): Promise<string> {
  const res = await ssh(NODE_CHECK_COMMAND);
  const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const versionLine = lines[lines.length - 1] ?? "";
  const pathLine = lines[lines.length - 2] ?? "";
  const onPath: NodeCandidate | null =
    res.code === 0 && pathLine.startsWith("/")
      ? {
          source: "path",
          path: pathLine,
          versionText: versionLine,
          version: parseVersion(versionLine),
        }
      : null;
  if (onPath && isNewEnough(onPath)) return onPath.path;

  const search = await ssh(NODE_SEARCH_COMMAND, { timeoutMs: NODE_SEARCH_TIMEOUT_MS }).catch(
    (err: unknown) => {
      if (err instanceof SshSessionError) throw err;
      return null;
    },
  );
  const candidates = [
    ...(onPath ? [onPath] : []),
    ...parseNodeCandidates(search?.stdout ?? ""),
  ];
  const picked = pickNode(candidates);
  if (picked) return picked.path;

  const newestOld = candidates
    .filter((c) => c.version)
    .sort((a, b) => compareVersions(b.version!, a.version!))[0];
  if (newestOld) {
    throw new RemoteBootstrapError(
      "node-too-old",
      `Node.js ${MIN_NODE_MAJOR} or newer is required on ${target}; found ${normalizeVersion(newestOld.versionText)} ` +
        `at ${newestOld.path}. Upgrade Node.js there, then try again.`,
    );
  }
  throw new RemoteBootstrapError(
    "node-missing",
    `Node.js ${MIN_NODE_MAJOR} or newer is required on ${target}, but no \`node\` was found ` +
      "on the ssh PATH, in your login shell, or in the usual nvm/fnm/Homebrew locations. " +
      "Install Node.js there, then try again.",
  );
}

/** Fail before touching anything if node-pty will have to compile and cannot. */
async function checkToolchain(target: string, ssh: RemoteExec): Promise<void> {
  const res = await ssh(TOOLCHAIN_CHECK_COMMAND);
  const missing = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`${MISSING_TOOL} `))
    .map((l) => l.slice(MISSING_TOOL.length + 1));
  if (missing.length > 0) {
    throw new RemoteBootstrapError(
      "toolchain-missing",
      `Installing Manor host on ${target} needs a build toolchain to compile node-pty, ` +
        `but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. ` +
        "Install them (e.g. `apt install python3 make g++` or `dnf install python3 make gcc-c++`), then try again.",
    );
  }
}

async function step(
  target: string,
  name: string,
  pending: Promise<RemoteExecResult>,
): Promise<void> {
  const res = await pending;
  if (res.code !== 0) {
    throw new RemoteBootstrapError(
      "install-failed",
      `Installing Manor host on ${target} failed during ${name} (exit ${res.code ?? "signal"})` +
        detail(res),
    );
  }
}

function detail(res: RemoteExecResult): string {
  const text = tail(res.stderr) || tail(res.stdout);
  return text ? `: ${text}` : "";
}

/**
 * Adapt `ensureRemoteHost` to `SshTransport`'s `ensureRemoteHost` option.
 * A missing version (never the case for a packaged app) skips the bootstrap.
 */
export function remoteHostEnsurer(opts: EnsureRemoteHostOptions = {}): EnsureRemoteHost {
  return async (target, version, exec) => {
    if (!version) return;
    await ensureRemoteHost(target, version, exec, opts);
  };
}
