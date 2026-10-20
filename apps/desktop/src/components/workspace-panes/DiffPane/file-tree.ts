import type { DiffFile } from "./types";

export type FileTreeNode =
  | { kind: "dir"; name: string; path: string; children: FileTreeNode[] }
  | { kind: "file"; name: string; file: DiffFile };

type MutableDir = {
  kind: "dir";
  name: string;
  path: string;
  dirs: Map<string, MutableDir>;
  files: DiffFile[];
};

function makeDir(name: string, path: string): MutableDir {
  return { kind: "dir", name, path, dirs: new Map(), files: [] };
}

const byName = (a: FileTreeNode, b: FileTreeNode) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * Collapse chains of directories that contain exactly one child directory
 * and no files ("tabbar/TabBar"), then sort dirs and files together
 * alphabetically (case-insensitive), the way an editor's file tree does.
 */
function finalize(dir: MutableDir): FileTreeNode[] {
  const dirs = [...dir.dirs.values()].map((child): FileTreeNode => {
    let current = child;
    let name = child.name;
    while (current.files.length === 0 && current.dirs.size === 1) {
      const only = current.dirs.values().next().value as MutableDir;
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
    (file): FileTreeNode => ({
      kind: "file",
      name: file.path.slice(file.path.lastIndexOf("/") + 1),
      file,
    }),
  );
  return [...dirs, ...files].sort(byName);
}

export function buildFileTree(files: DiffFile[]): FileTreeNode[] {
  const root = makeDir("", "");
  for (const file of files) {
    const segments = file.path.split("/");
    let dir = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      let next = dir.dirs.get(segment);
      if (!next) {
        next = makeDir(segment, segments.slice(0, i + 1).join("/"));
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.push(file);
  }
  return finalize(root);
}

/** Files in display (depth-first) order, ignoring collapse state. */
export function flattenFileTree(nodes: FileTreeNode[]): DiffFile[] {
  const out: DiffFile[] = [];
  const walk = (list: FileTreeNode[]) => {
    for (const node of list) {
      if (node.kind === "file") out.push(node.file);
      else walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
