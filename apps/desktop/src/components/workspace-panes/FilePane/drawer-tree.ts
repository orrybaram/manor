import type { FileTreeEntry, FileTreeNode } from "../FileTree/file-tree";

/** One row the drawer shows, in display order. */
export type DrawerRow =
  | { kind: "dir"; path: string; name: string; depth: number; expanded: boolean }
  | { kind: "file"; path: string; name: string; depth: number };

/**
 * The folders the drawer starts with open: those on the way to the open file,
 * and no others. A compressed chain ("src/components/tabbar") is one folder,
 * known by its deepest path.
 */
export function expandedForOpenFile<T extends FileTreeEntry>(
  nodes: FileTreeNode<T>[],
  filePath: string | null,
): Set<string> {
  const expanded = new Set<string>();
  if (!filePath) return expanded;
  let level = nodes;
  for (;;) {
    const dir = level.find(
      (n): n is Extract<FileTreeNode<T>, { kind: "dir" }> =>
        n.kind === "dir" && filePath.startsWith(`${n.path}/`),
    );
    if (!dir) return expanded;
    expanded.add(dir.path);
    level = dir.children;
  }
}

/**
 * The folders the drawer starts with open: those on the way to the open file
 * and to each changed file.
 */
export function expandedForFiles<T extends FileTreeEntry>(
  nodes: FileTreeNode<T>[],
  openFile: string | null,
  changed: Iterable<string>,
): Set<string> {
  const expanded = expandedForOpenFile(nodes, openFile);
  for (const path of changed) {
    for (const dir of expandedForOpenFile(nodes, path)) expanded.add(dir);
  }
  return expanded;
}

/** The rows a tree shows with `expanded` folders open, depth-first. */
export function visibleTreeRows<T extends FileTreeEntry>(
  nodes: FileTreeNode<T>[],
  expanded: ReadonlySet<string>,
): DrawerRow[] {
  const rows: DrawerRow[] = [];
  const walk = (list: FileTreeNode<T>[], depth: number) => {
    for (const node of list) {
      if (node.kind === "file") {
        rows.push({ kind: "file", path: node.entry.path, name: node.name, depth });
        continue;
      }
      const open = expanded.has(node.path);
      rows.push({ kind: "dir", path: node.path, name: node.name, depth, expanded: open });
      if (open) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return rows;
}

/**
 * The row the keyboard is on: `cursor`'s, or the folder it is hidden in once
 * that is collapsed, or the first row.
 */
export function cursorIndex(rows: readonly DrawerRow[], cursor: string | null): number {
  if (cursor === null) return 0;
  let best = 0;
  let bestLength = -1;
  for (let i = 0; i < rows.length; i++) {
    const path = rows[i].path;
    if (path === cursor) return i;
    if (rows[i].kind === "dir" && cursor.startsWith(`${path}/`) && path.length > bestLength) {
      best = i;
      bestLength = path.length;
    }
  }
  return best;
}

/** What a key does on the tree's `index`th row; null for a key it leaves alone. */
export type TreeKeyAction =
  | { kind: "move"; index: number }
  | { kind: "toggle"; index: number }
  | { kind: "open"; index: number };

/**
 * The tree's keys, as in VS Code's: ↑↓ move, Home and End jump, → opens a
 * folder or steps into it, ← closes one or steps out to its folder, and
 * Enter or Space opens a file or opens and closes a folder.
 */
export function treeKey(
  rows: readonly DrawerRow[],
  index: number,
  key: string,
): TreeKeyAction | null {
  const row = rows[index];
  if (!row) return null;
  switch (key) {
    case "ArrowDown":
      return { kind: "move", index: Math.min(index + 1, rows.length - 1) };
    case "ArrowUp":
      return { kind: "move", index: Math.max(index - 1, 0) };
    case "Home":
      return { kind: "move", index: 0 };
    case "End":
      return { kind: "move", index: rows.length - 1 };
    case "ArrowRight":
      if (row.kind !== "dir") return null;
      if (!row.expanded) return { kind: "toggle", index };
      return rows[index + 1]?.depth > row.depth ? { kind: "move", index: index + 1 } : null;
    case "ArrowLeft": {
      if (row.kind === "dir" && row.expanded) return { kind: "toggle", index };
      for (let i = index - 1; i >= 0; i--) {
        if (rows[i].depth < row.depth) return { kind: "move", index: i };
      }
      return null;
    }
    case "Enter":
    case " ":
      return { kind: row.kind === "dir" ? "toggle" : "open", index };
    default:
      return null;
  }
}
