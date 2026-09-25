/**
 * Host health checks for a freshly-onboarded remote project (ADR-178 §4,
 * ticket 5). Runs the four checks from the ADR's table through a host's own
 * `ShellBackend`/`GitBackend` — never through local `fs`/`exec` — so the
 * result reflects the box the project lives on, not this machine.
 *
 * Every check is best-effort: a check that cannot run (missing CLI, network
 * failure) is reported as a failed result, never thrown, so one bad check
 * never hides the other three.
 */

import type { GitBackend, ShellBackend } from "./types";

export type HealthCheckId = "origin" | "claude" | "codex" | "gh";

export interface HealthCheckResult {
  id: HealthCheckId;
  label: string;
  ok: boolean;
  detail: string;
  /** Typed into a terminal on the host, never executed by Manor. */
  fixCommand: string | null;
}

async function checkOrigin(
  git: GitBackend,
  projectPath: string,
): Promise<HealthCheckResult> {
  const label = "Reach origin";
  try {
    await git.exec(projectPath, ["ls-remote", "--heads", "origin"]);
    return { id: "origin", label, ok: true, detail: "origin is reachable.", fixCommand: null };
  } catch (err) {
    return {
      id: "origin",
      label,
      ok: false,
      detail: `Could not reach origin: ${errorMessage(err)}`,
      fixCommand: "gh auth login",
    };
  }
}

/**
 * `claude`'s cheapest non-interactive login signal: does its credentials
 * file exist? There is no documented `claude auth status`, so this only
 * distinguishes "installed" from "not installed" for certain, and treats a
 * missing credentials file as "not logged in" — the caller's detail text
 * says so explicitly rather than implying a stronger check happened.
 */
async function hasClaudeCredentials(shell: ShellBackend): Promise<boolean> {
  try {
    const out = await shell.exec("sh", [
      "-c",
      "test -f ~/.claude/.credentials.json && echo yes || echo no",
    ]);
    return out.trim() === "yes";
  } catch {
    return false;
  }
}

async function checkClaude(shell: ShellBackend): Promise<HealthCheckResult> {
  const label = "Claude CLI";
  const bin = await shell.which("claude");
  if (!bin) {
    return {
      id: "claude",
      label,
      ok: false,
      detail: "The Claude CLI is not installed on this host.",
      fixCommand: "curl -fsSL https://claude.ai/install.sh | bash",
    };
  }
  const loggedIn = await hasClaudeCredentials(shell);
  if (!loggedIn) {
    return {
      id: "claude",
      label,
      ok: false,
      detail: "The Claude CLI is installed but does not look logged in.",
      fixCommand: "claude setup-token",
    };
  }
  return { id: "claude", label, ok: true, detail: "Installed and logged in.", fixCommand: null };
}

async function checkCodex(shell: ShellBackend): Promise<HealthCheckResult> {
  const label = "Codex CLI";
  const bin = await shell.which("codex");
  if (!bin) {
    return {
      id: "codex",
      label,
      ok: false,
      detail: "The Codex CLI is not installed on this host.",
      fixCommand: "codex login",
    };
  }
  try {
    await shell.exec("codex", ["--version"]);
    return { id: "codex", label, ok: true, detail: "Installed.", fixCommand: null };
  } catch (err) {
    return {
      id: "codex",
      label,
      ok: false,
      detail: `\`codex --version\` failed: ${errorMessage(err)}`,
      fixCommand: "codex login",
    };
  }
}

async function checkGh(shell: ShellBackend): Promise<HealthCheckResult> {
  const label = "GitHub CLI";
  const bin = await shell.which("gh");
  if (!bin) {
    return {
      id: "gh",
      label,
      ok: false,
      detail: "The GitHub CLI is not installed on this host.",
      fixCommand: "gh auth login",
    };
  }
  try {
    await shell.exec("gh", ["auth", "status"]);
    return { id: "gh", label, ok: true, detail: "Logged in.", fixCommand: null };
  } catch {
    return {
      id: "gh",
      label,
      ok: false,
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
    return { id, label, ok: false, detail: errorMessage(err), fixCommand: null };
  }
}

/** Run every check for `projectPath` on the host `shell`/`git` belong to. */
export async function runHealthChecks(
  shell: ShellBackend,
  git: GitBackend,
  projectPath: string,
): Promise<HealthCheckResult[]> {
  return [
    await safely("origin", "Reach origin", () => checkOrigin(git, projectPath)),
    await safely("claude", "Claude CLI", () => checkClaude(shell)),
    await safely("codex", "Codex CLI", () => checkCodex(shell)),
    await safely("gh", "GitHub CLI", () => checkGh(shell)),
  ];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
