// Pure view model for the sidebar's workspace list (ADR-167, ADR-172).
//
// `ProjectInfo.sidebarOrder` is a single normalized, depth-first array of
// workspace paths and folder ids. This module turns that array into an
// ordered item tree, applies drops and menu moves to the tree, and
// serializes a tree back to the canonical order. Nothing here touches React,
// the store, or IPC — the drag hook only produces a `DropTarget`, and the
// store only persists what `serializeOrder` returns.
//
// Since ADR-172 folders nest: structure comes from the links (`parentId` for
// folders, `folderId` for workspaces) and position from `sidebarOrder`, so
// every function below is the recursive form of its ADR-167 self.

import type { ProjectInfo, WorkspaceFolder, WorkspaceInfo } from "../store/project-store";

export type SidebarItem =
  | { kind: "workspace"; ws: WorkspaceInfo }
  | { kind: "folder"; folder: WorkspaceFolder; children: SidebarItem[] };

/**
 * One drop slot in a drag. `parentFolderId` is null for top-level rows and
 * `depth` counts enclosing folders, so the drag hook can indent its insertion
 * line without walking the tree again.
 */
export type Row = {
  key: string;
  kind: "workspace" | "folder";
  parentFolderId: string | null;
  depth: number;
};

export type DropTarget =
  | { type: "slot"; rowIndex: number }
  | { type: "into"; folderId: string };

type FolderItem = Extract<SidebarItem, { kind: "folder" }>;

function isFolder(item: SidebarItem): item is FolderItem {
  return item.kind === "folder";
}

/** The key an item is addressed by: a workspace path or a folder id. */
function keyOf(item: SidebarItem): string {
  return isFolder(item) ? item.folder.id : item.ws.path;
}

/**
 * Each folder's usable parent.
 *
 * Main normalizes a dangling or self-referential parent to null, but it does
 * not untangle a longer cycle in a hand-edited file, and a cycle would make
 * the recursive build below unreachable (or endless). So a folder whose
 * parent chain never reaches the top level within the number of folders that
 * exist is read as top-level itself: every folder in the tangle surfaces,
 * nothing is hidden, and what remains is a forest.
 */
function resolveParents(
  folders: readonly WorkspaceFolder[],
): Map<string, string | null> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const parents = new Map<string, string | null>();
  for (const folder of folders) {
    let current = folder.parentId ?? null;
    let rooted = true;
    for (let steps = 0; current != null; steps++) {
      if (steps > folders.length || !byId.has(current)) {
        rooted = false;
        break;
      }
      current = byId.get(current)?.parentId ?? null;
    }
    const parent = folder.parentId ?? null;
    parents.set(folder.id, rooted && parent !== null ? parent : null);
  }
  return parents;
}

/**
 * Builds the ordered item tree from a project. A folder's children are the
 * visible workspaces pointing at it and the folders whose `parentId` is it,
 * ordered by their first index in `sidebarOrder`; anything the order forgot
 * is appended (workspaces before folders, in project order) — defensive only,
 * main normalizes the array before the renderer sees it. Empty folders are
 * kept, and a workspace whose folder id names no folder is loose.
 */
