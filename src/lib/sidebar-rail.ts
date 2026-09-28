// Pure helpers for the collapsed sidebar rail (ADR-195).

import type { ProjectInfo, WorkspaceInfo } from "../store/project-store";
import { selectHost } from "../store/host-store";
import {
  buildSidebarItems,
  type SidebarItem,
  type TopLevelEntry,
} from "../utils/sidebar-items";
import { isRemoteHost } from "./hosts";

export type RailRow =
  | { kind: "host"; hostId: string | null }
  | { kind: "folder"; key: string; name: string; depth: number }
  | { kind: "workspace"; project: ProjectInfo; ws: WorkspaceInfo };

const EMOJI_RE = /\p{Extended_Pictographic}/u;

/** The glyph on a project's rail tile: a leading emoji, else its first letter. */
export function railTileLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // The project's TS lib predates Intl.Segmenter's typings.
  const Segmenter = (
    Intl as unknown as {
      Segmenter: new (
        locale?: string,
        options?: { granularity: "grapheme" },
      ) => { segment(s: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  const first = new Segmenter(undefined, { granularity: "grapheme" })
    .segment(trimmed)
    [Symbol.iterator]()
    .next().value?.segment;
  if (first && EMOJI_RE.test(first)) return first;
  const match = trimmed.match(/[\p{L}\p{N}]/u);
  return match ? match[0].toUpperCase() : "?";
}

/**
 * A remote project's main workspace is named for its box, not "local".
 * Null for local projects.
 */
export function remoteTargetForProject(
  project: Pick<ProjectInfo, "hostId">,
  hostState: Parameters<ReturnType<typeof selectHost>>[0],
): string | null {
  if (!isRemoteHost(project.hostId)) return null;
  const host = selectHost(project.hostId)(hostState);
  return host?.spec?.target ?? project.hostId;
}

export function workspaceDisplayName(
  ws: Pick<WorkspaceInfo, "isMain" | "name" | "branch">,
  remoteTarget: string | null,
): string {
  return ws.isMain
    ? ws.name || remoteTarget || "local"
    : ws.name || ws.branch || "main";
}

function visibleRows(
  project: ProjectInfo,
  items: SidebarItem[],
  depth: number,
): RailRow[] {
  const rows: RailRow[] = [];
  for (const item of items) {
    if (item.kind === "workspace") {
      if (!item.ws.hidden) rows.push({ kind: "workspace", project, ws: item.ws });
    } else {
      const children = visibleRows(project, item.children, depth + 1);
      if (children.length === 0) continue;
      rows.push({
        kind: "folder",
        key: item.folder.id,
        name: item.folder.name,
        depth,
      });
      rows.push(...children);
    }
  }
  return rows;
}

function projectRows(project: ProjectInfo): RailRow[] {
  const items = buildSidebarItems({
    workspaces: project.workspaces,
    folders: project.folders,
    sidebarOrder: project.sidebarOrder,
  });
  return visibleRows(project, items, 0);
}

/** Flat, tree-ordered rows for one top-level entry's rail popover. */
export function railWorkspaceRows(entry: TopLevelEntry): RailRow[] {
  if (entry.kind === "project") return projectRows(entry.project);
  const rows: RailRow[] = [];
  for (const section of entry.sections) {
    rows.push({ kind: "host", hostId: section.project.hostId ?? null });
    rows.push(...projectRows(section.project));
  }
  return rows;
}
