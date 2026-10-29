import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Ignored files a worktree's own work wrote: what `git worktree remove
 * --force` would wipe that git status never shows — a `.env`, a local
 * database, a report an agent left in a gitignored folder.
 *
 * Only this machine's files are read (`node:fs`); a remote host's worktree is
 * never asked here. Dependency and build output (`node_modules`, `dist`, …)
 * is skipped: it is made again by the next install or build. Everything else
 * ignored counts when it changed after `since` — the workspace's creation
 * plus a grace for its setup script.
 */

/** Ignored folders whose contents are made again, never the user's work. */
const REBUILT_DIRS = new Set([
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  "coverage",
]);

/** How many entries are stat'ed at most; past it, the answer is "can't tell". */
const IGNORED_SCAN_LIMIT = 2000;

/**
 * The first ignored path (relative to `root`) changed after `since`, or
 * "too-many" when more than `limit` entries would have to be looked at, or
 * null when none was. `entries` are git's ignored paths relative to `root`,
 * a folder as `dir/` (`git ls-files --others --ignored --directory`).
 * Throws when a path can't be read.
 */
export async function changedIgnoredPath(
  root: string,
  entries: readonly string[],
  since: number,
  limit = IGNORED_SCAN_LIMIT,
): Promise<string | "too-many" | null> {
  let budget = limit;
  const queue = entries.map((e) => e.replace(/\/+$/, "")).filter((e) => e !== "" && !isRebuilt(e));
  while (queue.length > 0) {
    const rel = queue.shift()!;
    if (budget-- <= 0) return "too-many";
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = await lstat(abs);
    } catch (err) {
      // Gone between git's listing and now: nothing left to lose.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (stat.mtimeMs > since) return rel;
    if (stat.isDirectory()) {
      for (const name of await readdir(abs)) {
        if (!REBUILT_DIRS.has(name)) queue.push(path.join(rel, name));
      }
    }
  }
  return null;
}

function isRebuilt(rel: string): boolean {
  return rel.split(/[\\/]/).some((segment) => REBUILT_DIRS.has(segment));
}