export function buildSidebarItems(
  project: Pick<ProjectInfo, "workspaces" | "folders" | "sidebarOrder">,
): SidebarItem[] {
  const folderById = new Map(project.folders.map((f) => [f.id, f]));
  const wsByPath = new Map(project.workspaces.map((ws) => [ws.path, ws]));
  const parentOf = resolveParents(project.folders);

  const orderIndex = new Map<string, number>();
  project.sidebarOrder.forEach((entry, i) => {
    if (!orderIndex.has(entry)) orderIndex.set(entry, i);
  });

  // Bucket every key under the parent that will hold it. Workspaces are
  // collected first so that, among the entries the order forgot, they come
  // before folders — `Array.prototype.sort` is stable.
  const childKeys = new Map<string | null, string[]>();
  const push = (parentId: string | null, key: string) => {
    const bucket = childKeys.get(parentId);
    if (bucket) bucket.push(key);
    else childKeys.set(parentId, [key]);
  };
  for (const ws of project.workspaces) {
    if (ws.hidden) continue;
    const folderId = ws.folderId && folderById.has(ws.folderId) ? ws.folderId : null;
    push(folderId, ws.path);
  }
  for (const folder of project.folders) {
    push(parentOf.get(folder.id) ?? null, folder.id);
  }
  for (const keys of childKeys.values()) {
    keys.sort(
      (a, b) => (orderIndex.get(a) ?? Infinity) - (orderIndex.get(b) ?? Infinity),
    );
  }

  const build = (parentId: string | null): SidebarItem[] =>
    (childKeys.get(parentId) ?? []).map((key) => {
      const folder = folderById.get(key);
      if (folder) {
        return { kind: "folder", folder, children: build(folder.id) };
      }
      return { kind: "workspace", ws: wsByPath.get(key)! };
    });

  return build(null);
}

/**
 * The drop slots a drag of `dragging` runs against, in tree order.
 *
 * A workspace drag sees every visible row: folder headers at any depth and
 * the members of expanded folders. A folder drag moves whole blocks, so it
 * sees folder headers (a folder may now land inside a folder) and loose
 * top-level workspaces, but not folders' members — and never anything inside
 * `draggingKey`'s own subtree, which travels with it.
 */
export function flattenRows(
  items: SidebarItem[],
  collapsedFolderIds: Set<string>,
  dragging: "workspace" | "folder",
  draggingKey?: string,
): Row[] {
  const rows: Row[] = [];
  const walk = (
    list: SidebarItem[],
    parentFolderId: string | null,
    depth: number,
  ) => {
    for (const item of list) {
      if (!isFolder(item)) {
        if (dragging === "folder" && parentFolderId !== null) continue;
        rows.push({ key: item.ws.path, kind: "workspace", parentFolderId, depth });
        continue;
      }
      const folderId = item.folder.id;
      rows.push({ key: folderId, kind: "folder", parentFolderId, depth });
      // The dragged folder still needs its own row — it is the source — but
      // its contents are not slots it can be dropped into.
      if (dragging === "folder" && folderId === draggingKey) continue;
      if (collapsedFolderIds.has(folderId)) continue;
      walk(item.children, folderId, depth + 1);
    }
  };
  walk(items, null, 0);
  return rows;
}

/** The folder item for `folderId`, at any depth. */
function findFolder(items: SidebarItem[], folderId: string): FolderItem | null {
  for (const item of items) {
    if (!isFolder(item)) continue;
    if (item.folder.id === folderId) return item;
    const nested = findFolder(item.children, folderId);
    if (nested) return nested;
  }
  return null;
}

/** Where `key` sits: the id of the folder holding it and its index there. */
function locate(
  items: SidebarItem[],
  key: string,
): { parentId: string | null; index: number } | null {
  const walk = (
    list: SidebarItem[],
    parentId: string | null,
  ): { parentId: string | null; index: number } | null => {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (keyOf(item) === key) return { parentId, index: i };
      if (isFolder(item)) {
        const nested = walk(item.children, item.folder.id);
        if (nested) return nested;
      }
    }
    return null;
  };
  return walk(items, null);
}

/** Pulls `key` (with its subtree, for a folder) out of the tree. */
function removeItem(
  items: SidebarItem[],
  key: string,
): { items: SidebarItem[]; item: SidebarItem | null } {
  let removed: SidebarItem | null = null;
  const walk = (list: SidebarItem[]): SidebarItem[] => {
    const next: SidebarItem[] = [];
    for (const item of list) {
      if (keyOf(item) === key) {
        removed = item;
        continue;
      }
      next.push(isFolder(item) ? { ...item, children: walk(item.children) } : item);
    }
    return next;
  };
  const nextItems = walk(items);
  return { items: removed ? nextItems : items, item: removed };
}

