import type { AppSurface } from "../../store/app-store";
import type { ProjectInfo } from "../../store/project-store";
import { isHomePath } from "../../lib/home-path";
import type { PaletteOrigin } from "./types";

/**
 * Resolves the project the palette is scoped to. Opened from the sidebar
 * Search row it is global (`null`); opened via shortcut from a real workspace
 * it is scoped to that workspace's project.
 */
export function resolvePaletteScope(args: {
  origin: PaletteOrigin;
  activeSurface: AppSurface;
  activeWorkspacePath: string | null;
  projects: ProjectInfo[];
}): string | null {
  const { origin, activeSurface, activeWorkspacePath, projects } = args;
  if (origin === "search") return null;
  if (activeSurface !== "workspace") return null;
  if (!activeWorkspacePath || isHomePath(activeWorkspacePath)) return null;
  const project = projects.find((p) =>
    p.workspaces.some((w) => w.path === activeWorkspacePath),
  );
  return project?.id ?? null;
}
