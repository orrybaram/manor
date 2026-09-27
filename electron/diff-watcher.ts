import type { BrowserWindow } from "electron";
import { HostUnavailableError } from "./backend/host-view";
import { PerHostPoller, type HostBackends, type HostPath } from "./per-host-poller";
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
 * Polls diff stats for the open workspaces through a `PerHostPoller`
 * (ADR-183): each host is ticked on its own, so a remote host that is slow
 * or unreachable delays only its own workspaces' stats, never the local
 * ones. Each workspace's git runs on its own host's backend.
 */
export class DiffWatcher {
  private readonly poller: PerHostPoller<Record<string, DiffStats>>;
  private window: BrowserWindow | null = null;
  /** Each watched workspace's default branch, by path. */
  private defaultBranches = new Map<string, string>();
  // Paths discovered to not be git repos — skipped on subsequent ticks so we
  // don't re-run git (and re-log) every interval. Reset on each start().
  private nonGitPaths: Set<string> = new Set();

  constructor(private readonly hosts: HostBackends) {
    this.poller = new PerHostPoller<Record<string, DiffStats>>({
      label: "DiffWatcher",
      scan: (hostId, paths) => this.scan(hostId, paths),
      intervalMs: () => 5000,
      merge: (results) => Object.assign({}, ...results) as Record<string, DiffStats>,
      emit: (stats) => {
        console.log("[DiffWatcher] emitting diffs-changed:", stats);
        this.window?.webContents.send("diffs-changed", stats);
      },
    });
  }

  start(window: BrowserWindow, workspaces: readonly DiffWorkspace[]): void {
    this.window = window;
    // Force the first result to emit so a fresh/reloaded renderer gets stats.
    this.poller.reset({ reemit: true });
    this.defaultBranches = new Map(workspaces.map((ws) => [ws.path, ws.defaultBranch]));
    this.nonGitPaths.clear();
    this.poller.setEntries(workspaces);
    console.log("[DiffWatcher] started with", workspaces.length, "workspaces");
    this.poller.start({ immediate: true });
  }

  stop(): void {
    this.poller.stop();
  }

  private async scan(hostId: string, paths: string[]): Promise<Record<string, DiffStats>> {
    const result: Record<string, DiffStats> = {};

    const results = await Promise.allSettled(
      paths.map(async (wsPath) => {
        const stats = await this.getDiffStats(
          hostId,
          wsPath,
          this.defaultBranches.get(wsPath) ?? "main",
        );
        return { wsPath, stats };
      }),
    );

    for (const r of results) {
      if (r.status === "rejected" && r.reason instanceof HostUnavailableError) {
        // The whole host is unavailable: no partial result for it.
        throw r.reason;
      }
      if (r.status === "rejected") {
        console.error("[DiffWatcher] workspace scan rejected:", r.reason);
      } else if (r.value.stats) {
        result[r.value.wsPath] = r.value.stats;
      }
    }

    return result;
  }

  private async getDiffStats(
    hostId: string,
    wsPath: string,
    defaultBranch: string,
  ): Promise<DiffStats | null> {
    const git = this.hosts.get(hostId).git;
    // Skip paths already known to not be git repos (no rescan, no re-log).
    if (this.nonGitPaths.has(wsPath)) return null;

    // Try origin/<branch> first (more reliable in worktrees), fall back to local ref
    const refs = [`origin/${defaultBranch}`, defaultBranch];
    for (const ref of refs) {
      try {
        // Find the merge base so we only count changes since the branch point
        const mergeBaseOut = await git.exec(wsPath, [
          "merge-base",
          ref,
          "HEAD",
        ]);
        const mergeBase = mergeBaseOut.trim();

        // Diff working tree against merge base to include committed + staged + unstaged changes
        const diffOut = await git.exec(wsPath, [
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
        if (err instanceof HostUnavailableError) throw err;
        const msg = errorMessage(err);
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
