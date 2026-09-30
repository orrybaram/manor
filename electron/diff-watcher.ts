import { createHash } from "node:crypto";
import type { BrowserWindow } from "electron";
import { HostUnavailableError } from "./backend/host-view";
import { workspaceKey, type WorkspaceKey } from "../src/lib/workspace-key";
import { PerHostPoller, type HostBackends, type HostPath } from "./per-host-poller";
import type { GitBackend } from "./backend/types";
import { errorMessage } from "./lib/errors";

export interface DiffStats {
  added: number;
  removed: number;
}

/** A workspace to watch: its path, its host, and the branch to diff against. */
export interface DiffWorkspace extends HostPath {
  defaultBranch: string;
}

/**
 * How many workspaces of one host are diffed at once. Each diff is a full
 * working-tree stat pass, so a host with many workspaces works through them
 * a few at a time instead of all at once.
 */
export const DIFF_CONCURRENCY = 3;

/**
 * At most this many changed or untracked files are content-hashed for a
 * workspace's fingerprint per tick (one `git hash-object` call). Past it, a
 * same-size edit to the rest is only seen once something else changes.
 */
const MAX_HASHED_PATHS = 256;

/**
 * One host's scan: stats for each workspace with changes, and a fingerprint
 * for each workspace git answered for.
 */
interface DiffScan {
  stats: Record<string, DiffStats>;
  /**
   * A hash of HEAD, the ref's commit, `git status` (staged and unstaged
   * changes, untracked files) and the content of every changed or untracked
   * file, per workspace. It changes whenever the workspace's diff or staged
   * files may have, so an open diff pane re-fetches only then (sent as
   * `diff-fingerprints-changed`).
   */
  fingerprints: Record<string, string>;
}

interface WorkspaceScan {
  stats: DiffStats | null;
  fingerprint: string;
}

/** A merge-base, valid while HEAD and the ref stay where they were. */
interface MergeBaseEntry {
  ref: string;
  head: string;
  refSha: string;
  mergeBase: string;
}

/**
 * Polls diff stats for the open workspaces through a `PerHostPoller`
 * (ADR-183): each host is ticked on its own, so a remote host that is slow
 * or unreachable delays only its own workspaces' stats, never the local
 * ones. Each workspace's git runs on its own host's backend, at most
 * `DIFF_CONCURRENCY` workspaces of a host at a time. A tick costs a
 * workspace `rev-parse`, `status` and (when it has changed or untracked
 * files) `hash-object`; the shortstat and merge-base run only when its
 * fingerprint has moved.
 */
export class DiffWatcher {
  private readonly poller: PerHostPoller<DiffScan>;
  private window: BrowserWindow | null = null;
  /** Each watched workspace's default branch, by key. */
  private defaultBranches = new Map<WorkspaceKey, string>();
  // Paths discovered to not be git repos — skipped on subsequent ticks so we
  // don't re-run git (and re-log) every interval. Reset on each start().
  private nonGitPaths: Set<WorkspaceKey> = new Set();
  /** Merge-base per workspace; recomputed only when the ref, HEAD or the ref's commit changes. */
  private mergeBases = new Map<WorkspaceKey, MergeBaseEntry>();
  /** Each workspace's last scan: its stats are reused while its fingerprint holds. */
  private lastScans = new Map<WorkspaceKey, WorkspaceScan>();
  /** What was last sent on each channel, so an unchanged half is not re-sent. */
  private sent: { stats: string; fingerprints: string } | null = null;

  constructor(private readonly hosts: HostBackends) {
    this.poller = new PerHostPoller<DiffScan>({
      label: "DiffWatcher",
      scan: (hostId, paths) => this.scan(hostId, paths),
      intervalMs: () => 5000,
      merge: (results) => ({
        stats: Object.assign({}, ...results.map((r) => r.stats)) as Record<string, DiffStats>,
        fingerprints: Object.assign({}, ...results.map((r) => r.fingerprints)) as Record<
          string,
          string
        >,
      }),
      emit: (merged) => this.emit(merged),
    });
  }

