import type { ProjectInfo } from "../store/project-store";
import { isHomePath } from "./home";

/**
 * A workspace's display name: "Home" for the Home surface, which has no
 * owning project or workspace record; otherwise its name, then its branch,
 * then the last segment of its path, so a workspace with neither still
 * shows something. Empty for no workspace at all.
 */
export function workspaceDisplayName(
  path: string | null | undefined,
  projects: readonly Pick<ProjectInfo, "workspaces">[],
): string {
  if (!path) return "";
  if (isHomePath(path)) return "Home";
  for (const project of projects) {
    const ws = project.workspaces.find((w) => w.path === path);
    if (ws) return ws.name || ws.branch || path.split("/").pop() || "workspace";
  }
  return path.split("/").pop() || "workspace";
}
