/**
 * Getting a repo checked out on a remote host (ADR-178 ticket 5): the
 * validation of what the user typed, and the clone itself. Pure functions
 * over a host's backend and a progress callback (ADR-183 split this out of
 * `ProjectManager`).
 */

import { errorMessage } from "../lib/errors";
import { shellQuote } from "../terminal-host/ssh-config";
import { expandHome } from "./path-router";
import type { ProjectHost } from "./types";

/**
 * `https://…`, `ssh://user@host/…` or scp-style `git@host:path` — the three
 * forms git itself accepts as a clone source. Deliberately conservative: a
 * URL is handed to `git clone` as its own argv entry (never through a local
 * shell), but a target this loose still needs to look like a git remote
 * before Manor spends a network round-trip and a directory on it.
 */
const REPO_URL_PATTERN =
  /^(?:https:\/\/[A-Za-z0-9._-]+(?::\d+)?\/[\w.\-~/]+(?:\.git)?|ssh:\/\/[\w.-]+@[A-Za-z0-9._-]+(?::\d+)?\/[\w.\-~/]+(?:\.git)?|[\w.-]+@[A-Za-z0-9._-]+:[\w.\-~/]+(?:\.git)?)$/;

/**
 * Throws unless `url` is an `https://`, `ssh://` or scp-style git remote.
 *
 * The scp form (`user@host:path`) allows `-` in its user part, which would
 * otherwise let a URL like `-oProxyCommand=…@host:path` be handed to `git
 * clone` and misread as an option rather than a positional argument.
 * Requiring the first character to be alphanumeric closes that off for
 * every accepted form (the `https://`/`ssh://` schemes already start
 * alphanumeric, so this only tightens the scp form).
 */
export function validateRepoUrl(url: string): void {
  if (!/^[A-Za-z0-9]/.test(url) || !REPO_URL_PATTERN.test(url)) {
    throw new Error(
      "Repo URL must be an https://, ssh://, or git@host:path git remote.",
    );
  }
}

/**
 * An absolute path or one starting with `~/`, made only of characters a
 * POSIX path can hold without needing shell quoting on the far side
 * (letters, digits and `@%_+=:,./-`). Manor passes it through `git clone`'s
 * own argv, never a shell, but the allowlist keeps it from ever looking
 * like a flag or containing a character that would surprise `ls`/`test`
 * when Manor checks whether it already exists.
 */
const REMOTE_DIR_PATTERN = /^(?:~|~\/[\w@%+=:,./-]*|\/[\w@%+=:,./-]*)$/;

/** Throws unless `dir` is an absolute path or `~/`-relative, shell-safe path. */
export function validateRemoteDir(dir: string): void {
  if (!REMOTE_DIR_PATTERN.test(dir)) {
    throw new Error(
      "Remote directory must be an absolute path or start with ~/, using only " +
        "letters, numbers and @%_+=:,./-",
    );
  }
}

/**
 * A repo's identity as `host/path`, so `git@host:path`, `ssh://git@host/path`
 * and `https://host/path` (ADR-178 ticket 5 review) compare equal even
 * though `git remote get-url origin` and a user-typed repo URL rarely agree
 * on form. Strips scheme, user, port and a trailing `.git`/`/` (in either
 * order); case-folds, since host names are case-insensitive.
 */
export function normalizeOriginUrl(url: string): string {
  let rest = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) {
    rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  } else {
    // scp-style `[user@]host:path` — turn the `:` before the path into `/`.
    rest = rest.replace(/^((?:[^@/]+@)?[^@/:]+):/, "$1/");
  }
  // Drop a leading `user@`, then a `:port` right after the host.
  rest = rest.replace(/^[^@/]+@/, "").replace(/^([^/:]+):\d+/, "$1");
  return rest.toLowerCase();
}

/**
 * Validate a user-supplied remote directory and resolve it to an absolute
 * path, expanding `~` against the host's home. The host is asked for its
 * home only once the input has passed validation.
 */
