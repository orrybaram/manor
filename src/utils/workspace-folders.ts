// Pure grouping/ordering helpers for ADR-166 workspace folders.
//
// `groupWorkspaces` derives the sidebar's render shape (loose workspaces,
// then folders in creation order, each with their own member list) from the
// flat `project.workspaces` + `project.folders` arrays. `mergeSectionOrder`
// takes a reordered subset (one section's drag result) and rewrites just
// those slots in the full project order, so `reorderWorkspaces` keeps
// receiving a full `orderedPaths` array without the caller needing to know
// about other sections.

import type { ProjectInfo, WorkspaceFolder, WorkspaceInfo } from "../store/project-store";

interface FolderGroup {
  folder: WorkspaceFolder;
  workspaces: WorkspaceInfo[];
}

export interface GroupedWorkspaces {
  loose: WorkspaceInfo[];
  folders: FolderGroup[];
}

/**
 * Splits a project's workspaces into the "loose" (ungrouped) list and one
 * group per folder, preserving `project.workspaces` order within each
 * section. Hidden workspaces are excluded entirely. Folders with no members
 * are still included (in `project.folders` order) so an empty, freshly
 * created folder is visible.
 */
export function groupWorkspaces(
  project: Pick<ProjectInfo, "workspaces" | "folders">,
): GroupedWorkspaces {
  const folderIds = new Set(project.folders.map((f) => f.id));
  const loose: WorkspaceInfo[] = [];
  const membersByFolderId = new Map<string, WorkspaceInfo[]>();
  for (const folder of project.folders) {
    membersByFolderId.set(folder.id, []);
  }

  for (const ws of project.workspaces) {
    if (ws.hidden) continue;
    if (ws.folderId && folderIds.has(ws.folderId)) {
      membersByFolderId.get(ws.folderId)!.push(ws);
    } else {
      loose.push(ws);
    }
  }

  const folders: FolderGroup[] = project.folders.map((folder) => ({
    folder,
    workspaces: membersByFolderId.get(folder.id) ?? [],
  }));

  return { loose, folders };
}

/**
 * Given the full project order (`allPaths`) and a reordered subset
 * (`sectionPaths`, e.g. the result of dragging within one folder), returns
 * the full order with that subset's slots rewritten in the new sequence.
 * Paths in `sectionPaths` missing from `allPaths` are appended at the end.
 */
export function mergeSectionOrder(
  allPaths: string[],
  sectionPaths: string[],
): string[] {
  const sectionSet = new Set(sectionPaths);
  let sectionIdx = 0;
  const result: string[] = [];

  for (const path of allPaths) {
    if (sectionSet.has(path)) {
      result.push(sectionPaths[sectionIdx]);
      sectionIdx++;
    } else {
      result.push(path);
    }
  }

  const allPathsSet = new Set(allPaths);
  for (const path of sectionPaths) {
    if (!allPathsSet.has(path)) {
      result.push(path);
    }
  }

  return result;
}
