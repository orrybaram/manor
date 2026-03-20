import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserWindow } from "electron";

const execFileAsync = promisify(execFile);

export interface DiffStats {
  added: number;
  removed: number;
}

export class DiffWatcher {
  private workspaces: Map<string, string> = new Map(); // path → defaultBranch
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStats: Record<string, DiffStats> = {};
  private scanning = false;

  start(
    window: BrowserWindow,
    workspaces: Record<string, string>,
  ): void {
    this.stop();
    this.workspaces = new Map(Object.entries(workspaces));

    const tick = async () => {
      if (this.scanning) return; // skip if previous scan still running
      this.scanning = true;
      try {
        const stats = await this.scan();
        if (JSON.stringify(stats) !== JSON.stringify(this.lastStats)) {
          console.log("[DiffWatcher] emitting diffs-changed:", stats);
          window.webContents.send("diffs-changed", stats);
          this.lastStats = stats;
        }
      } finally {
        this.scanning = false;
      }
    };
    console.log("[DiffWatcher] started with", this.workspaces.size, "workspaces");
    tick();
    this.timer = setInterval(tick, 5000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async scan(): Promise<Record<string, DiffStats>> {
    const result: Record<string, DiffStats> = {};

    const entries = Array.from(this.workspaces.entries());
    const results = await Promise.allSettled(
      entries.map(async ([wsPath, defaultBranch]) => {
        const stats = await this.getDiffStats(wsPath, defaultBranch);
        return { wsPath, stats };
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.stats) {
        result[r.value.wsPath] = r.value.stats;
      }
    }

    return result;
  }

  private async getDiffStats(wsPath: string, defaultBranch: string): Promise<DiffStats | null> {
    // Try origin/<branch> first (more reliable in worktrees), fall back to local ref
    const refs = [`origin/${defaultBranch}`, defaultBranch];
    for (const ref of refs) {
      try {
        // Find the merge base so we only count changes since the branch point
        const { stdout: mergeBaseOut } = await execFileAsync(
          "git",
          ["merge-base", ref, "HEAD"],
          { cwd: wsPath, timeout: 5000 },
        );
        const mergeBase = mergeBaseOut.trim();

        // Diff working tree against merge base to include committed + staged + unstaged changes
        const { stdout: diffOut } = await execFileAsync(
          "git",
          ["diff", mergeBase, "--shortstat"],
          { cwd: wsPath, timeout: 5000 },
        );
        const output = diffOut.trim();

        if (!output) return null;

        const addMatch = output.match(/(\d+) insertion/);
        const removeMatch = output.match(/(\d+) deletion/);

        const added = addMatch ? parseInt(addMatch[1], 10) : 0;
        const removed = removeMatch ? parseInt(removeMatch[1], 10) : 0;

        if (added === 0 && removed === 0) return null;

        return { added, removed };
      } catch (err) {
        console.error(`[DiffWatcher] git diff failed for ${wsPath} with ref ${ref}:`, err instanceof Error ? err.message : err);
        continue;
      }
    }
    return null;
  }
}
