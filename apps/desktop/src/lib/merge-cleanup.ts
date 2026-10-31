import type { PrInfo } from "./pr-info";
import type { ProjectInfo, WorkspaceInfo } from "../store/project-store";
import { removeWorktreeWithToast } from "../store/workspace-actions";
import { workspaceKey, type WorkspaceKey } from "./workspace-key";
import { toast } from "../toast";

/**
 * Workspaces whose PR went into a merge queue (or armed auto-merge) with
 * "Delete workspace after merge" ticked: removed once the PR poller sees the
 * PR merged. Kept in this renderer's storage so a restart in between still
 * cleans up, keyed by workspace with the PR's URL, so a new PR on the same
 * branch is not mistaken for the queued one.
 */
const STORAGE_KEY = "manor.mergeCleanups";

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function write(entries: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage full or refused: the workspace just stays, as if unticked.
  }
}

/** Remove the workspace `key` once its PR at `prUrl` merges. */
export function deleteWorkspaceWhenMerged(key: WorkspaceKey, prUrl: string): void {
  write({ ...read(), [key]: prUrl });
}

export function isDeletingWhenMerged(key: WorkspaceKey): boolean {
  return key in read();
}

/**
 * The poller's hook, for each fresh PR answer: removes a remembered
 * workspace whose PR has now merged, and forgets one whose PR closed
 * unmerged, saying so.
 */
export function settleMergeCleanup(
  project: ProjectInfo,
  ws: WorkspaceInfo,
  pr: PrInfo | null,
): void {
  const key = workspaceKey(project.hostId, ws.path);
  const entries = read();
  const url = entries[key];
  if (url === undefined || !pr || pr.url !== url || pr.state === "open") return;
  delete entries[key];
  write(entries);
  const name = ws.name || ws.branch;
  if (pr.state === "merged") {
    toast.success(`PR #${pr.number} merged: removing "${name}"`);
    void removeWorktreeWithToast(project, ws, true);
  } else {
    toast.info(`PR #${pr.number} closed without merging, so "${name}" stays`);
  }
}
