import type { PrInfo } from "./pr-info";
import type { ProjectInfo, WorkspaceInfo } from "../store/project-store";
import { removeWorktreeWithToast } from "../store/workspace-actions";
import { workspaceKey, type WorkspaceKey } from "./workspace-key";
import { toast } from "../toast";
import { usePreferencesStore } from "../store/preferences-store";

/**
 * Workspaces whose PR went into a merge queue (or armed auto-merge) with
 * "Delete workspace after merge" ticked: removed once the PR poller sees the
 * PR merged. Kept in the shared preferences, so a restart in between, or a
 * merge queued from the phone, still cleans up on the desk; keyed by
 * workspace with the PR's URL, so a new PR on the same branch is not taken
 * for the queued one.
 */
function read(): Record<string, string> {
  return usePreferencesStore.getState().preferences.mergeCleanups ?? {};
}

function write(entries: Record<string, string>): void {
  usePreferencesStore.getState().set("mergeCleanups", entries);
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
  const { [key]: url, ...rest } = read();
  if (url === undefined || !pr || pr.url !== url || pr.state === "open") return;
  write(rest);
  const name = ws.name || ws.branch;
  if (pr.state === "merged") {
    toast.success(`PR #${pr.number} merged: removing "${name}"`);
    void removeWorktreeWithToast(project, ws, true);
  } else {
    toast.info(`PR #${pr.number} closed without merging, so "${name}" stays`);
  }
}
