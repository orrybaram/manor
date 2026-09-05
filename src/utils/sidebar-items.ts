// Pure view model for the sidebar's workspace list (ADR-167).
//
// `ProjectInfo.sidebarOrder` is a single normalized, depth-first array of
// workspace paths and folder ids. This module turns that array into an
// ordered item tree, applies drops and menu moves to the tree, and
// serializes a tree back to the canonical order. Nothing here touches React,
// the store, or IPC — the drag hook only produces a `DropTarget`, and the
// store only persists what `serializeOrder` returns.

import type { ProjectInfo, WorkspaceFolder, WorkspaceInfo } from "../store/project-store";

export type SidebarItem =
  | { kind: "workspace"; ws: WorkspaceInfo }
  | { kind: "folder"; folder: WorkspaceFolder; workspaces: WorkspaceInfo[] };

/** One drop slot in a drag. `parentFolderId` is null for top-level rows. */
export type Row = {
  key: string;
  kind: "workspace" | "folder";
  parentFolderId: string | null;
};

export type DropTarget =
  | { type: "slot"; rowIndex: number }
  | { type: "into"; folderId: string };

type FolderItem = Extract<SidebarItem, { kind: "folder" }>;

function isFolder(item: SidebarItem): item is FolderItem {
  return item.kind === "folder";
}

/**
 * Builds the ordered item tree from a project. Walks `sidebarOrder`: a folder
 * id yields a folder item (members are the visible workspaces pointing at it,
 * ordered by their own `sidebarOrder` index), a path yields a loose workspace
 * item when that workspace is visible and has no valid folder. Empty folders
 * are kept. Anything the order forgot is appended — defensive only, main
 * normalizes the array before the renderer sees it.
 */
export function buildSidebarItems(
  project: Pick<ProjectInfo, "workspaces" | "folders" | "sidebarOrder">,
): SidebarItem[] {
  const folderById = new Map(project.folders.map((f) => [f.id, f]));
  const orderIndex = new Map<string, number>();
  project.sidebarOrder.forEach((entry, i) => {
    if (!orderIndex.has(entry)) orderIndex.set(entry, i);
  });

  const membersByFolderId = new Map<string, WorkspaceInfo[]>();
  for (const folder of project.folders) membersByFolderId.set(folder.id, []);
  for (const ws of project.workspaces) {
    if (ws.hidden) continue;
    const members = ws.folderId ? membersByFolderId.get(ws.folderId) : undefined;
    if (members) members.push(ws);
  }
  for (const members of membersByFolderId.values()) {
    // Stable: paths missing from the order keep their `project.workspaces`
    // sequence at the end of the folder.
    members.sort(
      (a, b) =>
        (orderIndex.get(a.path) ?? Infinity) - (orderIndex.get(b.path) ?? Infinity),
    );
  }

  const wsByPath = new Map(project.workspaces.map((ws) => [ws.path, ws]));
  const items: SidebarItem[] = [];
  const emitted = new Set<string>();

  const pushFolder = (folder: WorkspaceFolder) => {
    emitted.add(folder.id);
    items.push({
      kind: "folder",
      folder,
      workspaces: membersByFolderId.get(folder.id) ?? [],
    });
  };
  const pushLoose = (ws: WorkspaceInfo) => {
    emitted.add(ws.path);
    items.push({ kind: "workspace", ws });
  };
  const isLoose = (ws: WorkspaceInfo) =>
    !ws.hidden && !(ws.folderId && folderById.has(ws.folderId));

  for (const entry of project.sidebarOrder) {
    if (emitted.has(entry)) continue;
    const folder = folderById.get(entry);
    if (folder) {
      pushFolder(folder);
      continue;
    }
    const ws = wsByPath.get(entry);
    if (ws && isLoose(ws)) pushLoose(ws);
  }

  for (const ws of project.workspaces) {
    if (!emitted.has(ws.path) && isLoose(ws)) pushLoose(ws);
  }
  for (const folder of project.folders) {
    if (!emitted.has(folder.id)) pushFolder(folder);
  }

  return items;
}

/**
 * The drop slots a drag of `dragging` runs against, in tree order.
 *
 * Dragging a folder collapses every top-level item to one row (a folder block
 * moves whole). Dragging a workspace emits a header row per folder followed
 * by its member rows, unless the folder is collapsed.
 */
export function flattenRows(
  items: SidebarItem[],
  collapsedFolderIds: Set<string>,
  dragging: "workspace" | "folder",
): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (!isFolder(item)) {
      rows.push({ key: item.ws.path, kind: "workspace", parentFolderId: null });
      continue;
    }
    rows.push({ key: item.folder.id, kind: "folder", parentFolderId: null });
    if (dragging === "folder") continue;
    if (collapsedFolderIds.has(item.folder.id)) continue;
    for (const ws of item.workspaces) {
      rows.push({
        key: ws.path,
        kind: "workspace",
        parentFolderId: item.folder.id,
      });
    }
  }
  return rows;
}

