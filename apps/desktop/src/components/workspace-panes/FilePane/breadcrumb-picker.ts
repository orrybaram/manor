/** One entry of a folder, as the breadcrumb's picker lists it. */
export type FolderEntry = { kind: "dir" | "file"; name: string; path: string };

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * The folder a breadcrumb segment opens on: the folder it names, or, for the
 * last segment (the file), the file's own folder. "" is the workspace's root.
 */
export function crumbFolder(parts: readonly string[], index: number): string {
  const end = index === parts.length - 1 ? index : index + 1;
  return parts.slice(0, end).join("/");
}

/** The folder above `folder`; null at the workspace's root. */
export function parentFolder(folder: string): string | null {
  if (folder === "") return null;
  const slash = folder.lastIndexOf("/");
  return slash < 0 ? "" : folder.slice(0, slash);
}

/**
 * The entries directly in `folder`, read off a workspace's file list (which
 * names files only: a folder is there by holding one). Folders first, then
 * files, each alphabetically, as the tree lists them.
 */
export function folderEntries(
  paths: readonly string[],
  folder: string,
): FolderEntry[] {
  const prefix = folder === "" ? "" : `${folder}/`;
  const dirs = new Map<string, FolderEntry>();
  const files: FolderEntry[] = [];
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      if (rest) files.push({ kind: "file", name: rest, path });
      continue;
    }
    const name = rest.slice(0, slash);
    if (!dirs.has(name))
      dirs.set(name, { kind: "dir", name, path: prefix + name });
  }
  return [...[...dirs.values()].sort(byName), ...files.sort(byName)];
}

/** The entries whose name holds `query`, ignoring case; all of them for an empty one. */
export function filterEntries(
  entries: readonly FolderEntry[],
  query: string,
): FolderEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}

/**
 * The entry the picker starts on: the one on the way to (or being) `openFile`,
 * else the first.
 */
export function startIndex(
  entries: readonly FolderEntry[],
  openFile: string | null,
): number {
  if (!openFile) return 0;
  const at = entries.findIndex(
    (e) =>
      e.path === openFile ||
      (e.kind === "dir" && openFile.startsWith(`${e.path}/`)),
  );
  return at < 0 ? 0 : at;
}
