import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

/**
 * The remote box the remote-host suite talks to (ADR-160 ticket 12, ADR-178
 * ticket 8) — a real sshd started by `scripts/test-remote-e2e.mjs`, either a
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

/**
 * Stop the box's Manor daemon and delete everything Manor put there, so the
 * next connect is a cold bootstrap. Also clears the suite's own leftovers.
 */
export function wipeRemote(): void {
  // Agent configs the bootstrap registered hooks in are only removed on the
  // harness's own throwaway homes, never on a box of your own.
  const agentConfigs = remoteKind() === "custom" ? "" : ' "$HOME/.claude" "$HOME/.codex"';
  onRemote(
    '[ -x "$HOME/.manor/bin/manor-host" ] && "$HOME/.manor/bin/manor-host" restart >/dev/null 2>&1; ' +
      `rm -rf "$HOME/.manor" "$HOME/.manor-e2e" "$HOME/code"${agentConfigs}; true`,
    { timeoutMs: 60_000 },
  );
}

/** Install the stub agent and the hook trigger under ~/.manor-e2e/bin. */
export function installRemoteStubs(): void {
  onRemote('mkdir -p "$HOME/.manor-e2e/bin"');
  for (const name of ["manor-e2e-agent", "fire-hook"]) {
    onRemote(`cat > "$HOME/.manor-e2e/bin/${name}" && chmod 755 "$HOME/.manor-e2e/bin/${name}"`, {
      stdin: fs.readFileSync(path.join(STUB_DIR, name)),
    });
  }
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
      `git config --global url."$HOME/manor-e2e-seed.git".insteadOf ${SEED_REPO_URL}`,
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
