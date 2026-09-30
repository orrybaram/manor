import type { AppSurface } from "../../store/app-store";
import type { ProjectInfo } from "../../store/project-store";
import { isHomePath } from "../../lib/home-path";
import { ownerOf } from "../../lib/workspace-directory";
import { parseWorkspaceKey, type WorkspaceKey } from "../../lib/workspace-key";
import type { PaletteOrigin } from "./types";

/**
 * Resolves the project the palette is scoped to. Opened from the sidebar
 * Search row it is global (`null`); opened via shortcut from a real workspace
 * it is scoped to that workspace's project.
 */
export function resolvePaletteScope(args: {
  origin: PaletteOrigin;
  activeSurface: AppSurface;
  activeWorkspaceKey: WorkspaceKey | null;
  projects: ProjectInfo[];
}): string | null {
  const { origin, activeSurface, activeWorkspaceKey, projects } = args;
  if (origin === "search") return null;
  if (activeSurface !== "workspace") return null;
  if (!activeWorkspaceKey || isHomePath(parseWorkspaceKey(activeWorkspaceKey).path)) {
    return null;
  }
  const project = ownerOf(projects, activeWorkspaceKey);
  return project?.id ?? null;
}
