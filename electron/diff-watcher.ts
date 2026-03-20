import { execSync } from "node:child_process";
import type { BrowserWindow } from "electron";

export interface DiffStats {
  added: number;
  removed: number;
}

export class DiffWatcher {
  private workspaces: Map<string, string> = new Map(); // path → defaultBranch
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStats: Record<string, DiffStats> = {};

  start(
    window: BrowserWindow,
    workspaces: Record<string, string>,
  ): void {
    this.stop();
    this.workspaces = new Map(Object.entries(workspaces));

    const tick = () => {
      const stats = this.scan();
      if (JSON.stringify(stats) !== JSON.stringify(this.lastStats)) {
        console.log("[DiffWatcher] emitting diffs-changed:", stats);
        window.webContents.send("diffs-changed", stats);
        this.lastStats = stats;
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

  private scan(): Record<string, DiffStats> {
    const result: Record<string, DiffStats> = {};

    for (const [wsPath, defaultBranch] of this.workspaces) {
      try {
        const stats = this.getDiffStats(wsPath, defaultBranch);
        if (stats) result[wsPath] = stats;
      } catch {
        // Not a git repo or unreadable — skip
      }
    }

    return result;
  }

  private getDiffStats(wsPath: string, defaultBranch: string): DiffStats | null {
    // Try origin/<branch> first (more reliable in worktrees), fall back to local ref
    const refs = [`origin/${defaultBranch}`, defaultBranch];
    for (const ref of refs) {
      try {
        // Find the merge base so we only count changes since the branch point
        const mergeBase = execSync(
          `git merge-base ${ref} HEAD`,
          { cwd: wsPath, encoding: "utf-8", timeout: 5000 },
        ).trim();

        // Diff working tree against merge base to include committed + staged + unstaged changes
        const output = execSync(
          `git diff ${mergeBase} --shortstat`,
          { cwd: wsPath, encoding: "utf-8", timeout: 5000 },
        ).trim();

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
