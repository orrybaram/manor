import type { AppSurface } from "../../store/app-store";
import type { ProjectInfo } from "../../store/project-store";
import { isHomePath } from "../../lib/home-path";
import { ownerOf } from "../../lib/workspace-directory";
import { buildTopLevelEntries } from "../../utils/sidebar-items";
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
  if (
    !activeWorkspaceKey ||
    isHomePath(parseWorkspaceKey(activeWorkspaceKey).path)
  ) {
    return null;
  }
  const project = ownerOf(projects, activeWorkspaceKey);
  return project?.id ?? null;
}

/**
 * A sidebar top-level entry the palette can be scoped to: one project, or a
 * group of linked checkouts (local + remote) searched as one.
 */
export type PaletteScopeEntry = {
  /** The project id the scope is stored as: the entry's first member. */
  id: string;
  name: string;
  color: string | null;
  /** Every project the entry covers. */
  memberIds: ReadonlySet<string>;
};

/** The palette's scope choices, in sidebar order. */
export function paletteScopeEntries(
  projects: readonly ProjectInfo[],
): PaletteScopeEntry[] {
  return buildTopLevelEntries(projects).map((entry) => {
    if (entry.kind === "project") {
      const { project } = entry;
      return {
        id: project.id,
        name: project.name,
        color: project.color,
        memberIds: new Set([project.id]),
      };
    }
    const first = entry.sections[0].project;
    return {
      id: first.id,
      name: entry.group.name,
      color: first.color,
      memberIds: new Set(entry.sections.map((s) => s.project.id)),
    };
  });
}

/** The entry covering `projectId` — its group when it's a linked checkout. */
export function scopeEntryOf(
  entries: readonly PaletteScopeEntry[],
  projectId: string,
): PaletteScopeEntry | null {
  return entries.find((e) => e.memberIds.has(projectId)) ?? null;
}
