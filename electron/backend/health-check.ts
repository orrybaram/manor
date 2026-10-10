/**
 * Host health checks for a freshly-onboarded remote project (ADR-178 §4,
 * ticket 5). Runs its checks through a host's own
 * `ShellBackend`/`GitBackend` — never through local `fs`/`exec` — so the
 * result reflects the box the project lives on, not this machine.
 *
 * Every check is best-effort: a check that cannot run (missing CLI, network
 * failure) is reported as a failed result, never thrown, so one bad check
 * never hides the others. All of them run concurrently — one slow or
 * hanging check must not delay the others.
 */

import { errorMessage } from "../lib/errors";
import { shellQuote } from "../terminal-host/ssh-config";
import type { GitBackend, ShellBackend } from "./types";

export type HealthCheckId = "origin" | "agent" | "gh";

export type HealthCheckStatus = "ok" | "fail" | "unknown";

export interface HealthCheckResult {
  id: HealthCheckId;
  label: string;
  /** Derived from `status`: `true` only for `"ok"`. */
  ok: boolean;
  /**
   * `"unknown"` is a neutral, unverified state — Manor could not confirm
   * *or* rule out the thing this check looks for (e.g. a login with
   * no reliable non-interactive probe). It is not a red failure: `ok` is
   * `false` for it (nothing to show as a green check), but callers that
   * render tone should treat `"unknown"` as neutral, not `"fail"`.
   */
  status: HealthCheckStatus;
  detail: string;
  /** Typed into a terminal on the host, never executed by Manor. */
  fixCommand: string | null;
}

/** Builds a `HealthCheckResult`, deriving `ok` from `status`. */
function result(
  id: HealthCheckId,
  label: string,
  status: HealthCheckStatus,
  detail: string,
  fixCommand: string | null,
): HealthCheckResult {
  return { id, label, ok: status === "ok", status, detail, fixCommand };
}

/** How long any single host probe (a `which`, a login-shell check, …) may run. */
const PROBE_TIMEOUT_MS = 15_000;

/** How long `ls-remote` against `origin` may run before it's a failure. */
const ORIGIN_TIMEOUT_MS = 20_000;

/**
 * Wrap `snippet` so it runs under the user's own login shell rather than
 * whatever the daemon inherited — a non-interactive ssh command (or an
 * already-running daemon) never sources `.profile`/`.zprofile`, so a CLI
 * installed under `~/.local/bin` or a credential exported there would
 * otherwise look missing (ADR-178 ticket 5 review). `snippet` is fixed at
 * call sites (constants below), never user input, so no quoting beyond
 * `shellQuote` is needed.
 */
function loginShellCommand(snippet: string): string {
  return `exec "\${SHELL:-sh}" -lc ${shellQuote(snippet)}`;
}

/**
 * Resolve `cli` to an absolute path via the host's login shell, falling back
 * to the common manual-install location (`~/.local/bin`) if the login-shell
 * probe itself fails to run (odd `$SHELL`, a restrictive rc file). `null` if
 * neither finds it.
 */
async function findCliOnHost(shell: ShellBackend, cli: string): Promise<string | null> {
  try {
    const out = await shell.exec(
      "sh",
      ["-c", loginShellCommand(`command -v ${cli}`)],
      { timeout: PROBE_TIMEOUT_MS },
    );
    const found = out.trim();
    if (found.length > 0) return found;
  } catch {
    // Fall through to the ~/.local/bin fallback below.
  }
  try {
    const home = await shell.homeDir();
    const candidate = `${home}/.local/bin/${cli}`;
    const out = await shell.exec(
      "sh",
      ["-c", `test -x ${shellQuote(candidate)} && echo ${shellQuote(candidate)}`],
      { timeout: PROBE_TIMEOUT_MS },
    );
    const found = out.trim();
    return found.length > 0 ? found : null;
  } catch {
    return null;
  }
}

/** The host of an `ssh://` or scp-style (`user@host:path`) origin URL. */
function sshHostFromOriginUrl(url: string): string | null {
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)/.exec(url);
  if (ssh) return ssh[1];
  const scp = /^[^@/]+@([^@/:]+):/.exec(url);
  return scp?.[1] ?? null;
}

/**
 * The `origin` remote's URL, or `null` if it cannot be read (no `origin`,
 * not a repo, …) — a fixCommand still has to be chosen when that happens, so
 * this is best-effort rather than a rethrow.
 */
