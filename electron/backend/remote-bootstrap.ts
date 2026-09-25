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
 *
 * Every step runs through an injected `RemoteExec`, so all of the decision
 * logic is testable without an sshd.
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
  const npm = shellQuote(path.posix.join(path.posix.dirname(nodePath), "npm"));
  const shim = renderLauncherShim(version, nodePath);

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
      '"$NPM" install --omit=dev --no-audit --no-fund --no-package-lock',
      `${shellQuote(nodePath)} -e 'require("node-pty")'`,
    ].join("; "),

    // Two renames rather than one (POSIX `mv` cannot replace a non-empty
    // dir), with the old install restored if the second fails.
    commit: [
      "set -e",
      `rm -rf ${MANOR}/host.old`,
      `if [ -d ${HOST_DIR} ]; then mv ${HOST_DIR} ${MANOR}/host.old; fi`,
      `if ! mv ${staging} ${HOST_DIR}; then` +
        ` if [ -d ${MANOR}/host.old ]; then mv ${MANOR}/host.old ${HOST_DIR}; fi; exit 1; fi`,
      `printf '%s' ${shellQuote(shim)} > ${HOST_BIN}.tmp.$$`,
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
  ssh: RemoteExec,
  opts: EnsureRemoteHostOptions = {},
): Promise<EnsureRemoteHostResult> {
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
  parseRemotePlatform(target, uname.stdout);

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
  await step(target, "commit", ssh(cmds.commit));

  report("done", `Manor host ${version} is ready on ${target}`);
  return { installed: true, version };
}

/** Returns node's absolute path, or throws an actionable error. */
async function checkNode(target: string, ssh: RemoteExec): Promise<string> {
  const res = await ssh(NODE_CHECK_COMMAND);
  const lines = res.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const versionLine = lines[lines.length - 1] ?? "";
  const nodePath = lines[lines.length - 2] ?? "";
  const parsed = parseVersion(versionLine);
  if (res.code !== 0 || !parsed || !nodePath.startsWith("/")) {
    throw new RemoteBootstrapError(
      "node-missing",
      `Node.js ${MIN_NODE_MAJOR} or newer is required on ${target}, but \`node\` was not found ` +
        "on the PATH of a non-interactive ssh session. Install Node.js there " +
        "(and make sure it is on PATH for `ssh <host> node --version`), then try again.",
    );
  }
  if (parsed.major < MIN_NODE_MAJOR) {
    throw new RemoteBootstrapError(
      "node-too-old",
      `Node.js ${MIN_NODE_MAJOR} or newer is required on ${target}; found ${normalizeVersion(versionLine)} ` +
        `at ${nodePath}. Upgrade Node.js there, then try again.`,
    );
  }
  return nodePath;
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
