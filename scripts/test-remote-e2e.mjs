#!/usr/bin/env node
/**
 * Remote-host E2E harness (ADR-160 ticket 12, ADR-178 ticket 8).
 *
 * Starts a real sshd for the suite to reach as its "remote box", runs the
 * gated tests against it, and tears it all down. Two target kinds:
 *
 *   macOS (default)  a PRIVATE, unprivileged `/usr/sbin/sshd` on a random
 *                    127.0.0.1 port, run as the current user with a throwaway
 *                    host key and client key. Every session goes through a
 *                    ForceCommand wrapper that points $HOME at a temp dir, so
 *                    the "remote" side never touches your real ~/.manor or
 *                    ~/.ssh. Fast; exercises the darwin paths (node-pty
 *                    prebuilds, lsof port scanning).
 *   docker           a Linux container (tests/e2e/remote-host/Dockerfile)
 *                    with sshd mapped to a random 127.0.0.1 port. Exercises
 *                    the Linux paths: `uname` → Linux, node-pty compiled from
 *                    source during bootstrap, `ss` + /proc port scanning.
 *                    Select with --docker or MANOR_E2E_SSH_TARGET_KIND=docker.
 *
 * Either way the harness writes an ssh config file with two host aliases —
 * `manor-e2e` (what the app connects to) and `manor-e2e-direct` (a side
 * channel the specs use to set up and poke the box, and which they keep
 * reachable while they make `manor-e2e` unreachable) — and hands it to the
 * tests as MANOR_E2E_SSH_CONFIG. Manor's managed ssh config includes that
 * file ahead of ~/.ssh/config (a test-only hook in
 * electron/terminal-host/ssh-config.ts), so ~/.ssh/config is never modified.
 *
 * Usage:
 *   node scripts/test-remote-e2e.mjs [options] [-- <playwright args>]
 *
 * Options:
 *   --docker           Linux container target instead of the macOS sshd
 *   --no-build         skip `pnpm build` + scripts/build-host-tarball.mjs
 *   --smoke            start the target, run `ssh manor-e2e …` once, stop
 *   --serve            start the target, print the env to export, wait for ^C
 *   --vitest-only      run only the bridge-level vitest suite
 *   --playwright-only  run only tests/e2e/remote-host.spec.ts
 */

import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCKER_CONTEXT = path.join(ROOT, "tests/e2e/remote-host");
const VITEST_SUITE = "electron/terminal-host/__tests__/remote-ssh.e2e.test.ts";
const PLAYWRIGHT_SUITE = "tests/e2e/remote-host.spec.ts";
const APP_ALIAS = "manor-e2e";
const DIRECT_ALIAS = "manor-e2e-direct";

// ── Arguments ──

const argv = process.argv.slice(2);
const dashDash = argv.indexOf("--");
const flags = new Set(dashDash >= 0 ? argv.slice(0, dashDash) : argv);
const playwrightArgs = dashDash >= 0 ? argv.slice(dashDash + 1) : [];
const KIND =
  flags.has("--docker") || process.env.MANOR_E2E_SSH_TARGET_KIND === "docker"
    ? "docker"
    : "macos";

// ── Helpers ──

function log(msg) {
  console.log(`[remote-e2e] ${msg}`);
}

function die(msg) {
  console.error(`\n[remote-e2e] ${msg}\n`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf-8", ...opts });
  if (res.error) throw res.error;
  return res;
}

function mustRun(cmd, args, opts = {}) {
  const res = run(cmd, args, opts);
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${res.status}: ${(res.stderr ?? "").trim()}`,
    );
  }
  return res;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Temp root under /tmp, not os.tmpdir(): the remote daemon's unix socket
 * lives at <remote home>/.manor/remote/daemon/terminal-host.sock, and macOS's
 * ~50-byte $TMPDIR would push that past the 104-byte socket path limit.
 */
function makeTempRoot() {
  const base = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  return fs.realpathSync(fs.mkdtempSync(path.join(base, "manor-rssh-")));
}

function keygen(file) {
  mustRun("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "manor-e2e", "-f", file]);
}

/**
 * The client-side ssh config. Two blocks, not one `Host a b` line, so a spec
 * can make the app's alias unreachable (rewrite its Port) while the direct
 * alias keeps working — see tests/e2e/helpers/remote-host.ts.
 */
function renderClientConfig(tmp, { port, user }) {
  const block = (alias) =>
    [
      `Host ${alias}`,
      "  HostName 127.0.0.1",
      `  Port ${port}`,
      `  User ${user}`,
      `  IdentityFile ${path.join(tmp, "client_key")}`,
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile ${path.join(tmp, "known_hosts")}`,
      "  StrictHostKeyChecking accept-new",
      "  BatchMode yes",
      "  LogLevel ERROR",
      "",
    ].join("\n");
  return [
    "# Written by scripts/test-remote-e2e.mjs for the remote-host E2E suite.",
    block(APP_ALIAS),
    block(DIRECT_ALIAS),
  ].join("\n");
}

