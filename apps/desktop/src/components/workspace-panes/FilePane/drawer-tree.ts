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
