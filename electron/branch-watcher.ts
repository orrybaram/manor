import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { LOCAL_HOST_ID, type GitBackend } from "./backend/types";
import { groupPathsByHost, type HostForPath } from "./backend/routed-backend";
import { HostUnavailableError } from "./backend/registry";

/**
 * Local, fs-based HEAD read for `wsPath` (a repo or worktree root). Cheap
 * enough to poll every 2s — shared with `readBranchSync` in `ipc/pty.ts`,
 * which uses the same logic synchronously for this machine's own checkout.
 */
export async function readLocalBranch(wsPath: string): Promise<string | null> {
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

/**
 * Polls the current branch for the open workspaces, one host at a time
 * (ADR-178 §3). The local host keeps the original 2s fs-based read — it's
 * cheap enough to poll that often. A remote host reads through the backend's
 * `git.currentBranch` (a `git rev-parse` on the box) on a slower 5s cadence,
 * skipping a tick while a previous one is still in flight so a slow or
 * unreachable host cannot pile up requests.
 */
export class BranchWatcher {
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private lastBranches: Record<string, string> = {};
  /** Latest branches per host, merged into `lastBranches` on every result. */
  private hostBranches = new Map<string, Record<string, string>>();
  private scanning = new Set<string>();
  private git: GitBackend;
  private hostForPath: HostForPath;

  constructor(git: GitBackend, hostForPath: HostForPath = () => LOCAL_HOST_ID) {
    this.git = git;
    this.hostForPath = hostForPath;
  }

  start(window: BrowserWindow, paths: string[]): void {
    this.stop();
    this.hostBranches = new Map();

    const groups = groupPathsByHost(paths, this.hostForPath);

    if (groups.size === 0) {
      // No open workspaces — emit once so the renderer clears out any
      // branches left over from before, matching the old single-host
      // watcher's behavior on an empty path list.
      this.emitIfChanged(window);
      return;
    }

    for (const [hostId, hostPaths] of groups) {
      const isLocal = hostId === LOCAL_HOST_ID;
      const interval = isLocal ? 2000 : 5000;

      const tick = async () => {
        if (this.scanning.has(hostId)) return;
        this.scanning.add(hostId);
        try {
          const branches = isLocal
            ? await this.scanLocal(hostPaths)
            : await this.scanRemote(hostPaths);
          this.hostBranches.set(hostId, branches);
          this.emitIfChanged(window);
        } catch (err) {
          if (err instanceof HostUnavailableError) return;
          console.error(`[BranchWatcher] scan on ${hostId} failed:`, err);
        } finally {
          this.scanning.delete(hostId);
        }
      };

      tick();
      this.timers.set(hostId, setInterval(tick, interval));
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.scanning.clear();
  }

  private emitIfChanged(window: BrowserWindow): void {
    const merged: Record<string, string> = {};
    for (const branches of this.hostBranches.values()) Object.assign(merged, branches);
    if (JSON.stringify(merged) !== JSON.stringify(this.lastBranches)) {
      window.webContents.send("branches-changed", merged);
      this.lastBranches = merged;
    }
  }

  private async scanLocal(paths: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const wsPath of paths) {
      try {
        const branch = await readLocalBranch(wsPath);
        if (branch) result[wsPath] = branch;
      } catch {
        // Not a git repo or unreadable — skip
      }
    }
    return result;
  }

  private async scanRemote(paths: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const settled = await Promise.allSettled(
      paths.map(async (wsPath) => ({
        wsPath,
        branch: await this.git.currentBranch(wsPath),
      })),
    );
    for (const r of settled) {
      if (r.status === "rejected") {
        // A host-wide failure (unreachable, reconnecting, ...) means no
        // partial result for it — the caller keeps the last known branches.
        if (r.reason instanceof HostUnavailableError) throw r.reason;
        console.error("[BranchWatcher] git currentBranch failed:", r.reason);
        continue;
      }
      if (r.value.branch) result[r.value.wsPath] = r.value.branch;
    }
    return result;
  }
}
