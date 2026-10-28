/**
 * Where a tab or pane may move: the other workspaces of its own project, on
 * its own host (`layout.moveToWorkspace`, which the server checks again).
 * A PTY lives on one host's daemon, and a move to another project is out of
 * scope by choice; Home is no project's workspace, so it is never a source
 * or a target. Hidden workspaces have no sidebar row, so they are not
 * offered either.
 *
 * The one answer the "Move to Workspace…" picker and the sidebar's drop
 * targets share. Pure: the project list in, keys out.
 */

import { find, keyOf, type DirectoryProject } from "./workspace-directory";
import type { WorkspaceKey } from "./workspace-key";

/** What a target needs of a workspace. */
interface TargetWorkspace {
  path: string;
  hidden?: boolean;
}

/** What a target needs of a project. `ProjectInfo` fits as is. */
interface TargetProject<W extends TargetWorkspace> extends DirectoryProject<W> {
  sidebarOrder?: readonly string[];
}

/** One workspace a tab or pane can move to. */
interface WorkspaceMoveTarget<P extends TargetProject<TargetWorkspace>> {
  key: WorkspaceKey;
  project: P;
  workspace: P["workspaces"][number];
}

/**
 * The workspaces a tab or pane in the workspace keyed `source` can move to,
 * in sidebar order: every other visible workspace of the project that lists
 * `source`, on `source`'s host. Empty for Home or a workspace no project has.
 */
export function workspaceMoveTargets<P extends TargetProject<TargetWorkspace>>(
  projects: readonly P[],
  source: WorkspaceKey,
): WorkspaceMoveTarget<P>[] {
  const found = find(projects, source);
  if (!found) return [];
  const { project } = found;
  const order = project.sidebarOrder ?? [];
  const rank = (path: string) => {
    const at = order.indexOf(path);
    return at < 0 ? order.length : at;
  };
  return project.workspaces
    .filter((ws) => !ws.hidden && keyOf(project, ws) !== source)
    .map((ws, index) => ({ ws, index }))
    // Stable: a workspace the order does not list keeps its list position.
    .sort((a, b) => rank(a.ws.path) - rank(b.ws.path) || a.index - b.index)
    .map(({ ws }) => ({ key: keyOf(project, ws), project, workspace: ws }));
}

/** Whether a tab or pane in `source` can move to the workspace keyed `target`. */
export function canMoveToWorkspace(
  projects: readonly TargetProject<TargetWorkspace>[],
  source: WorkspaceKey,
  target: WorkspaceKey,
): boolean {
  return workspaceMoveTargets(projects, source).some((t) => t.key === target);
}

/**
 * Whether a target labelled `label` on `branch` matches what was typed into
 * the picker: every word of `query`, case-insensitive, somewhere in either.
 */
export function matchesMoveQuery(
  label: string,
  branch: string | null | undefined,
  query: string,
): boolean {
  const haystack = `${label} ${branch ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}
