import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";

import { fakeGhFixturesJson, fakeGhScript, type FakeGhFixtures } from "./fake-gh";

/**
 * The remote box the remote-host suite talks to — a real sshd started by `scripts/test-remote-e2e.mjs`, either a
 * private macOS sshd or a Linux container.
 *
 * The harness hands the tests an ssh config file (MANOR_E2E_SSH_CONFIG) with
 * two aliases:
 *
 * - `manor-e2e` — what the app connects to. Manor's managed ssh config
 *   includes this file ahead of ~/.ssh/config (a test-only hook in
 *   electron/terminal-host/ssh-config.ts).
 * - `manor-e2e-direct` — the tests' own side channel, for setting the box up
 *   and for doing things on it while the app's connection is down on purpose.
 *
 * To point the suite at a box of your own instead, write such a file yourself
 * (both aliases, key auth that works under BatchMode) and set
 * MANOR_E2E_SSH=1 and MANOR_E2E_SSH_CONFIG. Everything below runs on that
 * box's real $HOME, so use a throwaway account.
 *
 * Shared by the Playwright spec and the bridge-level vitest suite, so nothing
 * here imports Playwright.
 */

export const APP_TARGET = "manor-e2e";
const DIRECT_TARGET = "manor-e2e-direct";

/**
 * A git URL the app's repo-URL validation accepts, which the box's git
 * rewrites (`url.<seed>.insteadOf`) to a bare repo in its own home — no
 * network, no credentials.
 */
export const SEED_REPO_URL = "https://manor-e2e.invalid/seed.git";

/** The same seed, as a GitHub URL (also rewritten to the seed). */
export const GITHUB_SEED_URL = "https://github.com/manor-e2e/seed.git";

/** Where the stubs live on the box. `~`-relative so a shell expands it. */
export const REMOTE_AGENT = "~/.manor-e2e/bin/manor-e2e-agent";

const STUB_DIR = path.join(__dirname, "..", "remote-host");

/** Why the suite is skipped, or null when a target is configured. */
export function remoteSkipReason(): string | null {
  if (process.env.MANOR_E2E_SSH !== "1") {
    return (
      "remote-host E2E needs a real sshd: run `node scripts/test-remote-e2e.mjs` " +
      "(or `--docker` for a Linux box), which starts one and sets MANOR_E2E_SSH=1 " +
      "and MANOR_E2E_SSH_CONFIG. See docs/remote-hosts.md#testing."
    );
  }
  const config = process.env.MANOR_E2E_SSH_CONFIG;
  if (!config || !fs.existsSync(config)) {
    return `MANOR_E2E_SSH=1 but MANOR_E2E_SSH_CONFIG (${config ?? "unset"}) is not a file`;
  }
  return null;
}

function sshConfigPath(): string {
  const config = process.env.MANOR_E2E_SSH_CONFIG;
  if (!config) throw new Error("MANOR_E2E_SSH_CONFIG is not set");
  return config;
}

/** Which target the harness started; "custom" for a box of your own. */
export function remoteKind(): "docker" | "macos" | "custom" {
  const kind = process.env.MANOR_E2E_SSH_TARGET_KIND;
  return kind === "docker" || kind === "macos" ? kind : "custom";
}

export interface RemoteResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a POSIX sh command on the box over the side channel. Throws on a
 * non-zero exit unless `allowFailure`.
 */