/**
 * Puts `item` into `parentId`'s children at `index` (a negative index or one
 * past the end appends). `parentId` null is the top level.
 */
function insertItem(
  items: SidebarItem[],
  parentId: string | null,
  index: number,
  item: SidebarItem,
): SidebarItem[] {
  if (parentId === null) {
    const next = [...items];
    next.splice(index < 0 ? next.length : clamp(index, 0, next.length), 0, item);
    return next;
  }
  return items.map((current) => {
    if (!isFolder(current)) return current;
    if (current.folder.id !== parentId) {
      return { ...current, children: insertItem(current.children, parentId, index, item) };
    }
    const children = [...current.children];
    children.splice(
      index < 0 ? children.length : clamp(index, 0, children.length),
      0,
      item,
    );
    return { ...current, children };
  });
}

/** Index of the top-level item whose subtree holds `key` (or is `key`). */
function topLevelIndexOf(items: SidebarItem[], key: string): number {
  return items.findIndex(
    (item) =>
      keyOf(item) === key ||
      (isFolder(item) && locate(item.children, key) !== null),
  );
}

/** Every key inside `item`, the item's own key included. */
function keysWithin(item: SidebarItem): Set<string> {
  const keys = new Set<string>();
  const walk = (current: SidebarItem) => {
    keys.add(keyOf(current));
    if (isFolder(current)) current.children.forEach(walk);
  };
  walk(item);
  return keys;
}

/**
 * True when `candidateId` is `folderId` itself or sits below it — the twin of
 * main's `isFolderDescendant`, reading the tree instead of the links, and the
 * reason a folder can never be dropped into its own subtree.
 */