  start(window: BrowserWindow, workspaces: readonly DiffWorkspace[]): void {
    this.window = window;
    // Force the first result to emit so a fresh/reloaded renderer gets stats.
    this.poller.reset({ reemit: true });
    this.sent = null;
    this.defaultBranches = new Map(workspaces.map((ws) => [workspaceKey(ws.hostId, ws.path), ws.defaultBranch]));
    this.nonGitPaths.clear();
    for (const cache of [this.mergeBases, this.lastScans]) {
      for (const key of Array.from(cache.keys())) {
        if (!this.defaultBranches.has(key)) cache.delete(key);
      }
    }
    this.poller.setEntries(workspaces);
    console.log("[DiffWatcher] started with", workspaces.length, "workspaces");
    this.poller.start({ immediate: true });
  }

  stop(): void {
    this.poller.stop();
  }

  private emit(merged: DiffScan): void {
    const stats = JSON.stringify(merged.stats);
    const fingerprints = JSON.stringify(merged.fingerprints);
    const prev = this.sent;
    this.sent = { stats, fingerprints };
    if (prev?.fingerprints !== fingerprints) {
      this.window?.webContents.send("diff-fingerprints-changed", merged.fingerprints);
    }
    if (prev?.stats !== stats) {
      this.window?.webContents.send("diffs-changed", merged.stats);
    }
  }

  private async scan(hostId: string, paths: string[]): Promise<DiffScan> {
    const result: DiffScan = { stats: {}, fingerprints: {} };

    const results = await settleWithConcurrency(paths, DIFF_CONCURRENCY, async (wsPath) =>
      this.getDiffStats(
        hostId,
        wsPath,
        this.defaultBranches.get(workspaceKey(hostId, wsPath)) ?? "main",
      ),
    );

    for (const [i, r] of results.entries()) {
      if (r.status === "rejected" && r.reason instanceof HostUnavailableError) {
        // The whole host is unavailable: no partial result for it.
        throw r.reason;
      }
      if (r.status === "rejected") {
        console.error("[DiffWatcher] workspace scan rejected:", r.reason);
      } else if (r.value) {
        const key = workspaceKey(hostId, paths[i]);
        result.fingerprints[key] = r.value.fingerprint;
        if (r.value.stats) result.stats[key] = r.value.stats;
      }
    }

    return result;
  }