async function waitForSsh(configPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const res = run("ssh", ["-F", configPath, DIRECT_ALIAS, "true"], { timeout: 10_000 });
    if (res.status === 0) return;
    last = (res.stderr ?? "").trim();
    await delay(300);
  }
  throw new Error(`sshd did not accept a connection within ${timeoutMs / 1000}s: ${last}`);
}

// ── macOS target: a private sshd as the current user ──

async function startMacTarget(tmp) {
  const sshd = "/usr/sbin/sshd";
  if (!fs.existsSync(sshd)) die(`${sshd} not found; use --docker instead`);

  const remoteHome = path.join(tmp, "home");
  fs.mkdirSync(remoteHome, { mode: 0o700 });
  keygen(path.join(tmp, "host_key"));
  keygen(path.join(tmp, "client_key"));
  fs.copyFileSync(path.join(tmp, "client_key.pub"), path.join(tmp, "authorized_keys"));

  // Every session — the app's bridges and bootstrap commands, the specs'
  // side channel — runs through this, never through the user's own HOME.
  // node and git come from the PATH this harness runs with.
  const wrap = path.join(tmp, "wrap.sh");
  fs.writeFileSync(
    wrap,
    [
      "#!/bin/sh",
      "# ForceCommand for the remote-host E2E sshd: an isolated HOME.",
      `HOME='${remoteHome}'`,
      `PATH='${process.env.PATH ?? "/usr/bin:/bin"}'`,
      "export HOME PATH",
      "unset ZDOTDIR",
      'cd "$HOME" || exit 1',
      'if [ -z "${SSH_ORIGINAL_COMMAND:-}" ]; then exec /bin/sh; fi',
      'exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const port = await freePort();
  const configPath = path.join(tmp, "sshd_config");
  const pidFile = path.join(tmp, "sshd.pid");
  fs.writeFileSync(
    configPath,
    [
      `Port ${port}`,
      "ListenAddress 127.0.0.1",
      `HostKey ${path.join(tmp, "host_key")}`,
      `PidFile ${pidFile}`,
      `AuthorizedKeysFile ${path.join(tmp, "authorized_keys")}`,
      "PubkeyAuthentication yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "UsePAM no",
      "StrictModes no",
      "AllowTcpForwarding yes",
      `ForceCommand ${wrap}`,
      "",
    ].join("\n"),
  );

  const logFd = fs.openSync(path.join(tmp, "sshd.log"), "a");
  const child = spawn(sshd, ["-D", "-e", "-f", configPath], {
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();
  fs.closeSync(logFd);

  const stop = () => {
    // The remote daemon `remote-bridge` spawned is detached from sshd; stop
    // it (and anything else still running out of the temp home) too.
    for (const ns of ["remote/daemon", "daemon"]) {
      const pid = readPid(path.join(remoteHome, ".manor", ns, "terminal-host.pid"));
      if (pid) safeKill(pid);
    }
    const sshdPid = readPid(pidFile) ?? child.pid;
    if (sshdPid) safeKill(sshdPid);
    run("pkill", ["-f", tmp]);
  };

  return { port, user: os.userInfo().username, remoteHome, stop };
}

function readPid(file) {
  try {
    const pid = Number(fs.readFileSync(file, "utf-8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function safeKill(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

// ── Docker target: a Linux box ──

function dockerImageTag() {
  const hash = crypto.createHash("sha256");
  for (const file of ["Dockerfile", "sshd_config", "entrypoint.sh"]) {
    hash.update(fs.readFileSync(path.join(DOCKER_CONTEXT, file)));
  }
  return `manor-e2e-remote:${hash.digest("hex").slice(0, 12)}`;
}

async function startDockerTarget(tmp) {
  if (run("docker", ["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    die("docker is not available (is the daemon running?)");
  }
  keygen(path.join(tmp, "client_key"));
  const pubKey = fs.readFileSync(path.join(tmp, "client_key.pub"), "utf-8").trim();

  // Built once per Dockerfile revision; the tag is its content hash.
  const tag = dockerImageTag();
  if (run("docker", ["image", "inspect", tag]).status !== 0) {
    log(`building ${tag} (first run only)…`);
    const res = spawnSync("docker", ["build", "--progress=plain", "-t", tag, DOCKER_CONTEXT], {
      stdio: "inherit",
    });
    if (res.status !== 0) die("docker build failed");
  }

  const name = `manor-e2e-${crypto.randomBytes(4).toString("hex")}`;
  mustRun("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-p",
    "127.0.0.1::22",
    "-e",
    `AUTHORIZED_KEY=${pubKey}`,
    tag,
  ]);
  const stop = () => {
    run("docker", ["rm", "-f", name]);
  };
  let port;
  try {
    const mapped = mustRun("docker", ["port", name, "22/tcp"]).stdout.trim().split("\n")[0];
    port = Number(/:(\d+)$/.exec(mapped)?.[1]);
    if (!port) throw new Error(`could not read the mapped port from "${mapped}"`);
  } catch (err) {
    stop();
    throw err;
  }
  return { port, user: "manor", remoteHome: "/home/manor", stop, container: name };
}

// ── Lifecycle ──

let target = null;
let tmpRoot = null;

function teardown() {
  if (target) {
    try {
      target.stop();
    } catch (err) {
      console.error(`[remote-e2e] stopping the target failed: ${err.message}`);
    }
    target = null;
  }
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    teardown();
    process.exit(130);
  });
}
process.on("exit", teardown);

async function startTarget() {
  tmpRoot = makeTempRoot();
  log(`starting ${KIND} target in ${tmpRoot}`);
  target = KIND === "docker" ? await startDockerTarget(tmpRoot) : await startMacTarget(tmpRoot);
  const sshConfig = path.join(tmpRoot, "ssh_config");
  fs.writeFileSync(sshConfig, renderClientConfig(tmpRoot, target), { mode: 0o600 });
  await waitForSsh(sshConfig, KIND === "docker" ? 60_000 : 20_000);

  const state = {
    kind: KIND,
    target: APP_ALIAS,
    direct: DIRECT_ALIAS,
    sshConfig,
    port: target.port,
    remoteHome: target.remoteHome,
  };
  const statePath = path.join(tmpRoot, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  log(`sshd up on 127.0.0.1:${target.port} (${APP_ALIAS} / ${DIRECT_ALIAS})`);
  return {
    MANOR_E2E_SSH: "1",
    MANOR_E2E_SSH_CONFIG: sshConfig,
    MANOR_E2E_SSH_STATE: statePath,
    MANOR_E2E_SSH_TARGET_KIND: KIND,
  };
}

function build() {
  log("building the app (pnpm build) and the manor-host tarball…");
  for (const [cmd, args] of [
    ["pnpm", ["build"]],
    ["node", ["scripts/build-host-tarball.mjs"]],
  ]) {
    const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
    if (res.status !== 0) die(`${cmd} ${args.join(" ")} failed`);
  }
}

function runSuite(label, cmd, args, env) {
  log(`running ${label}…`);
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  return res.status === 0;
}

async function main() {
  if (flags.has("--smoke")) {
    const env = await startTarget();
    const probe =
      KIND === "docker"
        ? "echo ok; uname -s; node --version; ss -V"
        : 'echo ok; uname -s; node --version; echo "HOME=$HOME"';
    for (const alias of [APP_ALIAS, DIRECT_ALIAS]) {
      const res = run("ssh", ["-F", env.MANOR_E2E_SSH_CONFIG, alias, probe], { timeout: 20_000 });
      console.log(`--- ssh ${alias} (exit ${res.status}) ---\n${res.stdout}${res.stderr}`);
      if (res.status !== 0) process.exitCode = 1;
    }
    return;
  }

  if (flags.has("--serve")) {
    const env = await startTarget();
    console.log("\nTarget is up. In another shell:\n");
    for (const [k, v] of Object.entries(env)) console.log(`  export ${k}=${v}`);
    console.log(`\n  pnpm exec vitest run ${VITEST_SUITE}`);
    console.log(`  pnpm exec playwright test ${PLAYWRIGHT_SUITE}\n\nCtrl-C to stop.`);
    // An unresolved promise alone would let node exit; keep the loop alive.
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {});
  }

  if (!flags.has("--no-build")) build();

  const env = await startTarget();
  let ok = true;
  if (!flags.has("--playwright-only")) {
    ok = runSuite("vitest bridge suite", "pnpm", ["exec", "vitest", "run", VITEST_SUITE], env) && ok;
  }
  if (!flags.has("--vitest-only")) {
    ok =
      runSuite("playwright suite", "pnpm", ["exec", "playwright", "test", PLAYWRIGHT_SUITE, ...playwrightArgs], env) &&
      ok;
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`[remote-e2e] ${err.stack ?? err}`);
  process.exitCode = 1;
});
