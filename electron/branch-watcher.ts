import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";

export class BranchWatcher {
  private workspacePaths: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBranches: Record<string, string> = {};
  private scanning = false;

  start(window: BrowserWindow, paths: string[]): void {
    this.stop();
    this.workspacePaths = paths;

    const tick = async () => {
      if (this.scanning) return;
      this.scanning = true;
      try {
        const branches = await this.scan();
        if (JSON.stringify(branches) !== JSON.stringify(this.lastBranches)) {
          window.webContents.send("branches-changed", branches);
          this.lastBranches = branches;
        }
      } finally {
        this.scanning = false;
      }
    };
    tick();
    this.timer = setInterval(tick, 2000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async scan(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    const paths = this.workspacePaths;
    if (!paths || paths.length === 0) return result;

    for (const wsPath of paths) {
      try {
        const branch = await this.readBranch(wsPath);
        if (branch) result[wsPath] = branch;
      } catch {
        // Not a git repo or unreadable — skip
      }
    }

    return result;
  }

  private async readBranch(wsPath: string): Promise<string | null> {
    const gitPath = path.join(wsPath, ".git");

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(gitPath);
    } catch {
      return null;
    }

    let headPath: string;

    if (stat.isDirectory()) {
      headPath = path.join(gitPath, "HEAD");
    } else if (stat.isFile()) {
      // Worktree: .git is a file containing "gitdir: <path>"
      const content = (await fs.promises.readFile(gitPath, "utf-8")).trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (!match) return null;
      const gitdir = path.isAbsolute(match[1])
        ? match[1]
        : path.resolve(wsPath, match[1]);
      headPath = path.join(gitdir, "HEAD");
    } else {
      return null;
    }

    let head: string;
    try {
      head = (await fs.promises.readFile(headPath, "utf-8")).trim();
    } catch {
      return null;
    }

    // Symbolic ref: "ref: refs/heads/<branch>"
    const refMatch = head.match(/^ref: refs\/heads\/(.+)$/);
    if (refMatch) return refMatch[1];

    // Detached HEAD — return short SHA
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 7);

    return null;
  }
}