export function isFolderDescendant(
  items: SidebarItem[],
  folderId: string,
  candidateId: string | null | undefined,
): boolean {
  if (candidateId == null) return false;
  if (candidateId === folderId) return true;
  const folder = findFolder(items, folderId);
  if (!folder) return false;
  return findFolder(folder.children, candidateId) !== null;
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
 * row preceding that position decides the parent, at any depth: an expanded
 * folder's header puts the source inside it as the first child, anything else
 * makes the source that row's next sibling. A folder dropped into itself or
 * one of its descendants is a no-op.
 */
export function applyDrop(
  items: SidebarItem[],
  sourceKey: string,
  target: DropTarget,
  rows: Row[],
): SidebarItem[] {
  const sourceIsFolder = findFolder(items, sourceKey) !== null;

  if (target.type === "into") {
    if (!findFolder(items, target.folderId)) return items;
    if (sourceIsFolder && isFolderDescendant(items, sourceKey, target.folderId)) {
      return items;
    }
    const { items: base, item } = removeItem(items, sourceKey);
    if (!item) return items;
    return insertItem(base, target.folderId, -1, item);
  }

  const { items: base, item } = removeItem(items, sourceKey);
  if (!item) return items;

  // Folders whose members were visible when the drag started. Read from the
  // original `rows` so dragging a folder's only member doesn't make its
  // folder look collapsed.
  const expandedFolderIds = new Set(
    rows.map((r) => r.parentFolderId).filter((id): id is string => id != null),
  );

  // The row the source lands after, in the row list minus the source and
  // whatever travelled with it.
  const moved = keysWithin(item);
  const rest = rows.filter((row) => !moved.has(row.key));
  const index = clamp(target.rowIndex, 0, rest.length);
  const pred = index > 0 ? rest[index - 1] : undefined;

  if (!pred) return insertItem(base, null, 0, item);

  if (
    pred.kind === "folder" &&
    expandedFolderIds.has(pred.key) &&
    findFolder(base, pred.key)
  ) {
    // Landing right under an expanded header means "first child".
    return insertItem(base, pred.key, 0, item);
  }

  const at = locate(base, pred.key);
  if (!at) return insertItem(base, null, base.length, item);
  return insertItem(base, at.parentId, at.index + 1, item);
}

/**
 * Canonical depth-first order for persistence: each entry, a folder id
 * immediately followed by its children, recursively. Hidden workspaces aren't
 * in the tree, so their paths are appended afterwards in their previous
 * relative order, which keeps their slot stable across successive edits.
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

  const walk = (list: SidebarItem[]) => {
    for (const item of list) {
      push(keyOf(item));
      if (isFolder(item)) walk(item.children);
    }
  };
  walk(items);

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
  const walk = (list: SidebarItem[], parentId: string | null) => {
    for (const item of list) {
      if (isFolder(item)) walk(item.children, item.folder.id);
      else membership.set(item.ws.path, parentId);
    }
  };
  walk(items, null);
  return membership;
}

/**
 * Folder nesting implied by the tree: folder id → parent id or null. Walked
 * parents-first, so a caller replaying the differences against main applies a
 * new parent before the children that move with it — a swap of two folders
 * never passes through a state main's cycle guard would reject.
 */
export function folderParentsOf(items: SidebarItem[]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  const walk = (list: SidebarItem[], parentId: string | null) => {
    for (const item of list) {
      if (!isFolder(item)) continue;
      parents.set(item.folder.id, parentId);
      walk(item.children, item.folder.id);
    }
  };
  walk(items, null);
  return parents;
}

/**
 * Every workspace in `item`'s subtree, in tree order. A folder header reports
 * what it holds at any depth — the count and the collapsed agent dot are
 * about the whole block, not just its direct members.
 */
export function descendantWorkspaces(item: SidebarItem): WorkspaceInfo[] {
  const workspaces: WorkspaceInfo[] = [];
  const walk = (current: SidebarItem) => {
    if (isFolder(current)) current.children.forEach(walk);
    else workspaces.push(current.ws);
  };
  walk(item);
  return workspaces;
}

/**
 * Menu "Move to Folder": pull `key` (a workspace path or a folder id) out of
 * wherever it is and append it to F. Moving a folder into itself or into its
 * own subtree is refused, the same rule the drag obeys.
 */
export function placeInFolder(
  items: SidebarItem[],
  key: string,
  folderId: string,
): SidebarItem[] {
  if (!findFolder(items, folderId)) return items;
  if (isFolderDescendant(items, key, folderId)) return items;
  const { items: base, item } = removeItem(items, key);
  if (!item) return items;
  return insertItem(base, folderId, -1, item);
}

/**
 * Menu "Remove from Folder": leave F and sit immediately after it, which at
 * the top level means loose and inside a nested F means one level up.
 */
export function placeAfterFolder(
  items: SidebarItem[],
  key: string,
  folderId: string,
): SidebarItem[] {
  if (!findFolder(items, folderId)) return items;
  const { items: base, item } = removeItem(items, key);
  if (!item) return items;
  const at = locate(base, folderId);
  if (!at) return insertItem(base, null, base.length, item);
  return insertItem(base, at.parentId, at.index + 1, item);
}

/**
 * "New Folder…" from a row: the new folder takes that row's top-level slot
 * (the loose row itself, or the outermost folder holding it), so the group it
 * creates sits where the eye already is. Any existing item for the same
 * folder is moved rather than duplicated.
 */
export function insertFolderBefore(
  items: SidebarItem[],
  folder: WorkspaceFolder,
  anchorKey: string,
): SidebarItem[] {
  const existing = findFolder(items, folder.id);
  const base = existing ? removeItem(items, folder.id).items : items;
  const item: FolderItem = {
    kind: "folder",
    folder,
    children: existing?.children ?? [],
  };
  const at = topLevelIndexOf(base, anchorKey);
  return insertItem(base, null, at === -1 ? base.length : at, item);
}