export function onRemote(
  command: string,
  opts: { stdin?: string | Buffer; timeoutMs?: number; allowFailure?: boolean } = {},
): RemoteResult {
  const res = spawnSync("ssh", ["-F", sshConfigPath(), DIRECT_TARGET, command], {
    input: opts.stdin,
    encoding: "utf-8",
    timeout: opts.timeoutMs ?? 30_000,
  });
  if (res.error) throw res.error;
  const result = { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  if (!opts.allowFailure && result.code !== 0) {
    throw new Error(
      `remote command failed (exit ${result.code}): ${command}\n${result.stderr.trim()}`,
    );
  }
  return result;
}

/** The box's $HOME, as its shell sees it. */
export function remoteHome(): string {
  return onRemote('printf "%s" "$HOME"').stdout.trim();
}

/** The shell line that reads the host server's pid file into `$pid`. */
const READ_SERVER_PID = 'pid=$(cat "$HOME/.manor/remote/server/server.pid" 2>/dev/null)';

/**
 * Stop the box's Manor daemon and host server and delete what Manor put
 * there, so the next connect starts afresh (and the host server, against the
 * test's relay). Also clears the suite's own leftovers: earlier runs' clones
 * and the stubs.
 *
 * By default the installed host is kept (a reinstall is the bridge suite's
 * job, and costs minutes on Linux) and only its state under `remote/` (and
 * the worktrees under `worktrees/`) goes.
 * `coldBootstrap` deletes all of `~/.manor` too, so the next connect is a
 * bootstrap from nothing.
 */
export function resetRemoteBox({ coldBootstrap = false } = {}): void {
  // Agent configs the bootstrap registered hooks in are only removed on the
  // harness's own throwaway homes, never on a box of your own.
  const agentConfigs =
    coldBootstrap && remoteKind() !== "custom" ? ' "$HOME/.claude" "$HOME/.codex"' : "";
  // Worktrees an earlier test made live outside `remote/`; left behind, a
  // later `git worktree add` of the same name fails with "already exists".
  const manor = coldBootstrap ? '"$HOME/.manor"' : '"$HOME/.manor/remote" "$HOME/.manor/worktrees"';
  stopHostServer();
  onRemote(
    '[ -x "$HOME/.manor/bin/manor-host" ] && "$HOME/.manor/bin/manor-host" restart >/dev/null 2>&1; ' +
      `rm -rf ${manor} "$HOME/.manor-e2e" "$HOME/code"${agentConfigs}; true`,
    { timeoutMs: 60_000 },
  );
}

/** A cold bootstrap's clean slate: `resetRemoteBox` with the host gone too. */
export function wipeRemote(): void {
  resetRemoteBox({ coldBootstrap: true });
}

/**
 * Stop the box's host server. `manor-host restart` leaves it
 * running on purpose — it outlives daemon restarts — so a clean slate that
 * deletes `~/.manor/remote` stops it first, or it would linger with its
 * files gone.
 */
export function stopHostServer(): void {
  onRemote(
    `${READ_SERVER_PID} || exit 0; ` +
      'kill "$pid" 2>/dev/null || exit 0; ' +
      'i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; ' +
      'kill -9 "$pid" 2>/dev/null; true',
    { timeoutMs: 30_000 },
  );
}

/** The host server's pid on the box, or null when none is running. */
export function hostServerPid(): number | null {
  const out = onRemote(
    `${READ_SERVER_PID} && kill -0 "$pid" 2>/dev/null && echo "$pid"; true`,
  ).stdout.trim();
  return out ? Number(out) : null;
}

/**
 * Point the box's host server at `relayUrl` from its next start. The
 * harness's ForceCommand wrapper sources `~/.manor-e2e/env` into every
 * session, and `remote-bridge` starts the server with that environment.
 */
export function pointHostServerAtRelay(relayUrl: string): void {
  // The stubs' directory leads PATH, so the box's `gh` is the fake one
  // (`installRemoteStubs`) — what a host server's GitHub reads shell out to.
  onRemote(
    `mkdir -p "$HOME/.manor-e2e" && printf "MANOR_RELAY_URL='%s'\\nPATH=\\"$HOME/.manor-e2e/bin:$PATH\\"\\n" '${relayUrl}' > "$HOME/.manor-e2e/env"`,
  );
}

/**
 * Make `relayUrl` (a local relay on this machine's loopback) reachable from
 * the box at the same URL. The private sshd's box shares this machine's
 * loopback, so there is nothing to do. A container has a loopback of its
 * own: a reverse forward over the side channel (`ssh -R`, the same port on
 * both ends) carries it, so the pairing links the box mints name the URL
 * the phone dials too. The side channel is never cut, so the forward
 * outlives `killAppSsh`. Returns a function that closes it.
 */
export async function reachRelayFromBox(relayUrl: string): Promise<() => void> {
  if (remoteKind() !== "docker") return () => {};
  const port = Number(new URL(relayUrl).port);
  const child = spawn(
    "ssh",
    [
      "-F",
      sshConfigPath(),
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-R",
      `127.0.0.1:${port}:127.0.0.1:${port}`,
      DIRECT_TARGET,
    ],
    { stdio: "ignore" },
  );
  const close = () => {
    child.kill("SIGTERM");
  };
  try {
    await pollFor(
      `the relay's port ${port} forwarded onto the box`,
      () => {
        if (child.exitCode !== null) throw new Error(`ssh -R exited with ${child.exitCode}`);
        return onRemote(
          `node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"`,
          { allowFailure: true },
        ).code === 0
          ? true
          : null;
      },
      30_000,
      500,
    );
  } catch (err) {
    close();
    throw err;
  }
  return close;
}

/** Where the fake `gh` reads its fixtures on the box. */
const GH_FIXTURES = '"$HOME/.manor-e2e/gh-fixtures.json"';

/** Put `content` on the box at `target` (a shell word), executable if asked. */
function uploadToRemote(target: string, content: string | Buffer, executable = false): void {
  onRemote(`cat > ${target}${executable ? ` && chmod 755 ${target}` : ""}`, { stdin: content });
}

/**
 * Install the stub agent, the hook trigger and a fake `gh` under
 * ~/.manor-e2e/bin. The fake is signed in and knows no PR until a spec calls
 * `setRemoteGhPrs`; it is only on the host server's PATH when
 * `pointHostServerAtRelay` made it so.
 */
export function installRemoteStubs(): void {
  onRemote('mkdir -p "$HOME/.manor-e2e/bin"');
  for (const name of ["manor-e2e-agent", "fire-hook"]) {
    uploadToRemote(`"$HOME/.manor-e2e/bin/${name}"`, fs.readFileSync(path.join(STUB_DIR, name)), true);
  }
  uploadToRemote(
    '"$HOME/.manor-e2e/bin/gh"',
    fakeGhScript("/usr/bin/env node", 'require("os").homedir() + "/.manor-e2e/gh-fixtures.json"'),
    true,
  );
  setRemoteGhPrs({ prs: {} });
}

/**
 * Change what the box's fake `gh` answers: the newest PR of each branch (and
 * the PRs' conversations). Read afresh on every call, so it takes effect at
 * the host server's next poll.
 */
export function setRemoteGhPrs(fixtures: FakeGhFixtures): void {
  uploadToRemote(GH_FIXTURES, fakeGhFixturesJson(fixtures));
}

/**
 * A bare repo with one commit at ~/manor-e2e-seed.git, reachable as
 * `SEED_REPO_URL` through a global `insteadOf`.
 */
export function seedRemoteRepo(): void {
  onRemote(
    [
      "set -e",
      'git config --global user.email e2e@manor.local',
      'git config --global user.name "Manor E2E"',
      'git config --global init.defaultBranch main',
      'rm -rf "$HOME/manor-e2e-seed.git" "$HOME/manor-e2e-seed-work"',
      'git init -q --bare "$HOME/manor-e2e-seed.git"',
      'git init -q "$HOME/manor-e2e-seed-work"',
      'cd "$HOME/manor-e2e-seed-work"',
      "echo seeded > README.md",
      "git add README.md",
      "git commit -q -m init",
      "git branch -M main",
      'git push -q "$HOME/manor-e2e-seed.git" main',
      'cd "$HOME"',
      'rm -rf "$HOME/manor-e2e-seed-work"',
      // Both URLs map to the seed; `--unset-all` first so a rerun on the same
      // box does not trip over the two values.
      `git config --global --unset-all url."$HOME/manor-e2e-seed.git".insteadOf || true`,
      `git config --global --add url."$HOME/manor-e2e-seed.git".insteadOf ${SEED_REPO_URL}`,
      // A project whose origin is on GitHub, so the host's GitHub reads have
      // a repo to ask about, still clones and fetches from the seed.
      `git config --global --add url."$HOME/manor-e2e-seed.git".insteadOf ${GITHUB_SEED_URL}`,
    ].join("; "),
    { timeoutMs: 60_000 },
  );
}

/**
 * Make the app's alias reachable or not, by pointing its `Port` at a closed
 * one. New ssh connections the app opens fail with "connection refused" —
 * what a closed lid or a dead network looks like from the app — while the
 * side channel keeps working.
 */
export function setAppTargetReachable(reachable: boolean): void {
  const file = sshConfigPath();
  const text = fs.readFileSync(file, "utf-8");
  const blocks = text.split(/(?=^Host )/m);
  const next = blocks.map((block) => {
    if (!block.startsWith(`Host ${APP_TARGET}\n`)) return block;
    const direct = blocks.find((b) => b.startsWith(`Host ${DIRECT_TARGET}\n`));
    const realPort = /^\s*Port (\d+)$/m.exec(direct ?? "")?.[1];
    if (!realPort) throw new Error(`no Port in the ${DIRECT_TARGET} block of ${file}`);
    return block.replace(/^(\s*Port )\d+$/m, `$1${reachable ? realPort : "1"}`);
  });
  fs.writeFileSync(file, next.join(""));
}

/**
 * SIGKILL every ssh process the app (or a bridge-level test) has open to the
 * box — the ControlMaster and every bridge riding it — which is what a
 * dropped network does to them. Only processes using a Manor-managed config
 * (`-F …/manor-ssh-XXXXXX/config`) are touched; the side channel is not.
 */
export function killAppSsh(): void {
  spawnSync("pkill", ["-9", "-f", `manor-ssh-[^ ]*/config .*${APP_TARGET}( |$)`]);
}

/** Poll `probe` until it returns a value, or throw after `timeoutMs`. */
export async function pollFor<T>(
  what: string,
  probe: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${what}` +
          (lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""),
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
