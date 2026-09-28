// Pure helpers for the collapsed sidebar rail (ADR-195).

import type { ProjectInfo, WorkspaceInfo } from "../store/project-store";
import { selectHost } from "../store/host-store";
import { isRemoteHost } from "./hosts";

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

/**
 * Where a resize drag flips between the full sidebar and the rail: its x in
 * px. Left of it the full sidebar collapses to the rail; right of it the
 * rail expands. Sits between the rail's 52px and the sidebar's 160px minimum.
 */
export const RAIL_SNAP_X = 110;
