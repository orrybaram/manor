/**
 * Workspace folders and the sidebar order they live in (ADR-167/172), plus
 * the per-workspace settings kept beside them: names, hidden flags and
 * linked issues (ADR-183 split this out of `ProjectManager`).
 */

import crypto from "node:crypto";
import type { ProjectContext } from "./context";
import type { FolderLink, LinkedIssue, WorkspaceFolder } from "./types";

/**
 * Normalizes a persisted sidebar order against the current set of workspace
 * paths and folder ids: keeps known entries in order, drops unknown ones,
 * then appends any missing workspace paths (in git order) followed by any
 * missing folder ids (in `workspaceFolders` order).
 */
export function normalizeSidebarOrder(
  order: string[] | undefined,
  workspacePaths: string[],
  folderIds: string[],
): string[] {
  const knownPaths = new Set(workspacePaths);
  const knownFolderIds = new Set(folderIds);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of order ?? []) {
    if (seen.has(entry)) continue;
    if (knownPaths.has(entry) || knownFolderIds.has(entry)) {
      result.push(entry);
      seen.add(entry);
    }
  }

  for (const p of workspacePaths) {
    if (!seen.has(p)) {
      result.push(p);
      seen.add(p);
    }
  }
  for (const id of folderIds) {
    if (!seen.has(id)) {
      result.push(id);
      seen.add(id);
    }
  }

  return result;
}

/**
 * Removes a folder id from `order` and puts the keys it contained in its
 * place — member workspace paths and child folder ids alike — in
 * `memberKeys`' relative order, gathering any of them that are scattered
 * elsewhere in the array. If the folder id isn't present, the members are
 * appended to the end instead. Never duplicates a key.
 */
export function spliceFolderOut(
  order: string[],
  folderId: string,
  memberKeys: string[],
): string[] {
  const memberSet = new Set(memberKeys);
  const rest = order.filter(
    (entry) => entry !== folderId && !memberSet.has(entry),
  );
  const folderIndex = order.indexOf(folderId);
  if (folderIndex === -1) {
    return [...rest, ...memberKeys];
  }

  // Recompute where the folder id sits relative to `rest`: count how many
  // entries before it in `order` survive into `rest`.
  let insertAt = 0;
  for (let i = 0; i < folderIndex; i++) {
    const entry = order[i];
    if (entry !== folderId && !memberSet.has(entry)) insertAt++;
  }

  return [...rest.slice(0, insertAt), ...memberKeys, ...rest.slice(insertAt)];
}

/**
 * True when `candidateId` is `folderId` itself or sits anywhere below it in
 * the folder tree — the two parents a folder may never be given, because
 * either one cuts its subtree loose from the top level.
 *
 * Walks up from the candidate. A corrupt file could hold a cyclic parent
 * chain, so the walk is capped at the number of folders that exist: a chain
 * longer than that has already revisited a folder.
 */
export function isFolderDescendant(
  folders: readonly FolderLink[],
  folderId: string,
  candidateId: string | null | undefined,
): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let current = candidateId ?? null;
  for (let steps = 0; current != null && steps <= folders.length; steps++) {
    if (current === folderId) return true;
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}

export function createWorkspaceFolder(
  ctx: ProjectContext,
  projectId: string,
  name: string,
  parentId?: string | null,
): WorkspaceFolder | null {
  const project = ctx.find(projectId);
  if (!project) return null;
  const trimmed = name.trim();
  if (trimmed === "") return null;
  // A parent that names no folder of this project is stored as null rather
  // than rejected — the same forgiving rule `setWorkspaceFolder` uses.
  const parent =
    parentId != null &&
    project.workspaceFolders?.some((f) => f.id === parentId)
      ? parentId
      : null;
  const folder: WorkspaceFolder = {
    id: crypto.randomUUID(),
    name: trimmed,
    parentId: parent,
  };
  if (!project.workspaceFolders) project.workspaceFolders = [];
  project.workspaceFolders.push(folder);
  if (Array.isArray(project.workspaceOrder)) {
    project.workspaceOrder.push(folder.id);
  }
  ctx.store.save();
  return folder;
}

export function renameWorkspaceFolder(
  ctx: ProjectContext,
  projectId: string,
  folderId: string,
  name: string,
): void {
  const project = ctx.find(projectId);
  if (!project) return;
  const trimmed = name.trim();
  if (trimmed === "") return;
  const folder = project.workspaceFolders?.find((f) => f.id === folderId);
  if (!folder) return;
  folder.name = trimmed;
  ctx.store.save();
}

/**
 * Nests `folderId` inside `parentId` (or moves it to the top level with
 * null). Returns false — leaving the state untouched — for an unknown
 * folder or for a parent that would close a cycle.
 */
export function setFolderParent(
  ctx: ProjectContext,
  projectId: string,
  folderId: string,
  parentId: string | null,
): boolean {
  const project = ctx.find(projectId);
  if (!project) return false;
  const folders = project.workspaceFolders ?? [];
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) return false;
  const next =
    parentId != null && folders.some((f) => f.id === parentId)
      ? parentId
      : null;
  if (isFolderDescendant(folders, folderId, next)) return false;
  folder.parentId = next;
  ctx.store.save();
  return true;
}