function removeWorkspace(
  items: SidebarItem[],
  path: string,
): { items: SidebarItem[]; ws: WorkspaceInfo | null } {
  let ws: WorkspaceInfo | null = null;
  const next: SidebarItem[] = [];
  for (const item of items) {
    if (!isFolder(item)) {
      if (item.ws.path === path) {
        ws = item.ws;
        continue;
      }
      next.push(item);
      continue;
    }
    const member = item.workspaces.find((w) => w.path === path);
    if (member) {
      ws = member;
      next.push({
        ...item,
        workspaces: item.workspaces.filter((w) => w.path !== path),
      });
    } else {
      next.push(item);
    }
  }
  return { items: next, ws };
}

function removeFolder(
  items: SidebarItem[],
  folderId: string,
): { items: SidebarItem[]; item: FolderItem | null } {
  const item = items.find((i) => isFolder(i) && i.folder.id === folderId) as
    | FolderItem
    | undefined;
  if (!item) return { items, item: null };
  return {
    items: items.filter((i) => i !== item),
    item,
  };
}

function insertLooseAt(
  items: SidebarItem[],
  index: number,
  ws: WorkspaceInfo,
): SidebarItem[] {
  const next = [...items];
  next.splice(clamp(index, 0, next.length), 0, { kind: "workspace", ws });
  return next;
}

function insertIntoFolderAt(
  items: SidebarItem[],
  folderId: string,
  index: number,
  ws: WorkspaceInfo,
): SidebarItem[] {
  return items.map((item) => {
    if (!isFolder(item) || item.folder.id !== folderId) return item;
    const workspaces = [...item.workspaces];
    workspaces.splice(clamp(index, 0, workspaces.length), 0, ws);
    return { ...item, workspaces };
  });
}

