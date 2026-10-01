import { createHash } from "node:crypto";
import type { BrowserWindow } from "electron";
import { HostUnavailableError } from "./backend/host-view";
import { workspaceKey, type WorkspaceKey } from "../src/lib/workspace-key";
import { PerHostPoller, type HostBackends, type HostPath } from "./per-host-poller";
import type { WorkspaceBackend } from "./backend/types";
import { MergeBaseCache, resolveBasePoint, type BasePoint } from "./backend/merge-base";
import { settleWithConcurrency } from "./lib/concurrency";
import { errorMessage } from "./lib/errors";
import { publishRendererBroadcast } from "./renderer-broadcast";

export interface DiffStats {
  added: number;
  removed: number;
}

/** A workspace to watch: its path, its host, and the branch to diff against. */
export interface DiffWorkspace extends HostPath {
  defaultBranch: string;
}

/**
 * How many workspaces of one host are scanned at once. Each scan is a full
 * working-tree stat pass, so a host with many workspaces works through them
 * a few at a time instead of all at once.
 */
export const DIFF_CONCURRENCY = 3;

/**
 * At most this many changed files are content-hashed, and this many untracked
 * files sized, for a workspace's fingerprint per tick. Past it, an edit to
 * the rest is only seen once something else changes.
 */
const MAX_FINGERPRINT_PATHS = 256;

/**
 * One host's scan: stats for each workspace with changes, and a fingerprint
 * for each workspace git answered for.
 */
interface DiffScan {
  stats: Record<WorkspaceKey, DiffStats>;
  /**
   * A hash of HEAD, the ref's commit, `git status` (staged and unstaged
   * changes, untracked files), the content of each changed tracked file and
   * the size of each untracked one, per workspace. It changes whenever the
   * workspace's diff or staged files may have, so an open diff pane
   * re-fetches only then (sent as `diff-fingerprints-changed`).
   */
  fingerprints: Record<WorkspaceKey, string>;
}

interface WorkspaceScan {
  stats: DiffStats | null;
  fingerprint: string;
}

/**
 * Polls diff stats for the open workspaces through a `PerHostPoller`
 * (ADR-183): each host is ticked on its own, so a remote host that is slow
 * or unreachable delays only its own workspaces' stats, never the local
 * ones. Each workspace's git runs on its own host's backend, at most
 * `DIFF_CONCURRENCY` workspaces of a host at a time. A tick costs a
 * workspace `rev-parse` and `status`, plus `hash-object` for changed files
 * and `wc -c` for untracked ones; the shortstat (and, when HEAD or the ref
 * moved, the merge-base) runs only when its fingerprint has moved. While the
 * window is hidden or minimized and no paired browser is watching, nothing
 * runs.
 */
export class DiffWatcher {
  private readonly poller: PerHostPoller<DiffScan>;
  private window: BrowserWindow | null = null;
  /** Each watched workspace's default branch, by key. */
  private defaultBranches = new Map<WorkspaceKey, string>();
  // Paths discovered to not be git repos — skipped on subsequent ticks so we
  // don't re-run git (and re-log) every interval. Reset on each start().
  private nonGitPaths: Set<WorkspaceKey> = new Set();
  private mergeBases = new MergeBaseCache<WorkspaceKey>();
  /** Each workspace's last scan: its stats are reused while its fingerprint holds. */
  private lastWorkspaceScans = new Map<WorkspaceKey, WorkspaceScan>();
  /** Each host's last scan, kept as its result while the window is hidden. */
  private lastHostScans = new Map<string, DiffScan>();
  /** The JSON last sent on each channel, so an unchanged half is not re-sent. */
  private lastSent: { stats: string; fingerprints: string } | null = null;
  /** Rescan as soon as the window is shown again, not on the next tick. */
  private readonly onWindowShown = () => {
    this.poller.scanAll().catch(() => {
      /* each host's failure is already reported by the poller */
    });
  };

  constructor(
    private readonly hosts: HostBackends,
    /**
     * Whether a paired device is subscribed to the diff events — a browser
     * still needs fresh stats while the desktop window is hidden. Defaults
     * to nobody.
     */
    private readonly deviceWatching: () => boolean = () => false,
  ) {
    this.poller = new PerHostPoller<DiffScan>({
      label: "DiffWatcher",
      scan: (hostId, paths) => this.scan(hostId, paths),
      intervalMs: () => 5000,
      merge: (results) => ({
        stats: mergeRecords(results.map((r) => r.stats)),
        fingerprints: mergeRecords(results.map((r) => r.fingerprints)),
      }),
      emit: (merged) => this.emit(merged),
    });
  }