async function originUrl(git: GitBackend, projectPath: string): Promise<string | null> {
  try {
    const out = await git.exec(projectPath, ["remote", "get-url", "origin"]);
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * What to suggest when `origin` is unreachable, depending on its URL's
 * scheme (ADR-178 ticket 5 review): `https` remotes fail through `gh`'s
 * credential helper, so `gh auth login` is the fix; `ssh`/scp remotes fail
 * through the host's own ssh keys, which `gh auth login` cannot touch.
 */
function fixCommandForOrigin(url: string | null): string {
  if (url && (url.startsWith("ssh://") || /^[^@/]+@[^@/:]+:/.test(url))) {
    const host = sshHostFromOriginUrl(url);
    return host
      ? `ssh -T git@${host}  # add an ssh key or deploy key for this repo on this host`
      : `ssh -T git@<host>  # add an ssh key or deploy key for this repo on this host`;
  }
  return "gh auth login";
}

async function checkOrigin(
  shell: ShellBackend,
  git: GitBackend,
  projectPath: string,
): Promise<HealthCheckResult> {
  const label = "Reach origin";
  const url = await originUrl(git, projectPath);
  try {
    // Through the host's own shell (not `git.exec`, which has no env/timeout
    // knobs): a missing credential must fail fast rather than hang waiting
    // on a prompt Manor cannot answer, and a dead network must not hang the
    // check forever either.
    await shell.exec(
      "sh",
      [
        "-c",
        `GIT_TERMINAL_PROMPT=0 git -C ${shellQuote(projectPath)} ls-remote --heads origin`,
      ],
      { timeout: ORIGIN_TIMEOUT_MS },
    );
    return result("origin", label, "ok", "origin is reachable.", null);
  } catch (err) {
    return result(
      "origin",
      label,
      "fail",
      `Could not reach origin: ${errorMessage(err)}`,
      fixCommandForOrigin(url),
    );
  }
}

/**
 * The agent CLIs Manor can launch (`AgentKind` in `terminal-host/types.ts`).
 * A host needs one of them, not all: a project runs whichever its agent
 * command names.
 */
const AGENT_CLIS = ["claude", "codex", "opencode", "pi"] as const;

async function checkAgent(shell: ShellBackend): Promise<HealthCheckResult> {
  const label = "Agent CLI";
  const found = await Promise.all(
    AGENT_CLIS.map(async (cli) => ((await findCliOnHost(shell, cli)) ? cli : null)),
  );
  const installed = found.filter((cli): cli is (typeof AGENT_CLIS)[number] => cli !== null);
  if (installed.length > 0) {
    return result("agent", label, "ok", `Installed: ${installed.join(", ")}.`, null);
  }
  return result(
    "agent",
    label,
    "fail",
    `No agent CLI is installed on this host (looked for ${AGENT_CLIS.join(", ")}).`,
    "curl -fsSL https://claude.ai/install.sh | bash",
  );
}

async function checkGh(shell: ShellBackend): Promise<HealthCheckResult> {
  const label = "GitHub CLI";
  const bin = await findCliOnHost(shell, "gh");
  if (!bin) {
    return result(
      "gh",
      label,
      "fail",
      "The GitHub CLI is not installed on this host.",
      "gh auth login",
    );
  }
  try {
    // The resolved path, not the bare name: `exec` doesn't run under the
    // login shell `findCliOnHost` found it through, so its PATH may not
    // have the CLI's directory.
    await shell.exec(bin, ["auth", "status"], { timeout: PROBE_TIMEOUT_MS });
    return result("gh", label, "ok", "Logged in.", null);
  } catch {
    return result(
      "gh",
      label,
      "fail",
      "The GitHub CLI is installed but not logged in.",
      "gh auth login",
    );
  }
}

/**
 * Run `check`, catching anything it doesn't already handle itself (e.g. a
 * `which`/`exec` call that rejects for a reason other than "not found" or
 * "not logged in") so one misbehaving check never takes the others
 * down with it.
 */
async function safely(
  id: HealthCheckId,
  label: string,
  check: () => Promise<HealthCheckResult>,
): Promise<HealthCheckResult> {
  try {
    return await check();
  } catch (err) {
    return result(id, label, "fail", errorMessage(err), null);
  }
}

/** Run every check for `projectPath` on the host `shell`/`git` belong to, in parallel. */
export async function runHealthChecks(
  shell: ShellBackend,
  git: GitBackend,
  projectPath: string,
): Promise<HealthCheckResult[]> {
  return Promise.all([
    safely("origin", "Reach origin", () => checkOrigin(shell, git, projectPath)),
    safely("agent", "Agent CLI", () => checkAgent(shell)),
    safely("gh", "GitHub CLI", () => checkGh(shell)),
  ]);
}

