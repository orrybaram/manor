/** Anything that sits in the tree: it only needs a repo-relative path. */
export type FileTreeEntry = { path: string };

export type FileTreeNode<T extends FileTreeEntry = FileTreeEntry> =
  | { kind: "dir"; name: string; path: string; children: FileTreeNode<T>[] }
  | { kind: "file"; name: string; entry: T };

type MutableDir<T> = {
  kind: "dir";
  name: string;
  path: string;
  dirs: Map<string, MutableDir<T>>;
  files: T[];
};

function makeDir<T>(name: string, path: string): MutableDir<T> {
  return { kind: "dir", name, path, dirs: new Map(), files: [] };
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * Collapse chains of directories that contain exactly one child directory
 * and no files ("tabbar/TabBar"), then sort dirs and files together
 * alphabetically (case-insensitive), the way an editor's file tree does.
 */
function finalize<T extends FileTreeEntry>(
  dir: MutableDir<T>,
): FileTreeNode<T>[] {
  const dirs = [...dir.dirs.values()].map((child): FileTreeNode<T> => {
    let current = child;
    let name = child.name;
    while (current.files.length === 0 && current.dirs.size === 1) {
      const only = current.dirs.values().next().value as MutableDir<T>;
      name = `${name}/${only.name}`;
      current = only;
    }
    return {
      kind: "dir",
      name,
      path: current.path,
      children: finalize(current),
    };
  });
  const files = dir.files.map(
    (entry): FileTreeNode<T> => ({
      kind: "file",
      name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
      entry,
    }),
  );
  return [...dirs, ...files].sort(byName);
}

export function buildFileTree<T extends FileTreeEntry>(
  entries: T[],
): FileTreeNode<T>[] {
  const root = makeDir<T>("", "");
  for (const entry of entries) {
    const segments = entry.path.split("/");
    let dir = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      let next = dir.dirs.get(segment);
      if (!next) {
        next = makeDir<T>(segment, segments.slice(0, i + 1).join("/"));
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.push(entry);
  }
  return finalize(root);
}

/** Entries in display (depth-first) order, ignoring collapse state. */
export function flattenFileTree<T extends FileTreeEntry>(
  nodes: FileTreeNode<T>[],
): T[] {
  const out: T[] = [];
  const walk = (list: FileTreeNode<T>[]) => {
    for (const node of list) {
      if (node.kind === "file") out.push(node.entry);
      else walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