export function deleteWorkspaceFolder(
  ctx: ProjectContext,
  projectId: string,
  folderId: string,
): void {
  const project = ctx.find(projectId);
  if (!project) return;

  // Deleting a folder promotes what it held rather than orphaning it: the
  // grandparent takes over, so a nested subtree stays reachable.
  const grandparentId =
    project.workspaceFolders?.find((f) => f.id === folderId)?.parentId ?? null;

  // Collect what the folder held — member paths and child folder ids — in
  // their current sidebarOrder position (entries not present in the order
  // go last, in insertion order).
  const memberKeys: string[] = [];
  if (project.workspaceFolderIds) {
    for (const [path, id] of Object.entries(project.workspaceFolderIds)) {
      if (id === folderId) memberKeys.push(path);
    }
  }
  for (const child of project.workspaceFolders ?? []) {
    if (child.parentId === folderId) memberKeys.push(child.id);
  }
  const order = project.workspaceOrder ?? [];
  const orderMap = new Map(order.map((entry, i) => [entry, i]));
  memberKeys.sort((a, b) => {
    const ai = orderMap.get(a) ?? Infinity;
    const bi = orderMap.get(b) ?? Infinity;
    return ai - bi;
  });

  if (project.workspaceFolders) {
    for (const child of project.workspaceFolders) {
      if (child.parentId === folderId) child.parentId = grandparentId;
    }
    project.workspaceFolders = project.workspaceFolders.filter(
      (f) => f.id !== folderId,
    );
  }
  if (project.workspaceFolderIds) {
    for (const [path, id] of Object.entries(project.workspaceFolderIds)) {
      if (id !== folderId) continue;
      if (grandparentId) {
        project.workspaceFolderIds[path] = grandparentId;
      } else {
        delete project.workspaceFolderIds[path];
      }
    }
  }
  if (project.workspaceOrder) {
    project.workspaceOrder = spliceFolderOut(
      project.workspaceOrder,
      folderId,
      memberKeys,
    );
  }
  ctx.store.save();
}

export function setWorkspaceFolder(
  ctx: ProjectContext,
  projectId: string,
  workspacePath: string,
  folderId: string | null,
): void {
  const project = ctx.find(projectId);
  if (!project) return;
  if (!project.workspaceFolderIds) project.workspaceFolderIds = {};
  const exists =
    folderId != null &&
    (project.workspaceFolders?.some((f) => f.id === folderId) ?? false);
  if (exists) {
    project.workspaceFolderIds[workspacePath] = folderId as string;
  } else {
    delete project.workspaceFolderIds[workspacePath];
  }
  ctx.store.save();
}

export function renameWorkspace(
  ctx: ProjectContext,
  projectId: string,
  workspacePath: string,
  newName: string,
): void {
  const project = ctx.find(projectId);
  if (!project) return;
  if (!project.workspaceNames) project.workspaceNames = {};
  if (newName.trim() === "") {
    delete project.workspaceNames[workspacePath];
  } else {
    project.workspaceNames[workspacePath] = newName.trim();
  }
  ctx.store.save();
}

export function setWorkspaceHidden(
  ctx: ProjectContext,
  projectId: string,
  workspacePath: string,
  hidden: boolean,
): void {
  const project = ctx.find(projectId);
  if (!project) return;
  if (!project.workspaceHidden) project.workspaceHidden = {};
  if (hidden) {
    project.workspaceHidden[workspacePath] = true;
  } else {
    delete project.workspaceHidden[workspacePath];
  }
  ctx.store.save();
}

/**
 * Persists the sidebar order verbatim. `orderedKeys` entries may be
 * workspace paths or folder ids (see ADR-167).
 */
export function reorderWorkspaces(
  ctx: ProjectContext,
  projectId: string,
  orderedKeys: string[],
): void {
  const project = ctx.find(projectId);
  if (!project) return;
  project.workspaceOrder = orderedKeys;
  ctx.store.save();
}

export function linkIssueToWorkspace(
  ctx: ProjectContext,
  projectId: string,
  workspacePath: string,
  issue: LinkedIssue,
): void {
  const project = ctx.find(projectId);
  if (!project) return;
  if (!project.workspaceIssues) project.workspaceIssues = {};
  const existing = project.workspaceIssues[workspacePath] ?? [];
  if (!existing.some((i) => i.id === issue.id)) {
    project.workspaceIssues[workspacePath] = [...existing, issue];
  }
  ctx.store.save();
}

export function unlinkIssueFromWorkspace(
  ctx: ProjectContext,
  projectId: string,
  workspacePath: string,
  issueId: string,
): void {
  const project = ctx.find(projectId);
  if (!project) return;
  if (!project.workspaceIssues) return;
  const existing = project.workspaceIssues[workspacePath] ?? [];
  project.workspaceIssues[workspacePath] = existing.filter(
    (i) => i.id !== issueId,
  );
  ctx.store.save();
}
