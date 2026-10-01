import type { ProjectInfo } from "../store/project-store";
import { isHomePath } from "./home";
import { find } from "./workspace-directory";
import { parseWorkspaceKey, type WorkspaceKey } from "./workspace-key";

/**
 * A workspace's display name: "Dashboard" for the Home surface (ADR-197),
 * which has no owning project or workspace record; otherwise its name, then
 * its branch, then the last segment of its path, so a workspace with neither
 * still shows something. Empty for no workspace at all.
 *
 * By key, so a local and a remote workspace at one path each name their own
 * workspace (ADR-191).
 */
export function workspaceDisplayName(
  key: WorkspaceKey | null | undefined,
  projects: readonly ProjectInfo[],
): string {
  if (!key) return "";
  const { path } = parseWorkspaceKey(key);
  if (isHomePath(path)) return "Dashboard";
  const ws = find(projects, key)?.workspace;
  return ws?.name || ws?.branch || path.split("/").pop() || "workspace";
}
