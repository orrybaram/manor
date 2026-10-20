#!/usr/bin/env node
/**
 * Remote-host E2E harness.
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
 *   recipe           no sshd: a host Manor starts itself. Builds
 *                    docker/host-image as manor-host:e2e and runs the
 *                    recipe-host vitest suite, which creates a recipe from the
 *                    `docker` template and drives the desktop's registry
 *                    against the container it starts (over `docker exec`).
 *                    Select with --recipe. Skipped, with a message, when
 *                    Docker is absent.
 *   k8s              no sshd: a kind cluster. Uses `kind` and
 *                    `kubectl` from PATH, else downloads pinned, checksummed
 *                    builds into ~/.cache/manor-e2e/bin. Creates the
 *                    `manor-e2e` cluster with its own kubeconfig (never
 *                    ~/.kube/config), loads manor-host:e2e into it and runs
 *                    the Kubernetes recipe suite. Deleted at the end unless
 *                    MANOR_E2E_K8S_KEEP=1. Select with --k8s. Skipped, with a
 *                    message, when Docker is absent.
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
 *   --recipe           the recipe-host suite instead (needs Docker; no sshd)
 *   --k8s              the Kubernetes recipe suite on a kind cluster (needs
 *                      Docker; no sshd). With --smoke: bring the cluster up,
 *                      load the image, run kubectl and a throwaway pod, stop
 *   --no-build         skip `pnpm build` + scripts/build-host-tarball.mjs
 *                      (also applies to --recipe and --k8s)
 *   --smoke            start the target, run `ssh manor-e2e …` once, stop
 *   --serve            start the target, print the env to export, wait for ^C
 *   --vitest-only      run only the bridge-level vitest suite
 *   --playwright-only  run only the Playwright specs (remote-host.spec.ts,
 *                      host-server.spec.ts, host-ownership.spec.ts,
 *                      host-direct-bridge.spec.ts,
 *                      phone-all-pairings.spec.ts,
 *                      phone-linked-hosts.spec.ts,
 *                      phone-relink-after-refusal.spec.ts, recipe-host.spec.ts,
 *                      host-restore-asleep.spec.ts, pairing-keys.spec.ts,
 *                      lid-closed.spec.ts, host-idle-stop.spec.ts),
 *                      one worker
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
const RECIPE_SUITE = "electron/backend/__tests__/recipe-docker.e2e.test.ts";
const K8S_SUITE = "electron/backend/__tests__/recipe-kubernetes.e2e.test.ts";
const HOST_IMAGE_CONTEXT = path.join(ROOT, "docker/host-image");
const RECIPE_IMAGE = "manor-host:e2e";
/** Run one file at a time (`--workers=1`): every spec shares the one box. */
const PLAYWRIGHT_SUITES = [
  "tests/e2e/remote-host.spec.ts",
  "tests/e2e/host-server.spec.ts",
  "tests/e2e/host-ownership.spec.ts",
  "tests/e2e/host-direct-bridge.spec.ts",
  "tests/e2e/phone-all-pairings.spec.ts",
  "tests/e2e/phone-linked-hosts.spec.ts",
  "tests/e2e/phone-relink-after-refusal.spec.ts",
  "tests/e2e/recipe-host.spec.ts",
  "tests/e2e/host-restore-asleep.spec.ts",
  "tests/e2e/pairing-keys.spec.ts",
  "tests/e2e/lid-closed.spec.ts",
  "tests/e2e/host-idle-stop.spec.ts",
];
const K8S_CLUSTER = "manor-e2e";
const KIND_VERSION = "v0.33.0";
/** kind's default node image for KIND_VERSION; always pinned by digest. */
const KIND_NODE_IMAGE =
  "kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5";
