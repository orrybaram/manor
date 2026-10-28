/**
 * Which workspaces a tab or pane may move between: two workspaces of the
 * same project, on the same host (`LayoutStore.moveToWorkspace` refuses
 * another host from the keys alone). Cross-project moves are out of scope by
 * choice, and a path no project lists as a workspace is not a target.
 *
 * Kept out of `LayoutStore`, which never reads projects: a caller hands this
 * in as the move's `check`. Electron-free — the host server runs it too.
 */

import {
  LOCAL_HOST_ID,
  parseWorkspaceKey,
  type WorkspaceKey,
} from "../../src/lib/workspace-key";
import type { ProjectInfo } from "../projects/types";
import type { WorkspaceMoveCheck } from "./layout-store";

/** The project list, as far as this check reads it. */
export interface ProjectList {
  getProjects(): Promise<ProjectInfo[]>;
}

/** The project on `key`'s host that lists `key`'s path as a workspace. */
function ownerOf(
  projects: readonly ProjectInfo[],
  key: WorkspaceKey,
): ProjectInfo | undefined {
  const { hostId, path } = parseWorkspaceKey(key);
  return projects.find(
    (project) =>
      (project.hostId || LOCAL_HOST_ID) === hostId &&
      project.workspaces.some((workspace) => workspace.path === path),
  );
}

/** A {@link WorkspaceMoveCheck} over `projects`' workspaces. */
export function projectWorkspaceCheck(projects: ProjectList): WorkspaceMoveCheck {
  return async (from, to) => {
    const all = await projects.getProjects();
    const target = ownerOf(all, to);
    if (!target) return `Unknown workspace: ${parseWorkspaceKey(to).path}`;
    const source = ownerOf(all, from);
    if (!source) return `Unknown workspace: ${parseWorkspaceKey(from).path}`;
    if (source.id !== target.id) {
      return `Can't move to another project: ${parseWorkspaceKey(to).path} is in ${target.name}, not ${source.name}`;
    }
    return null;
  };
}