  /**
   * ADR-180 D5: results are published as `diffs.changed` /
   * `diffs.fingerprintsChange` to every renderer — desktop windows and paired
   * browsers alike — rather than pushed at one window. `window` is only the
   * visibility gate: while it is hidden or minimized, and no paired device
   * is subscribed (`deviceWatching`), no git runs (each host keeps its last
   * result). The handler passes the primary window; a browser watching while
   * the desk is minimized keeps the polling going.
   */
  start(workspaces: readonly DiffWorkspace[], window: BrowserWindow | null): void {
    if (window) this.watchWindow(window);
    // Force the first result to emit so a fresh/reloaded renderer gets stats.
    this.poller.reset({ reemit: true });
    this.lastSent = null;
    this.defaultBranches = new Map(workspaces.map((ws) => [workspaceKey(ws.hostId, ws.path), ws.defaultBranch]));
    this.nonGitPaths.clear();
    this.lastHostScans.clear();
    const watched = (key: WorkspaceKey) => this.defaultBranches.has(key);
    this.mergeBases.prune(watched);
    for (const key of Array.from(this.lastWorkspaceScans.keys())) {
      if (!watched(key)) this.lastWorkspaceScans.delete(key);
    }
    this.poller.setEntries(workspaces);
    console.log("[DiffWatcher] started with", workspaces.length, "workspaces");
    this.poller.start({ immediate: true });
  }

  stop(): void {
    this.poller.stop();
  }

  private watchWindow(window: BrowserWindow): void {
    if (this.window === window) return;
    if (this.window && !this.window.isDestroyed()) {
      this.window.off("show", this.onWindowShown);
      this.window.off("restore", this.onWindowShown);
    }
    this.window = window;
    window.on("show", this.onWindowShown);
    window.on("restore", this.onWindowShown);
  }

  private windowHidden(): boolean {
    const w = this.window;
    return !!w && !w.isDestroyed() && (!w.isVisible() || w.isMinimized());
  }

  private emit(merged: DiffScan): void {
    const stats = JSON.stringify(merged.stats);
    const fingerprints = JSON.stringify(merged.fingerprints);
    const prev = this.lastSent;
    this.lastSent = { stats, fingerprints };
    if (prev?.fingerprints !== fingerprints) {
      publishRendererBroadcast("diffs", "fingerprintsChange", merged.fingerprints);
    }
    if (prev?.stats !== stats) {
      publishRendererBroadcast("diffs", "changed", merged.stats);
    }
  }