const KUBECTL_VERSION = "v1.37.1";
const TOOL_CACHE = path.join(os.homedir(), ".cache", "manor-e2e", "bin");
/** SHA-256 from the published .sha256sum / kubectl.sha256 files, by platform. */
const TOOLS = {
  kind: {
    version: KIND_VERSION,
    url: (p) => `https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-${p}`,
    sha256: {
      "linux-amd64": "aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d",
      "linux-arm64": "20022bee6cfcd5086cb7234d218e3454e6090022f2a8f55d1fa7fcf42c3867a2",
      "darwin-amd64": "5a99f26f57246dc9319dd294803313197a0f34d33c525b3ea8b655db5916ece0",
      "darwin-arm64": "0c8c7dbe5e23594a198b786c4bc13dacc101fa6196b0cb0b23a1ca44e61f4b4f",
    },
  },
  kubectl: {
    version: KUBECTL_VERSION,
    url: (p) => `https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${p.replace("-", "/")}/kubectl`,
    sha256: {
      "linux-amd64": "65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8",
      "linux-arm64": "ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7",
      "darwin-amd64": "6851381c486ff6edd691623e3d65c87cb9a5b02887ff8fbbb38d8a031b748387",
      "darwin-arm64": "fd65982c97ddad3106754b69ffa196d0e543aa591930ae52aed1adfb92f8c77f",
    },
  },
};
/** What the box's host server dials unless a spec says otherwise: nothing. */
const CLOSED_RELAY_URL = "http://127.0.0.1:9";
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
      // The box's host server dials MANOR_RELAY_URL. Never the
      // production relay from a test box: a closed local port unless a spec
      // points it at its own local relay (helpers/remote-host.ts
      // `pointHostServerAtRelay`), through this file.
      `MANOR_RELAY_URL='${CLOSED_RELAY_URL}'`,
      'if [ -f "$HOME/.manor-e2e/env" ]; then . "$HOME/.manor-e2e/env"; fi',
      "export HOME PATH MANOR_RELAY_URL",
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
    // The remote daemon and host server `remote-bridge` spawned are detached
    // from sshd; stop them (and anything else still running out of the temp
    // home) too.
    for (const file of [
      "remote/daemon/terminal-host.pid",
      "daemon/terminal-host.pid",
      "remote/server/server.pid",
    ]) {
      const pid = readPid(path.join(remoteHome, ".manor", file));
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
    // `--progress` belongs to BuildKit's buildx; the legacy builder refuses it.
    const progress = run("docker", ["buildx", "version"]).status === 0 ? ["--progress=plain"] : [];
    const res = spawnSync("docker", ["build", ...progress, "-t", tag, DOCKER_CONTEXT], {
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
/** Set while a kind cluster is up and should be deleted on exit. */
let clusterCleanup = null;

function teardown() {
  if (clusterCleanup) {
    const cleanup = clusterCleanup;
    clusterCleanup = null;
    try {
      cleanup();
    } catch (err) {
      console.error(`[remote-e2e] deleting the cluster failed: ${err.message}`);
    }
  }
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

/** True when the Docker daemon answers; otherwise logs why `what` is skipped. */
function dockerAvailable(what) {
  const version = run("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (version.status === 0) return true;
  log(
    `skipping ${what}: Docker is not available ` +
      `(${(version.stderr ?? "").trim().split("\n")[0] || "no daemon"}). ` +
      "Start Docker, or run it as a user in the docker group.",
  );
  return false;
}

/** Build the reference host image (from cache after the first run). */
function buildHostImage() {
  log(`building ${RECIPE_IMAGE} from docker/host-image…`);
  const res = spawnSync("docker", ["build", "-t", RECIPE_IMAGE, HOST_IMAGE_CONTEXT], { stdio: "inherit" });
  if (res.status !== 0) die("docker build failed");
}

/**
 * `--recipe`: build the reference host image and run the recipe-host suite
 * against the Docker daemon. The suite removes every container and volume
 * it makes; the image is kept, and rebuilt from cache on the next run.
 */
function runRecipe() {
  if (!dockerAvailable("the recipe-host suite")) return;
  if (!flags.has("--no-build")) build();
  buildHostImage();
  const ok = runSuite("vitest recipe-host suite", "pnpm", ["exec", "vitest", "run", RECIPE_SUITE], {
    MANOR_E2E_RECIPE: "1",
    MANOR_E2E_RECIPE_IMAGE: RECIPE_IMAGE,
  });
  process.exitCode = ok ? 0 : 1;
}

// ── Kubernetes target: a kind cluster ──

/** `kind` or `kubectl`: from PATH if present, else a pinned, checked download. */
async function ensureTool(name) {
  const onPath = spawnSync(name, name === "kind" ? ["version"] : ["version", "--client"]);
  if (!onPath.error && onPath.status === 0) {
    log(`using ${name} from PATH`);
    return null;
  }
  const tool = TOOLS[name];
  const platform = `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
  const want = tool.sha256[platform];
  if (!want) die(`no pinned ${name} for ${platform}; install ${name} and put it on PATH`);
  const file = path.join(TOOL_CACHE, `${name}-${tool.version}`);
  const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  if (fs.existsSync(file) && sha256(file) === want) return TOOL_CACHE;

  log(`downloading ${name} ${tool.version} (${platform})…`);
  fs.mkdirSync(TOOL_CACHE, { recursive: true });
  const part = `${file}.${process.pid}.part`;
  const res = await fetch(tool.url(platform), { redirect: "follow" });
  if (!res.ok) die(`downloading ${name} failed: HTTP ${res.status} from ${res.url}`);
  fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()));
  const got = sha256(part);
  if (got !== want) {
    fs.rmSync(part, { force: true });
    die(`${name} ${tool.version} checksum mismatch: expected ${want}, got ${got}; deleted`);
  }
  fs.chmodSync(part, 0o755);
  fs.renameSync(part, file);
  // Callers run `kind` / `kubectl`, so expose the pinned file under that name.
  const link = path.join(TOOL_CACHE, name);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(path.basename(file), link);
  return TOOL_CACHE;
}

/** Bring up (or reuse) the cluster; returns the env the suite and kubectl need. */
async function startCluster() {
  tmpRoot = makeTempRoot();
  const dirs = [];
  for (const name of ["kind", "kubectl"]) {
    const dir = await ensureTool(name);
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  const env = {
    ...process.env,
    PATH: [...dirs, process.env.PATH ?? ""].join(path.delimiter),
    KUBECONFIG: path.join(tmpRoot, "kubeconfig"),
    // kubectl's discovery cache defaults to ~/.kube/cache; keep it out of there.
    KUBECACHEDIR: path.join(tmpRoot, "kubecache"),
  };
  const kind = (args, opts = {}) => run("kind", args, { env, ...opts });

  const existing = mustRun("kind", ["get", "clusters"], { env }).stdout.split("\n");
  clusterCleanup = () => {
    if (process.env.MANOR_E2E_K8S_KEEP === "1") {
      log(`keeping cluster ${K8S_CLUSTER}; delete it with: kind delete cluster --name ${K8S_CLUSTER}`);
      return;
    }
    log(`deleting cluster ${K8S_CLUSTER}…`);
    kind(["delete", "cluster", "--name", K8S_CLUSTER], { stdio: "inherit" });
    log(`(if that failed, delete it by hand: kind delete cluster --name ${K8S_CLUSTER})`);
  };
  if (existing.includes(K8S_CLUSTER)) {
    log(`reusing the existing ${K8S_CLUSTER} cluster`);
    const cfg = mustRun("kind", ["get", "kubeconfig", "--name", K8S_CLUSTER], { env });
    fs.writeFileSync(env.KUBECONFIG, cfg.stdout, { mode: 0o600 });
  } else {
    log(`creating cluster ${K8S_CLUSTER} (${KIND_NODE_IMAGE.split("@")[0]})…`);
    const res = spawnSync(
      "kind",
      [
        "create", "cluster", "--name", K8S_CLUSTER, "--kubeconfig", env.KUBECONFIG,
        "--image", KIND_NODE_IMAGE, "--wait", "120s",
      ],
      { stdio: "inherit", env },
    );
    if (res.status !== 0) die("kind create cluster failed");
  }

  if (!flags.has("--no-build")) build();
  buildHostImage();
  log(`loading ${RECIPE_IMAGE} into the cluster…`);
  const load = spawnSync("kind", ["load", "docker-image", RECIPE_IMAGE, "--name", K8S_CLUSTER], {
    stdio: "inherit",
    env,
  });
  if (load.status !== 0) die("kind load docker-image failed");
  return env;
}

function runK8sSmoke(env) {
  const kubectl = (args) => {
    log(`kubectl ${args.join(" ")}`);
    return spawnSync("kubectl", args, { stdio: "inherit", env }).status === 0;
  };
  let ok = kubectl(["get", "nodes"]);
  const can = run("kubectl", ["auth", "can-i", "create", "statefulsets"], { env });
  console.log(`kubectl auth can-i create statefulsets: ${can.stdout.trim()}`);
  ok = can.status === 0 && can.stdout.trim() === "yes" && ok;
  const pod = "manor-e2e-smoke";
  ok =
    kubectl([
      "run", pod, `--image=${RECIPE_IMAGE}`, "--image-pull-policy=Never", "--restart=Never",
      "--attach", "--rm", "--quiet", "--command", "--", "node", "--version",
    ]) && ok;
  return ok;
}

/** `--k8s`: a kind cluster, the host image loaded into it, then the suite. */
async function runK8s() {
  if (!dockerAvailable("the Kubernetes suite")) return;
  const env = await startCluster();
  if (flags.has("--smoke")) {
    process.exitCode = runK8sSmoke(env) ? 0 : 1;
    return;
  }
  if (!fs.existsSync(path.join(ROOT, K8S_SUITE))) {
    log(`the Kubernetes suite is not there yet: ${K8S_SUITE} does not exist`);
    process.exitCode = 1;
    return;
  }
  const ok = runSuite("vitest Kubernetes suite", "pnpm", ["exec", "vitest", "run", K8S_SUITE], {
    ...env,
    MANOR_E2E_K8S: "1",
    MANOR_E2E_K8S_IMAGE: RECIPE_IMAGE,
  });
  process.exitCode = ok ? 0 : 1;
}

async function main() {
  if (flags.has("--recipe")) {
    runRecipe();
    return;
  }
  if (flags.has("--k8s")) {
    await runK8s();
    return;
  }

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
    console.log(
      `  pnpm exec playwright test ${PLAYWRIGHT_SUITES.join(" ")} --workers=1\n\nCtrl-C to stop.`,
    );
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
      runSuite(
        "playwright suite",
        "pnpm",
        ["exec", "playwright", "test", ...PLAYWRIGHT_SUITES, "--workers=1", ...playwrightArgs],
        env,
      ) &&
      ok;
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`[remote-e2e] ${err.stack ?? err}`);
  process.exitCode = 1;
});
