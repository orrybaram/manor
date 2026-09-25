import type { BrowserWindow } from "electron";
import { LOCAL_HOST_ID, type GitBackend } from "./backend/types";
import type { HostForPath } from "./backend/routed-backend";

export interface DiffStats {
  added: number;
  removed: number;
}

/**
 * Polls diff stats for the open workspaces. Workspaces are grouped by host
 * and each host is ticked on its own: a remote host that is slow or
 * unreachable delays only its own workspaces' stats, never the local ones.
 */
export class DiffWatcher {
  private workspaces: Map<string, string> = new Map(); // path -> defaultBranch
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStats: Record<string, DiffStats> = {};
  /** Latest stats per host, merged into `lastStats` on every result. */
  private hostStats: Map<string, Record<string, DiffStats>> = new Map();
  private generation = 0;
  private git: GitBackend;
  private hostForPath: HostForPath;
  // Paths discovered to not be git repos — skipped on subsequent ticks so we
  // don't re-run git (and re-log) every interval. Reset on each start().
  private nonGitPaths: Set<string> = new Set();

  constructor(git: GitBackend, hostForPath: HostForPath = () => LOCAL_HOST_ID) {
    this.git = git;
    this.hostForPath = hostForPath;
  }

  start(window: BrowserWindow, workspaces: Record<string, string>): void {
    this.stop();
    const generation = ++this.generation;
    // Hosts with a tick in flight — per start(), so a tick left over from a
    // previous start() neither blocks nor is mistaken for a current one.
    const scanning = new Set<string>();
    // Force the first tick to emit so a fresh/reloaded renderer gets stats.
    this.lastStats = {};
    this.hostStats = new Map();
    this.workspaces = new Map(Object.entries(workspaces));
    this.nonGitPaths.clear();

    const groups = new Map<string, Array<[string, string]>>();
    for (const entry of this.workspaces) {
      const hostId = this.hostForPath(entry[0]);
      const group = groups.get(hostId);
      if (group) group.push(entry);
      else groups.set(hostId, [entry]);
    }

    const tickHost = async (
      hostId: string,
      entries: Array<[string, string]>,
    ) => {
      if (scanning.has(hostId)) return;
      scanning.add(hostId);
      try {
        const hostStats = await this.scan(entries);
        if (generation !== this.generation) return;
        this.hostStats.set(hostId, hostStats);
        const stats: Record<string, DiffStats> = {};
        for (const id of groups.keys()) {
          Object.assign(stats, this.hostStats.get(id));
        }
        const json = JSON.stringify(stats);
        if (json !== JSON.stringify(this.lastStats)) {
          console.log("[DiffWatcher] emitting diffs-changed:", stats);
          window.webContents.send("diffs-changed", stats);
          this.lastStats = stats;
        }
      } catch (err) {
        console.error("[DiffWatcher] scan tick failed:", err);
      } finally {
        scanning.delete(hostId);
      }
    };
    const tick = () => {
      for (const [hostId, entries] of groups) void tickHost(hostId, entries);
    };
    console.log(
      "[DiffWatcher] started with",
      this.workspaces.size,
      "workspaces",
    );
    tick();
    this.timer = setInterval(tick, 5000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async scan(
    entries: Array<[string, string]>,
  ): Promise<Record<string, DiffStats>> {
    const result: Record<string, DiffStats> = {};

    const results = await Promise.allSettled(
      entries.map(async ([wsPath, defaultBranch]) => {
        const stats = await this.getDiffStats(wsPath, defaultBranch);
        return { wsPath, stats };
      }),
    );

    for (const r of results) {
      if (r.status === "rejected") {
        console.error("[DiffWatcher] workspace scan rejected:", r.reason);
      } else if (r.value.stats) {
        result[r.value.wsPath] = r.value.stats;
      }
    }

    return result;
  }

  private async getDiffStats(
    wsPath: string,
    defaultBranch: string,
  ): Promise<DiffStats | null> {
    // Skip paths already known to not be git repos (no rescan, no re-log).
    if (this.nonGitPaths.has(wsPath)) return null;

    // Try origin/<branch> first (more reliable in worktrees), fall back to local ref
    const refs = [`origin/${defaultBranch}`, defaultBranch];
    for (const ref of refs) {
      try {
        // Find the merge base so we only count changes since the branch point
        const mergeBaseOut = await this.git.exec(wsPath, [
          "merge-base",
          ref,
          "HEAD",
        ]);
        const mergeBase = mergeBaseOut.trim();

        // Diff working tree against merge base to include committed + staged + unstaged changes
        const diffOut = await this.git.exec(wsPath, [
          "diff",
          mergeBase,
          "--shortstat",
        ]);
        const output = diffOut.trim();

        if (!output) return null;

        const addMatch = output.match(/(\d+) insertion/);
        const removeMatch = output.match(/(\d+) deletion/);

        const added = addMatch ? parseInt(addMatch[1], 10) : 0;
        const removed = removeMatch ? parseInt(removeMatch[1], 10) : 0;

        if (added === 0 && removed === 0) return null;

        return { added, removed };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Directory isn't a git repo at all — ignore it completely and stop
        // scanning it on future ticks.
        if (msg.includes("not a git repository")) {
          this.nonGitPaths.add(wsPath);
          return null;
        }
        // Silently skip refs that don't exist (e.g. local-only repo with no upstream)
        if (msg.includes("Not a valid object name")) {
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