/** Index of the top-level item that owns `key` (a path or a folder id). */
function topLevelIndexOf(items: SidebarItem[], key: string): number {
  return items.findIndex((item) =>
    isFolder(item)
      ? item.folder.id === key || item.workspaces.some((w) => w.path === key)
      : item.ws.path === key,
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Applies a drop to the tree and returns a new one.
 *
 * `rows` is the row list the drag ran against (from `flattenRows`), and
 * `target.rowIndex` is the index the source lands on *after* it has been
 * pulled out — the `finalDrop` semantic of the old index-based drag hook. The
 * row preceding that position decides the parent: a member of an expanded
 * folder or that folder's header puts the source inside it, anything else
 * leaves it loose. Folders never nest.
 */
export function applyDrop(
  items: SidebarItem[],
  sourceKey: string,
  target: DropTarget,
  rows: Row[],
): SidebarItem[] {
  const sourceIsFolder = items.some(
    (item) => isFolder(item) && item.folder.id === sourceKey,
  );

  // Folders whose members were visible when the drag started. Read from the
  // original `rows` so dragging a folder's only member doesn't make its
  // folder look collapsed.
  const expandedFolderIds = new Set(
    rows
      .map((r) => r.parentFolderId)
      .filter((id): id is string => id != null),
  );

  // The row the source lands after, in the row list minus the source itself.
  const predecessorOf = (skip: (row: Row) => boolean): Row | undefined => {
    const rest = rows.filter((row) => !skip(row));
    const index = clamp(
      target.type === "slot" ? target.rowIndex : 0,
      0,
      rest.length,
    );
    return index > 0 ? rest[index - 1] : undefined;
  };

  if (sourceIsFolder) {
    // A folder can never land inside another folder.
    if (target.type === "into") return items;
    const { items: base, item } = removeFolder(items, sourceKey);
    if (!item) return items;
    const pred = predecessorOf(
      (row) => row.key === sourceKey || row.parentFolderId === sourceKey,
    );
    if (!pred) return [item, ...base];
    const anchor = pred.parentFolderId ?? pred.key;
    const at = topLevelIndexOf(base, anchor);
    const next = [...base];
    next.splice(at === -1 ? next.length : at + 1, 0, item);
    return next;
  }

  const { items: base, ws } = removeWorkspace(items, sourceKey);
  if (!ws) return items;

  if (target.type === "into") {
    const folder = base.find(
      (item): item is FolderItem =>
        isFolder(item) && item.folder.id === target.folderId,
    );
    if (!folder) return items;
    return insertIntoFolderAt(base, target.folderId, folder.workspaces.length, ws);
  }

  const pred = predecessorOf((row) => row.key === sourceKey);
  if (!pred) return insertLooseAt(base, 0, ws);

  if (pred.kind === "folder") {
    const folderId = pred.key;
    const exists = base.some(
      (item) => isFolder(item) && item.folder.id === folderId,
    );
    if (exists && expandedFolderIds.has(folderId)) {
      // Landing right under an expanded header means "first member".
      return insertIntoFolderAt(base, folderId, 0, ws);
    }
    const at = topLevelIndexOf(base, folderId);
    return insertLooseAt(base, at === -1 ? base.length : at + 1, ws);
  }

  if (pred.parentFolderId) {
    const folder = base.find(
      (item): item is FolderItem =>
        isFolder(item) && item.folder.id === pred.parentFolderId,
    );
    if (folder) {
      const memberIndex = folder.workspaces.findIndex((w) => w.path === pred.key);
      return insertIntoFolderAt(
        base,
        folder.folder.id,
        memberIndex === -1 ? folder.workspaces.length : memberIndex + 1,
        ws,
      );
    }
  }

  const at = topLevelIndexOf(base, pred.key);
  return insertLooseAt(base, at === -1 ? base.length : at + 1, ws);
}

/**
 * Canonical depth-first order for persistence: each top-level entry, a folder
 * id immediately followed by its members. Hidden workspaces aren't in the
 * tree, so their paths are appended afterwards in their previous relative
 * order, which keeps their slot stable across successive edits.
 */
export function serializeOrder(
  items: SidebarItem[],
  project: Pick<ProjectInfo, "workspaces" | "sidebarOrder">,
): string[] {
  const order: string[] = [];
  const emitted = new Set<string>();
  const push = (key: string) => {
    if (emitted.has(key)) return;
    emitted.add(key);
    order.push(key);
  };

  for (const item of items) {
    if (isFolder(item)) {
      push(item.folder.id);
      for (const ws of item.workspaces) push(ws.path);
    } else {
      push(item.ws.path);
    }
  }

  const previousIndex = new Map<string, number>();
  project.sidebarOrder.forEach((entry, i) => {
    if (!previousIndex.has(entry)) previousIndex.set(entry, i);
  });

  const hidden = project.workspaces
    .filter((ws) => ws.hidden && !emitted.has(ws.path))
    .sort(
      (a, b) =>
        (previousIndex.get(a.path) ?? Infinity) -
        (previousIndex.get(b.path) ?? Infinity),
    );
  for (const ws of hidden) push(ws.path);

  for (const ws of project.workspaces) push(ws.path);

  return order;
}

/** Folder membership implied by the tree: workspace path → folder id or null. */
export function membershipOf(items: SidebarItem[]): Map<string, string | null> {
  const membership = new Map<string, string | null>();
  for (const item of items) {
    if (isFolder(item)) {
      for (const ws of item.workspaces) membership.set(ws.path, item.folder.id);
    } else {
      membership.set(item.ws.path, null);
    }
  }
  return membership;
}

/** Menu "Move to Folder": pull the path out of wherever it is, append to F. */
export function placeInFolder(
  items: SidebarItem[],
  path: string,
  folderId: string,
): SidebarItem[] {
  const { items: base, ws } = removeWorkspace(items, path);
  if (!ws) return items;
  const target = base.find(
    (item): item is FolderItem => isFolder(item) && item.folder.id === folderId,
  );
  if (!target) return items;
  return insertIntoFolderAt(base, folderId, target.workspaces.length, ws);
}

/** Menu "Remove from Folder": leave F and sit loose immediately after it. */
export function placeAfterFolder(
  items: SidebarItem[],
  path: string,
  folderId: string,
): SidebarItem[] {
  const exists = items.some(
    (item) => isFolder(item) && item.folder.id === folderId,
  );
  if (!exists) return items;
  const { items: base, ws } = removeWorkspace(items, path);
  if (!ws) return items;
  const at = topLevelIndexOf(base, folderId);
  return insertLooseAt(base, at === -1 ? base.length : at + 1, ws);
}

/**
 * "New Folder…" from a row: the new folder takes that row's top-level slot
 * (the loose row itself, or the folder currently holding it). Any existing
 * item for the same folder is moved rather than duplicated.
 */
export function insertFolderBefore(
  items: SidebarItem[],
  folder: WorkspaceFolder,
  anchorPath: string,
): SidebarItem[] {
  const existing = items.find(
    (item): item is FolderItem => isFolder(item) && item.folder.id === folder.id,
  );
  const base = existing ? items.filter((item) => item !== existing) : items;
  const item: FolderItem = {
    kind: "folder",
    folder,
    workspaces: existing?.workspaces ?? [],
  };
  const at = topLevelIndexOf(base, anchorPath);
  const next = [...base];
  next.splice(at === -1 ? next.length : at, 0, item);
  return next;
}
