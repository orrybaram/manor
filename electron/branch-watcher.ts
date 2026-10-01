import fs from "node:fs";
import path from "node:path";
import { LOCAL_HOST_ID } from "./backend/types";
import { HostUnavailableError } from "./backend/host-view";
import { workspaceKey } from "../src/lib/workspace-key";
import { PerHostPoller, type HostBackends, type HostPath } from "./per-host-poller";
import { publishRendererBroadcast } from "./renderer-broadcast";

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
 * (ADR-178 §3), through a `PerHostPoller` (ADR-183). The local host keeps
 * the original 2s fs-based read — it's cheap enough to poll that often. A
 * remote host reads through its backend's `git.currentBranch` (a
 * `git rev-parse` on the box) on a slower 5s cadence; the poller skips a
 * tick while a previous one is still in flight, so a slow or unreachable
 * host cannot pile up requests. Results are keyed by `WorkspaceKey`
 * (ADR-204), so two hosts' identical paths stay apart.
 */
export class BranchWatcher {
  private readonly poller: PerHostPoller<Record<string, string>>;

  constructor(private readonly hosts: HostBackends) {
    this.poller = new PerHostPoller<Record<string, string>>({
      label: "BranchWatcher",
      scan: (hostId, paths) =>
        hostId === LOCAL_HOST_ID ? this.scanLocal(paths) : this.scanRemote(hostId, paths),
      intervalMs: (hostId) => (hostId === LOCAL_HOST_ID ? 2000 : 5000),
      merge: (results) => Object.assign({}, ...results) as Record<string, string>,
      emit: (branches) => publishRendererBroadcast("branches", "changed", branches),
    });
  }

  /**
   * Watch `workspaces`. With none, `{}` is emitted once so the renderer
   * clears out any branches left over from before; restarting with the
   * same branches emits nothing new.
   *
   * ADR-180 D5: there is no window argument. This used to push into one
   * `webContents`; a `branches.changed` broadcast reaches every renderer
   * attached to this host — both desktop windows and any paired browser —
   * through the bridge's sink, and the watcher goes back to not knowing
   * anything about windows.
   */
  start(workspaces: readonly HostPath[]): void {
    this.poller.reset({ reemit: false });
    this.poller.setEntries(workspaces);
    this.poller.start({ immediate: true });
  }

  stop(): void {
    this.poller.stop();
  }

  private async scanLocal(paths: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const wsPath of paths) {
      try {
        const branch = await readLocalBranch(wsPath);
        if (branch) result[workspaceKey(LOCAL_HOST_ID, wsPath)] = branch;
      } catch {
        // Not a git repo or unreadable — skip
      }
    }
    return result;
  }

  private async scanRemote(hostId: string, paths: string[]): Promise<Record<string, string>> {
    const git = this.hosts.get(hostId).git;
    const result: Record<string, string> = {};
    const settled = await Promise.allSettled(
      paths.map(async (wsPath) => ({
        wsPath,
        branch: await git.currentBranch(wsPath),
      })),
    );
    for (const r of settled) {
      if (r.status === "rejected") {
        // A host-wide failure (unreachable, reconnecting, ...) means no
        // partial result for it — the poller keeps the last known branches.
        if (r.reason instanceof HostUnavailableError) throw r.reason;
        console.error("[BranchWatcher] git currentBranch failed:", r.reason);
        continue;
      }
      if (r.value.branch) result[workspaceKey(hostId, r.value.wsPath)] = r.value.branch;
    }
    return result;
  }
}