  private async getDiffStats(
    hostId: string,
    wsPath: string,
    defaultBranch: string,
  ): Promise<WorkspaceScan | null> {
    const git = this.hosts.get(hostId).git;
    // Skip paths already known to not be git repos (no rescan, no re-log).
    const key = workspaceKey(hostId, wsPath);
    if (this.nonGitPaths.has(key)) return null;

    // Try origin/<branch> first (more reliable in worktrees), fall back to local ref
    const refs = [`origin/${defaultBranch}`, defaultBranch];
    for (const ref of refs) {
      try {
        // Where HEAD and the ref point: cheap (no working-tree pass), and
        // the merge-base only needs recomputing when either has moved.
        const [head = "", refSha = ""] = (
          await git.exec(wsPath, ["rev-parse", "HEAD", ref])
        )
          .trim()
          .split("\n");
        // What the diff is made of besides HEAD: staged and unstaged
        // changes, untracked files, and the content of each changed file, so
        // a same-size edit or a `git add` from a terminal changes it too.
        // `--no-optional-locks`: a background poll must never hold
        // index.lock against the user's own git.
        const status = await git.exec(wsPath, [
          "--no-optional-locks",
          "status",
          "--porcelain=v2",
          "-z",
          "--untracked-files=all",
        ]);
        const hashes = await worktreeHashes(git, wsPath, status);
        const fingerprint = createHash("sha1")
          .update([ref, head, refSha, status, hashes].join("\0"))
          .digest("hex");
        const last = this.lastScans.get(key);
        if (last?.fingerprint === fingerprint) return last;

        let cached = this.mergeBases.get(key);
        if (!cached || cached.ref !== ref || cached.head !== head || cached.refSha !== refSha) {
          // Find the merge base so we only count changes since the branch point
          const mergeBase = (await git.exec(wsPath, ["merge-base", ref, "HEAD"])).trim();
          cached = { ref, head, refSha, mergeBase };
          this.mergeBases.set(key, cached);
        }

        // Diff working tree against merge base to include committed + staged + unstaged changes
        const diffOut = await git.exec(wsPath, [
          "diff",
          cached.mergeBase,
          "--shortstat",
        ]);
        const output = diffOut.trim();

        const addMatch = output.match(/(\d+) insertion/);
        const removeMatch = output.match(/(\d+) deletion/);

        const added = addMatch ? parseInt(addMatch[1], 10) : 0;
        const removed = removeMatch ? parseInt(removeMatch[1], 10) : 0;

        const scan: WorkspaceScan = {
          stats: added === 0 && removed === 0 ? null : { added, removed },
          fingerprint,
        };
        this.lastScans.set(key, scan);
        return scan;
      } catch (err) {
        if (err instanceof HostUnavailableError) throw err;
        const msg = errorMessage(err);
        // Directory isn't a git repo at all — ignore it completely and stop
        // scanning it on future ticks.
        if (msg.includes("not a git repository")) {
          this.nonGitPaths.add(key);
          return null;
        }
        // Silently skip refs that don't exist (e.g. local-only repo with no upstream)
        if (msg.includes("Not a valid object name") || msg.includes("unknown revision")) {
          continue;
        }
        console.error(
          `[DiffWatcher] git diff failed for ${wsPath} with ref ${ref}:`,
          msg,
        );
        continue;
      }
    }
    return null;
  }
}

/**
 * The files `git status --porcelain=v2 -z` (`status`) lists whose working
 * tree content can differ from what git has recorded for them: modified,
 * renamed or unmerged files still on disk, and untracked files. Submodules,
 * deleted files and untracked directories (a nested repo) are left out, as
 * `git hash-object` cannot hash them.
 */
export function pathsToHash(status: string): string[] {
  const paths: string[] = [];
  const records = status.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const fields = record.split(" ");
    const [xy = "", sub = ""] = fields.slice(1, 3);
    switch (record[0]) {
      case "1": // 1 XY sub mH mI mW hH hI path
        if (xy[1] !== "." && xy[1] !== "D" && sub[0] === "N") paths.push(fields.slice(8).join(" "));
        break;
      case "2": // 2 XY sub mH mI mW hH hI Xscore path, then origPath
        if (xy[1] !== "." && xy[1] !== "D" && sub[0] === "N") paths.push(fields.slice(9).join(" "));
        i++;
        break;
      case "u": // u XY sub m1 m2 m3 mW h1 h2 h3 path
        if (!xy.includes("D") && sub[0] === "N") paths.push(fields.slice(10).join(" "));
        break;
      case "?": {
        const path = record.slice(2);
        if (!path.endsWith("/")) paths.push(path);
        break;
      }
    }
  }
  return paths;
}

/**
 * The content hash of each file in `status` that `pathsToHash` names, up to
 * `MAX_HASHED_PATHS`, in one `git hash-object` call. Empty when there are none
 * or a file could not be hashed (it vanished since `status` ran, say): the
 * next tick's hashes then differ, and the pane re-fetches once.
 */
async function worktreeHashes(git: GitBackend, cwd: string, status: string): Promise<string> {
  const paths = pathsToHash(status).slice(0, MAX_HASHED_PATHS);
  if (paths.length === 0) return "";
  try {
    return await git.exec(cwd, ["hash-object", "--no-filters", "--", ...paths]);
  } catch (err) {
    if (err instanceof HostUnavailableError) throw err;
    return "";
  }
}

/**
 * `Promise.allSettled(items.map(fn))`, with at most `limit` calls of `fn`
 * running at once. Results are in `items` order.
 */
async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
