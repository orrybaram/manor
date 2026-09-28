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

import type {
  ProjectGroupInfo,
  ProjectInfo,
  WorkspaceFolder,
  WorkspaceInfo,
} from "../store/project-store";
import { groupHostIds } from "../lib/project-groups";

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
 * opens only the folders the dragged one sits inside — it can move among its
 * own siblings, workspaces included, and out through its parents — while
 * every other folder stays one row for its whole block. It never sees
 * anything inside `draggingKey`'s own subtree, which travels with it.
 *
 * A folder's children are rows exactly when the folder is open here, which is
 * what the drag hook reads to measure a folder by its header or its block.
 */
export function flattenRows(
  items: SidebarItem[],
  collapsedFolderIds: Set<string>,
  dragging: "workspace" | "folder",
  draggingKey?: string,
): Row[] {
  const opened =
    dragging === "folder" && draggingKey !== undefined
      ? enclosingFolderIds(items, draggingKey)
      : null;
  const rows: Row[] = [];
  const walk = (
    list: SidebarItem[],
    parentFolderId: string | null,
    depth: number,
  ) => {
    for (const item of list) {
      if (!isFolder(item)) {
        rows.push({ key: item.ws.path, kind: "workspace", parentFolderId, depth });
        continue;
      }
      const folderId = item.folder.id;
      rows.push({ key: folderId, kind: "folder", parentFolderId, depth });
      if (collapsedFolderIds.has(folderId)) continue;
      // The dragged folder is not its own ancestor, so its contents are never
      // offered as slots it could be dropped into.
      if (opened && !opened.has(folderId)) continue;
      walk(item.children, folderId, depth + 1);
    }
  };
  walk(items, null, 0);
  return rows;
}

/** Ids of every folder enclosing `key`, at any depth. */
function enclosingFolderIds(items: SidebarItem[], key: string): Set<string> {
  const walk = (list: SidebarItem[], trail: string[]): string[] | null => {
    for (const item of list) {
      if (keyOf(item) === key) return trail;
      if (!isFolder(item)) continue;
      const found = walk(item.children, [...trail, item.folder.id]);
      if (found) return found;
    }
    return null;
  };
  return new Set(walk(items, []) ?? []);
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
 * "New Folder…" from a row: the new folder claims that row's slot *inside the
 * folder the row already lives in*, so the group it creates sits where the eye
 * already is and at the depth the eye is already at — "New Folder…" on a
 * workspace nested in `epic` makes `epic / new-folder` holding that workspace,
 * not a sibling of `epic` (ADR-172). An anchor the tree has never heard of
 * appends at the top level, and an existing item for the same folder is moved
 * rather than duplicated.
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
  const at = locate(base, anchorKey);
  if (!at) return insertItem(base, null, base.length, item);
  return insertItem(base, at.parentId, at.index, item);
}

/**
 * Depth-first order of every visible workspace path (ADR-190 §1): a
 * collapsed folder hides its members at any depth, exactly like `flattenRows`
 * hides them as rows, so a shift-click range and the flattened row list agree
 * on what's "between" two workspaces.
 */
export function visibleWorkspacePaths(
  items: SidebarItem[],
  collapsedFolderIds: Set<string>,
): string[] {
  const paths: string[] = [];
  const walk = (list: SidebarItem[]) => {
    for (const item of list) {
      if (!isFolder(item)) {
        paths.push(item.ws.path);
        continue;
      }
      if (collapsedFolderIds.has(item.folder.id)) continue;
      walk(item.children);
    }
  };
  walk(items);
  return paths;
}

/**
 * Bulk "Move to Folder" (ADR-190 §2): append each of `keys`, in the given
 * order, to F — one `placeInFolder` per key, so a key missing from the tree
 * or a folder headed for its own subtree is skipped exactly as a single move
 * would be.
 */
export function placeManyInFolder(
  items: SidebarItem[],
  keys: string[],
  folderId: string,
): SidebarItem[] {
  return keys.reduce((acc, key) => placeInFolder(acc, key, folderId), items);
}

/**
 * Bulk "Remove from Folder" (ADR-190 §2): every key that lives in a folder
 * leaves it for the slot right after, `placeAfterFolder`'s rule applied to
 * each. Keys that share a folder keep their relative tree order in the block
 * that lands after it; a loose key is untouched.
 */
