/**
 * Merging a desktop's project records into a host server's own (ADR-227 D3).
 *
 * Adoption hands a host server the projects the desktop held for it. The
 * box may already have some of them — a resend after a crash, or a second
 * laptop with leftovers — so a record is merged, never swapped in, and **the
 * host wins every conflict**: a field the host has keeps its value, and only
 * what the host does not have yet is added. Merging the same record twice
 * changes nothing the second time.
 *
 * - Top-level fields (name, color, scripts, …) are the host's.
 * - Workspace-keyed records (names, linked issues, hidden flags, folder
 *   assignments) merge per workspace path.
 * - Folders merge by id; the sidebar order keeps the host's, then appends
 *   what only the incoming record lists.
 *
 * Electron-free.
 */

import type { PersistedProject } from "./types";

/** `host`'s entries, plus `incoming`'s for keys `host` lacks. */
function mergeByKey<T>(
  host: Record<string, T> | undefined,
  incoming: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!incoming) return host;
  if (!host) return structuredClone(incoming);
  const merged = { ...host };
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in merged)) merged[key] = structuredClone(value);
  }
  return merged;
}

/** `host`'s items, plus `incoming`'s whose key `host` lacks, in order. */
function mergeList<T>(
  host: T[] | undefined,
  incoming: T[] | undefined,
  keyOf: (item: T) => string,
): T[] | undefined {
  if (!incoming) return host;
  if (!host) return structuredClone(incoming);
  const seen = new Set(host.map(keyOf));
  return [...host, ...structuredClone(incoming.filter((item) => !seen.has(keyOf(item))))];
}

/**
 * Merge `incoming` into `host`, in place: the host's values stand, and
 * `incoming` only fills in what the host does not have.
 */
export function mergeAdoptedProject(
  host: PersistedProject,
  incoming: Omit<PersistedProject, "hostPaths">,
): void {
  const set = <K extends keyof PersistedProject>(key: K, value: PersistedProject[K]): void => {
    if (value === undefined) delete host[key];
    else host[key] = value;
  };
  set("workspaceNames", mergeByKey(host.workspaceNames, incoming.workspaceNames));
  set("workspaceIssues", mergeByKey(host.workspaceIssues, incoming.workspaceIssues));
  set("workspaceHidden", mergeByKey(host.workspaceHidden, incoming.workspaceHidden));
  set("workspaceFolderIds", mergeByKey(host.workspaceFolderIds, incoming.workspaceFolderIds));
  set(
    "workspaceFolders",
    mergeList(host.workspaceFolders, incoming.workspaceFolders, (folder) => folder.id),
  );
  set("workspaceOrder", mergeList(host.workspaceOrder, incoming.workspaceOrder, (key) => key));
}