export async function resolveRemoteDir(
  remoteDir: string,
  homeDir: () => Promise<string>,
  join: (...parts: string[]) => string,
): Promise<string> {
  const input = remoteDir.trim();
  validateRemoteDir(input);
  const targetDir = expandHome(input, await homeDir(), join);
  if (!targetDir.startsWith("/") || targetDir === "/") {
    throw new Error(
      `Remote directory must resolve to an absolute path other than "/" (got ${JSON.stringify(targetDir)}).`,
    );
  }
  return targetDir;
}

/** Clone progress, for the `projects:clone-progress` channel (ADR-183 ticket 1). */
export type CloneProgress = (
  status: "in-progress" | "done" | "error",
  message?: string,
) => void;

/** How long a clone may run before Manor gives up and cancels it. */
export const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Get `repoUrl` (already validated and trimmed) checked out at `targetDir`
 * (already resolved) on the host. A directory that is already a clone of
 * `repoUrl` is adopted as-is; any other non-empty directory is refused;
 * otherwise it is cloned, with progress through `emit`. A failed clone
 * rejects with git's own message.
 */
export async function prepareRemoteClone(
  host: ProjectHost,
  repoUrl: string,
  targetDir: string,
  emit: CloneProgress,
): Promise<void> {
  const state = await remoteDirState(host, targetDir);
  if (state === "nonempty") {
    if (await remoteDirIsCloneOf(host, targetDir, repoUrl)) return;
    throw new Error(
      `"${targetDir}" already exists and is not empty. Choose an empty ` +
        "directory, or one that is already a clone of this repository.",
    );
  }

  emit("in-progress");
  try {
    await cloneWithProgress(host, repoUrl, targetDir, emit);
  } catch (err) {
    emit("error", errorMessage(err));
    throw err;
  }
  emit("done");
}

/** Whether `dir` is missing, exists and is empty, or exists with contents. */
export async function remoteDirState(
  { facts, shell }: ProjectHost,
  dir: string,
): Promise<"missing" | "empty" | "nonempty"> {
  if (!(await facts.exists(dir))) return "missing";
  try {
    const out = await shell.exec("sh", ["-c", `ls -A ${shellQuote(dir)}`]);
    return out.trim() === "" ? "empty" : "nonempty";
  } catch {
    // `ls -A` on a plain file (not a directory) fails — treat it as
    // occupied rather than guessing at its contents.
    return "nonempty";
  }
}

/** Whether `dir` is already a git checkout whose `origin` is `repoUrl`. */
export async function remoteDirIsCloneOf(
  { git }: ProjectHost,
  dir: string,
  repoUrl: string,
): Promise<boolean> {
  try {
    // The stored URL, not `remote get-url`: that one applies the user's
    // `url.<base>.insteadOf` rewrites, so it would never match `repoUrl`.
    const out = await git.exec(dir, ["config", "--get", "remote.origin.url"]);
    return normalizeOriginUrl(out.trim()) === normalizeOriginUrl(repoUrl);
  } catch {
    return false;
  }
}

/**
 * `git clone --progress` through `git.cloneStream`, forwarding every
 * progress line to `emit` and enforcing `CLONE_TIMEOUT_MS` — a stalled
 * clone (e.g. waiting on a credential prompt `GIT_TERMINAL_PROMPT=0`
 * should have refused) must not hang the onboarding flow forever.
 */
export function cloneWithProgress(
  { git }: ProjectHost,
  repoUrl: string,
  targetDir: string,
  emit: CloneProgress,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    // `handle` isn't available until `cloneStream` returns, but the
    // timeout has to exist before then so a fake/synchronous backend
    // calling `onDone` immediately still has something to `clearTimeout`.
    let handle: { cancel: () => void } | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      handle?.cancel();
      reject(new Error(`git clone timed out after ${CLONE_TIMEOUT_MS / 1000}s`));
    }, CLONE_TIMEOUT_MS);
    handle = git.cloneStream(repoUrl, targetDir, {
      onLine: (line) => {
        emit("in-progress", line);
      },
      onDone: ({ exitCode, stderr }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (exitCode === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `git clone exited with code ${exitCode}`));
        }
      },
    });
  });
}