export function placeManyAfterFolders(
  items: SidebarItem[],
  keys: string[],
): SidebarItem[] {
  const info = new Map<string, { parentId: string | null; index: number }>();
  for (const key of keys) {
    const at = locate(items, key);
    if (at) info.set(key, at);
  }

  // Group by enclosing folder, then sort each bucket by original tree index
  // so the block that lands after a folder mirrors its previous order,
  // whatever order the caller passed `keys` in.
  const byFolder = new Map<string, string[]>();
  for (const key of keys) {
    const at = info.get(key);
    if (!at || at.parentId === null) continue;
    const bucket = byFolder.get(at.parentId);
    if (bucket) bucket.push(key);
    else byFolder.set(at.parentId, [key]);
  }
  for (const bucket of byFolder.values()) {
    bucket.sort((a, b) => info.get(a)!.index - info.get(b)!.index);
  }

  let result = items;
  for (const [folderId, keysInFolder] of byFolder) {
    const { items: base, block } = removeBlock(result, keysInFolder);
    if (block.length === 0) continue;
    const at = locate(base, folderId);
    result = at
      ? insertBlock(base, at.parentId, at.index + 1, block)
      : insertBlock(base, null, base.length, block);
  }
  return result;
}

/** Pulls every present key out of the tree, returning them as a block in `keys` order. */
function removeBlock(
  items: SidebarItem[],
  keys: string[],
): { items: SidebarItem[]; block: SidebarItem[] } {
  let base = items;
  const block: SidebarItem[] = [];
  for (const key of keys) {
    const { items: next, item } = removeItem(base, key);
    if (item) {
      base = next;
      block.push(item);
    }
  }
  return { items: base, block };
}

/** Inserts `block` contiguously at `index` under `parentId` (null = top level). */
function insertBlock(
  items: SidebarItem[],
  parentId: string | null,
  index: number,
  block: SidebarItem[],
): SidebarItem[] {
  return block.reduce(
    (tree, item, i) => insertItem(tree, parentId, index + i, item),
    items,
  );
}

/** Every key in `keys` present in the tree, in depth-first tree order. */
function keysInTreeOrder(items: SidebarItem[], keys: Set<string>): string[] {
  const ordered: string[] = [];
  const walk = (list: SidebarItem[]) => {
    for (const item of list) {
      const key = keyOf(item);
      if (keys.has(key)) ordered.push(key);
      if (isFolder(item)) walk(item.children);
    }
  };
  walk(items);
  return ordered;
}

/**
 * Multi-drag (ADR-190 §3): moves `groupKeys` together, following the source
 * row's drop target. A group of one behaves exactly like `applyDrop`. An
 * `into` target appends the whole group, in tree order, via
 * `placeManyInFolder`. A `slot` target resolves the landing position against
 * `rows` minus the source row — the same semantic as `applyDrop` — and, if
 * that position falls on another member of the group, walks back to the
 * nearest row outside it. The group is then pulled out as one block, in its
 * original tree order, and reinserted at that position under the same parent
 * rules as `applyDrop`.
 */
export function applyGroupDrop(
  items: SidebarItem[],
  sourceKey: string,
  groupKeys: string[],
  target: DropTarget,
  rows: Row[],
): SidebarItem[] {
  const groupSet = new Set(groupKeys);
  if (groupSet.size <= 1) {
    return applyDrop(items, sourceKey, target, rows);
  }

  const orderedKeys = keysInTreeOrder(items, groupSet);

  if (target.type === "into") {
    return placeManyInFolder(items, orderedKeys, target.folderId);
  }

  const { item: sourceItem } = removeItem(items, sourceKey);
  if (!sourceItem) return items;
  const movedFromSource = keysWithin(sourceItem);
  const rest = rows.filter((row) => !movedFromSource.has(row.key));

  // Folders whose members were visible when the drag started — read from the
  // original `rows`, same as `applyDrop`.
  const expandedFolderIds = new Set(
    rows.map((r) => r.parentFolderId).filter((id): id is string => id != null),
  );

  const index = clamp(target.rowIndex, 0, rest.length);
  let predIndex = index - 1;
  while (predIndex >= 0 && groupSet.has(rest[predIndex].key)) predIndex--;
  const pred = predIndex >= 0 ? rest[predIndex] : undefined;

  // Pull the whole group out as one block, in its original tree order.
  const { items: base, block } = removeBlock(items, orderedKeys);
  if (block.length === 0) return items;

  if (!pred) return insertBlock(base, null, 0, block);

  if (
    pred.kind === "folder" &&
    expandedFolderIds.has(pred.key) &&
    findFolder(base, pred.key)
  ) {
    // Landing right under an expanded header means "first children".
    return insertBlock(base, pred.key, 0, block);
  }

  const at = locate(base, pred.key);
  if (!at) return insertBlock(base, null, base.length, block);
  return insertBlock(base, at.parentId, at.index + 1, block);
}

// ── Top level: projects and linked-project groups (ADR-192) ──

type TopLevelProject = Pick<
  ProjectInfo,
  "id" | "hostId" | "workspaces" | "folders" | "sidebarOrder" | "group"
>;

/**
 * One host's slice of a linked group: a member project (whose `hostId` is
 * the section's host) and its own item tree, built exactly as it would be
 * for that project alone — so linking keeps its workspace order and folders.
 */
export type GroupSection<P extends TopLevelProject = ProjectInfo> = {
  project: P;
  items: SidebarItem[];
};

