/**
 * Host health checks for a freshly-onboarded remote project (ADR-178 §4,
 * ticket 5). Runs the four checks from the ADR's table through a host's own
 * `ShellBackend`/`GitBackend` — never through local `fs`/`exec` — so the
 * result reflects the box the project lives on, not this machine.
 *
 * Every check is best-effort: a check that cannot run (missing CLI, network
 * failure) is reported as a failed result, never thrown, so one bad check
 * never hides the other three. All four run concurrently — one slow or
 * hanging check must not delay the others.
 */

import { shellQuote } from "../terminal-host/ssh-config";
import type { GitBackend, ShellBackend } from "./types";

export type HealthCheckId = "origin" | "claude" | "codex" | "gh";

export interface HealthCheckResult {
  id: HealthCheckId;
  label: string;
  ok: boolean;
  /**
   * `"unknown"` is a neutral, unverified state — Manor could not confirm
   * *or* rule out the thing this check looks for (e.g. Claude login, which
   * has no reliable non-interactive probe). It is not a red failure: `ok` is
   * `false` for it (nothing to show as a green check), but callers that
   * render tone should treat `"unknown"` as neutral, not `"fail"`.
   * Absent (`undefined`) is `"ok"`/`"fail"` implied by `ok` itself, for
   * results predating this field.
   */
  status?: "ok" | "fail" | "unknown";
  detail: string;
  /** Typed into a terminal on the host, never executed by Manor. */
  fixCommand: string | null;
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
    return { id: "origin", label, ok: true, status: "ok", detail: "origin is reachable.", fixCommand: null };
  } catch (err) {
    return {
      id: "origin",
      label,
      ok: false,
      status: "fail",
      detail: `Could not reach origin: ${errorMessage(err)}`,
      fixCommand: fixCommandForOrigin(url),
    };
  }
}

/**
 * `claude`'s cheapest non-interactive login signals, checked in order:
 * a credentials file under `$CLAUDE_CONFIG_DIR` (or `~/.claude` by
 * default), `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` in the login
 * shell's env, or (on a Darwin host) a Keychain entry from `claude login`.
 * There is no documented `claude auth status`, so a host that shows none of
 * these is reported as "unknown", not "not logged in" — `claude setup-token`
 * (the old suggested fix) does not write the credentials file this used to
 * check alone, so treating its absence as a hard failure produced false
 * negatives (ADR-178 ticket 5 review).
 */
async function claudeLooksLoggedIn(shell: ShellBackend): Promise<boolean> {
  const script = [
    'home_cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    'if [ -f "$home_cfg/.credentials.json" ]; then echo yes; exit 0; fi',
    'if [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo yes; exit 0; fi',
    'if command -v security >/dev/null 2>&1 && security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then echo yes; exit 0; fi',
    "echo no",
  ].join("; ");
  try {
    const out = await shell.exec(
      "sh",
      ["-c", loginShellCommand(script)],
      { timeout: PROBE_TIMEOUT_MS },
    );
    return out.trim() === "yes";
  } catch {
    return false;
  }
}

async function checkClaude(shell: ShellBackend): Promise<HealthCheckResult> {
  const label = "Claude CLI";
  const bin = await findCliOnHost(shell, "claude");
  if (!bin) {
    return {
      id: "claude",
      label,
      ok: false,
      status: "fail",
      detail: "The Claude CLI is not installed on this host.",
      fixCommand: "curl -fsSL https://claude.ai/install.sh | bash",
    };
  }
  const loggedIn = await claudeLooksLoggedIn(shell);
  if (loggedIn) {
    return {
      id: "claude",
      label,
      ok: true,
      status: "ok",
      detail: "Installed and logged in.",
      fixCommand: null,
    };
  }
  return {
    id: "claude",
    label,
    ok: false,
    status: "unknown",
    detail:
      "Installed, but Manor could not confirm it is logged in (checked the " +
      "credentials file, ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN, and the " +
      "Keychain). Run `claude` on the host to check.",
    fixCommand: "claude",
  };
}

async function checkCodex(shell: ShellBackend): Promise<HealthCheckResult> {
  const label = "Codex CLI";
  const bin = await findCliOnHost(shell, "codex");
  if (!bin) {
    return {
      id: "codex",
      label,
      ok: false,
      status: "fail",
      detail: "The Codex CLI is not installed on this host.",
      fixCommand: "codex login",
    };
  }
  try {
    await shell.exec("codex", ["--version"], { timeout: PROBE_TIMEOUT_MS });
    return { id: "codex", label, ok: true, status: "ok", detail: "Installed.", fixCommand: null };
  } catch (err) {
    return {
      id: "codex",
      label,
      ok: false,
      status: "fail",
      detail: `\`codex --version\` failed: ${errorMessage(err)}`,
      fixCommand: "codex login",
    };
  }
}

async function checkGh(shell: ShellBackend): Promise<HealthCheckResult> {
  const label = "GitHub CLI";
  const bin = await findCliOnHost(shell, "gh");
  if (!bin) {
    return {
      id: "gh",
      label,
      ok: false,
      status: "fail",
      detail: "The GitHub CLI is not installed on this host.",
      fixCommand: "gh auth login",
    };
  }
  try {
    await shell.exec("gh", ["auth", "status"], { timeout: PROBE_TIMEOUT_MS });
    return { id: "gh", label, ok: true, status: "ok", detail: "Logged in.", fixCommand: null };
  } catch {
    return {
      id: "gh",
      label,
      ok: false,
      status: "fail",
      detail: "The GitHub CLI is installed but not logged in.",
      fixCommand: "gh auth login",
    };
  }
}

/**
 * Run `check`, catching anything it doesn't already handle itself (e.g. a
 * `which`/`exec` call that rejects for a reason other than "not found" or
 * "not logged in") so one misbehaving check never takes the other three
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
    return { id, label, ok: false, status: "fail", detail: errorMessage(err), fixCommand: null };
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
    safely("claude", "Claude CLI", () => checkClaude(shell)),
    safely("codex", "Codex CLI", () => checkCodex(shell)),
    safely("gh", "GitHub CLI", () => checkGh(shell)),
  ]);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