  private async scan(hostId: string, paths: string[]): Promise<DiffScan> {
    // Nobody can see the badges: keep the host's last result, run no git.
    const previous = this.lastHostScans.get(hostId);
    if (previous && this.windowHidden() && !this.deviceWatching()) {
      return previous;
    }

    const result: DiffScan = { stats: {}, fingerprints: {} };
    const results = await settleWithConcurrency(paths, DIFF_CONCURRENCY, (wsPath) =>
      this.scanWorkspace(
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

    this.lastHostScans.set(hostId, result);
    return result;
  }

  /** A workspace's fingerprint, and its stats (reused while the fingerprint holds). */
  private async scanWorkspace(
    hostId: string,
    wsPath: string,
    defaultBranch: string,
  ): Promise<WorkspaceScan | null> {
    const backend = this.hosts.get(hostId);
    const git = (args: string[]) => backend.git.exec(wsPath, args);
    // Skip paths already known to not be git repos (no rescan, no re-log).
    const key = workspaceKey(hostId, wsPath);
    if (this.nonGitPaths.has(key)) return null;

    // Try origin/<branch> first (more reliable in worktrees), fall back to local ref
    const refs = [`origin/${defaultBranch}`, defaultBranch];
    for (const ref of refs) {
      try {
        const point = await resolveBasePoint(git, ref);
        const fingerprint = await workspaceFingerprint(backend, wsPath, point);
        const last = this.lastWorkspaceScans.get(key);
        if (last?.fingerprint === fingerprint) return last;

        const mergeBase = await this.mergeBases.get(key, point, git);
        // Diff working tree against merge base to include committed + staged + unstaged changes
        const output = (await git(["diff", mergeBase, "--shortstat"])).trim();

        const addMatch = output.match(/(\d+) insertion/);
        const removeMatch = output.match(/(\d+) deletion/);

        const added = addMatch ? parseInt(addMatch[1], 10) : 0;
        const removed = removeMatch ? parseInt(removeMatch[1], 10) : 0;

        const scan: WorkspaceScan = {
          stats: added === 0 && removed === 0 ? null : { added, removed },
          fingerprint,
        };
        this.lastWorkspaceScans.set(key, scan);
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
 * A hash of what the workspace's diff is made of besides the merge-base:
 * `git status` (staged and unstaged changes, untracked files), the content of
 * each changed tracked file (so a same-size edit counts) and the size of each
 * untracked one. Untracked files are sized, never read, so a binary or huge
 * one costs nothing; a same-size rewrite of one goes unseen until something
 * else changes.
 */
async function workspaceFingerprint(
  backend: WorkspaceBackend,
  cwd: string,
  point: BasePoint,
): Promise<string> {
  // `--no-optional-locks`: a background poll must never hold index.lock
  // against the user's own git. `-uall` names each untracked file, so a new
  // file inside a new directory counts too.
  const status = await backend.git.exec(cwd, [
    "--no-optional-locks",
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
  ]);
  const { changed, untracked } = filesToFingerprint(status);
  const [contents, sizes] = await Promise.all([
    outputOrEmpty(changed, (paths) =>
      backend.git.exec(cwd, ["hash-object", "--no-filters", "--", ...paths]),
    ),
    outputOrEmpty(untracked, (paths) =>
      backend.shell.exec("wc", ["-c", "--", ...paths], { cwd, timeout: 10000 }),
    ),
  ]);
  return createHash("sha1")
    .update([point.ref, point.head, point.refSha, status, contents, sizes].join("\0"))
    .digest("hex");
}

/**
 * `run`'s output over the first `MAX_FINGERPRINT_PATHS` of `paths`; "" when
 * there are none or it fails (a file vanished since `status` ran, say): the
 * next tick's output then differs, and the pane re-fetches once.
 */
async function outputOrEmpty(
  paths: string[],
  run: (paths: string[]) => Promise<string>,
): Promise<string> {
  if (paths.length === 0) return "";
  try {
    return await run(paths.slice(0, MAX_FINGERPRINT_PATHS));
  } catch (err) {
    if (err instanceof HostUnavailableError) throw err;
    return "";
  }
}

/** A tracked entry's worktree side still has a file on disk that git has not recorded. */
const worktreeChanged = (xy: string) => xy[1] !== "." && xy[1] !== "D";

/**
 * Per `git status --porcelain=v2` record type: which space-separated field
 * the path starts at, and whether the entry has worktree content to hash.
 */
const TRACKED_RECORDS: Record<string, { pathField: number; changed: (xy: string) => boolean }> = {
  // 1 XY sub mH mI mW hH hI path
  "1": { pathField: 8, changed: worktreeChanged },
  // 2 XY sub mH mI mW hH hI Xscore path, then origPath as its own record
  "2": { pathField: 9, changed: worktreeChanged },
  // u XY sub m1 m2 m3 mW h1 h2 h3 path
  u: { pathField: 10, changed: (xy) => !xy.includes("D") },
};

/**
 * The files in `status` (`git status --porcelain=v2 -z`) whose content can
 * change without `status` changing: tracked files modified, renamed or
 * unmerged and still on disk (`changed`), and untracked files (`untracked`).
 * Submodules, deleted files and untracked directories (a nested repo) are
 * left out.
 */
export function filesToFingerprint(status: string): { changed: string[]; untracked: string[] } {
  const changed: string[] = [];
  const untracked: string[] = [];
  const records = status.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith("? ")) {
      const path = record.slice(2);
      if (!path.endsWith("/")) untracked.push(path);
      continue;
    }
    const type = TRACKED_RECORDS[record[0]];
    if (!type) continue;
    if (record[0] === "2") i++; // skip its origPath record
    const fields = record.split(" ");
    const [xy = "", sub = ""] = fields.slice(1, 3);
    if (sub[0] === "N" && type.changed(xy)) changed.push(fields.slice(type.pathField).join(" "));
  }
  return { changed, untracked };
}

/** Every record's entries in one; a later record wins a shared key. */
function mergeRecords<V>(records: readonly Record<WorkspaceKey, V>[]): Record<WorkspaceKey, V> {
  return Object.assign({}, ...records) as Record<WorkspaceKey, V>;
}