/**
 * One slot in the sidebar's project list: a lone project, or a linked group
 * with a section per member host. `key` is the project id or the group id —
 * what the top-level order holds.
 */
export type TopLevelEntry<P extends TopLevelProject = ProjectInfo> =
  | { kind: "project"; key: string; project: P }
  | {
      kind: "group";
      key: string;
      group: ProjectGroupInfo;
      sections: GroupSection<P>[];
    };

/**
 * The sidebar's top-level entries, in project order. A group takes the slot
 * of its first member in `projects`, and its sections follow the group's
 * `memberIds`. A group with fewer than two members present renders them as
 * plain projects — defensive only, main never sends one.
 */
export function buildTopLevelEntries<P extends TopLevelProject>(
  projects: readonly P[],
): TopLevelEntry<P>[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const entries: TopLevelEntry<P>[] = [];
  const placed = new Set<string>();
  for (const project of projects) {
    if (placed.has(project.id)) continue;
    const group = project.group;
    const members = group
      ? group.memberIds
          .map((id) => byId.get(id))
          .filter((p): p is P => p != null && p.group?.id === group.id)
      : [];
    if (!group || members.length < 2) {
      placed.add(project.id);
      entries.push({ kind: "project", key: project.id, project });
      continue;
    }
    for (const member of members) placed.add(member.id);
    entries.push({
      kind: "group",
      key: group.id,
      group,
      sections: members.map((member) => ({
        project: member,
        items: buildSidebarItems(member),
      })),
    });
  }
  return entries;
}

/** The top-level order: one key per entry, a group id in place of its members. */
export function topLevelKeys(entries: readonly TopLevelEntry<TopLevelProject>[]): string[] {
  return entries.map((entry) => entry.key);
}

/**
 * The project-id order main persists (`projects:reorder`) for a top-level
 * order of entry keys: each group id expands to its members in section
 * order, so a group's members stay together. Entries the order forgot are
 * appended; unknown keys are ignored.
 */
export function expandTopLevelOrder(
  keys: readonly string[],
  entries: readonly TopLevelEntry<TopLevelProject>[],
): string[] {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const ids: string[] = [];
  const seen = new Set<string>();
  const emit = (entry: TopLevelEntry<TopLevelProject>) => {
    if (seen.has(entry.key)) return;
    seen.add(entry.key);
    if (entry.kind === "project") ids.push(entry.project.id);
    else for (const section of entry.sections) ids.push(section.project.id);
  };
  for (const key of keys) {
    const entry = byKey.get(key);
    if (entry) emit(entry);
  }
  for (const entry of entries) emit(entry);
  return ids;
}

/**
 * Projects `project` can be linked with (ADR-192): on another host, and
 * either unlinked or in a group with no member on this project's host. A
 * project already in a group only offers unlinked projects on hosts the
 * group lacks.
 */
export function linkCandidates<P extends Pick<ProjectInfo, "id" | "hostId" | "group">>(
  project: P,
  projects: readonly P[],
): P[] {
  const hostOf = new Map(projects.map((p) => [p.id, p.hostId]));
  const groupHosts = (group: ProjectGroupInfo) =>
    groupHostIds(group.memberIds, (id) => hostOf.get(id));
  const own = project.group ?? null;
  return projects.filter((other) => {
    if (other.id === project.id) return false;
    const theirs = other.group ?? null;
    if (own && theirs) return false;
    if (own) return !groupHosts(own).has(other.hostId);
    if (theirs) return !groupHosts(theirs).has(project.hostId);
    return other.hostId !== project.hostId;
  });
}

/**
 * One "Link with…" menu row: a lone project, or a whole group — linking to
 * any member of a group joins that group, so it is offered once.
 */
export type LinkChoice = {
  key: string;
  label: string;
  /** The project id to pass to `linkProjects`. */
  targetId: string;
  /** The hosts the row stands for, for its host badges. */
  hostIds: string[];
};

/** `linkCandidates`, with each eligible group folded into one row. */
export function linkChoices<
  P extends Pick<ProjectInfo, "id" | "name" | "hostId" | "group">,
>(project: P, projects: readonly P[]): LinkChoice[] {
  const choices: LinkChoice[] = [];
  const byGroup = new Map<string, LinkChoice>();
  for (const other of linkCandidates(project, projects)) {
    const group = other.group ?? null;
    if (!group) {
      choices.push({
        key: other.id,
        label: other.name,
        targetId: other.id,
        hostIds: [other.hostId],
      });
      continue;
    }
    const existing = byGroup.get(group.id);
    if (existing) {
      existing.hostIds.push(other.hostId);
      continue;
    }
    const choice = {
      key: group.id,
      label: group.name,
      targetId: other.id,
      hostIds: [other.hostId],
    };
    byGroup.set(group.id, choice);
    choices.push(choice);
  }
  return choices;
}
