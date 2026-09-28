/**
 * Host-qualified workspace identity (ADR-191).
 *
 * A workspace is identified by *(host, path)*, not by its bare path: a laptop
 * and a remote box that share a username produce byte-identical workspace
 * paths. A `WorkspaceKey` is a deterministic string built from both, so it
 * can key a persisted map and be migrated mechanically.
 *
 * The encoding keeps local data in its current shape:
 *
 * - a workspace on this machine is keyed by its bare path (`/a/b`), exactly
 *   as every path-keyed store already holds it;
 * - a workspace on a remote host is keyed `<hostId>:<path>` (`box:/a/b`).
 *
 * So a bare path always parses as local. That makes a bare key ambiguous only
 * in data written before ADR-191, which `migrateWorkspaceKey` resolves once,
 * at load, to the host of the project that owns the path.
 *
 * Pure and dependency-free: imported by the main process (`electron/`) and
 * the renderer (`src/`) alike, so it must not touch `window`, Node or Electron.
 */

/**
 * Mirrors `LOCAL_HOST_ID` in `electron/backend/types.ts` and `src/lib/hosts.ts`.
 * Not imported from either: the first is main-only, and the second reaches for
 * `window`, which the main-process typecheck has no DOM types for.
 */
const LOCAL_HOST_ID = "local";

/** Separates a remote host id from the path in a qualified key. */
const SEPARATOR = ":";

/**
 * A host-qualified workspace key. Branded so a bare path can't be passed
 * where a key is expected by accident; build one with `workspaceKey` or
 * `migrateWorkspaceKey`.
 */
export type WorkspaceKey = string & { readonly __brand: "WorkspaceKey" };

/** The two halves of a `WorkspaceKey`. `hostId` is `"local"` for this machine. */
export interface ParsedWorkspaceKey {
  hostId: string;
  path: string;
}

function isLocal(hostId: string | null | undefined): boolean {
  return !hostId || hostId === LOCAL_HOST_ID;
}

/**
 * The key for the workspace at `path` on `hostId`. A missing host means
 * local. Deterministic: the same host and path always give the same key.
 *
 * Throws for a remote host id containing `:` or `/`, which could not be
 * parsed back. Real host ids are `"local"` or UUIDs (`ipc/hosts.ts`).
 */
export function workspaceKey(
  hostId: string | null | undefined,
  path: string,
): WorkspaceKey {
  if (isLocal(hostId)) return path as WorkspaceKey;
  const id = hostId as string;
  if (id.includes(SEPARATOR) || id.includes("/") || id.includes("\\")) {
    throw new Error(`Invalid host id for a workspace key: ${JSON.stringify(id)}`);
  }
  return `${id}${SEPARATOR}${path}` as WorkspaceKey;
}

/**
 * The host id and path a key names. A key with no host part, including any
 * path-only key written before ADR-191, parses as local: call
 * `migrateWorkspaceKey` on legacy data first if it may name a remote path.
 *
 * A remote key's path must be absolute (`box:/a/b`). Anything else, such as
 * a Windows drive path (`C:\a`), is read as a bare local path.
 */
export function parseWorkspaceKey(key: string): ParsedWorkspaceKey {
  const at = key.indexOf(SEPARATOR);
  if (at > 0) {
    const hostId = key.slice(0, at);
    const path = key.slice(at + 1);
    if (
      path.startsWith("/") &&
      !hostId.includes("/") &&
      !hostId.includes("\\")
    ) {
      return { hostId, path };
    }
  }
  return { hostId: LOCAL_HOST_ID, path: key };
}

/** Whether `key` names a workspace on a remote host. */
export function isRemoteWorkspaceKey(key: string): boolean {
  return !isLocal(parseWorkspaceKey(key).hostId);
}

/**
 * What `migrateWorkspaceKey` needs to know about a project to decide whether
 * it owns a path. `ProjectInfo`, in main and in the renderer, fits as is.
 */
export interface WorkspaceKeyOwner {
  /** The project's host. Missing means local, as on disk (ADR-160). */
  hostId?: string | null;
  /** The project's root. */
  path: string;
  /** Workspaces the project is known to have. */
  workspaces?: readonly { path: string }[];
  /**
   * The project's worktree directory, already expanded for its host. Lets a
   * workspace the project no longer lists still find its host.
   */
  worktreeRoot?: string | null;
}

function isWithinPath(p: string, root: string): boolean {
  if (!root) return false;
  if (p === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return p.startsWith(prefix);
}

/**
 * The host of the project that owns `path`: the one whose root, worktree
 * directory or known workspace contains it most closely. Local when no
 * project matches, and when a local and a remote project match equally
 * closely, the same tie-break as `PathRouter.hostIdForPath`.
 */
export function ownerHostIdForPath(
  owners: readonly WorkspaceKeyOwner[],
  path: string,
): string {
  let best = LOCAL_HOST_ID;
  let bestLength = -1;
  for (const owner of owners) {
    const hostId = isLocal(owner.hostId) ? LOCAL_HOST_ID : (owner.hostId as string);
    const roots = [
      owner.path,
      ...(owner.worktreeRoot ? [owner.worktreeRoot] : []),
      ...(owner.workspaces ?? []).map((w) => w.path),
    ];
    for (const root of roots) {
      if (!isWithinPath(path, root)) continue;
      const closer = root.length > bestLength;
      const tieToLocal = root.length === bestLength && hostId === LOCAL_HOST_ID;
      if (closer || tieToLocal) {
        best = hostId;
        bestLength = root.length;
      }
    }
  }
  return best;
}

/**
 * The host-qualified form of a key read from data written before ADR-191.
 *
 * A key that already names a remote host is returned unchanged. A bare path
 * is assigned to the host of the project that owns it (`ownerHostIdForPath`),
 * or local when none does, so local data keeps its shape.
 *
 * Run it once per store, at load, behind that store's own version marker. A
 * bare key written after the migration means local; migrating it again could
 * move it to a remote project that happens to have the same path.
 */
export function migrateWorkspaceKey(
  key: string,
  owners: readonly WorkspaceKeyOwner[],
): WorkspaceKey {
  if (isRemoteWorkspaceKey(key)) return key as WorkspaceKey;
  return workspaceKey(ownerHostIdForPath(owners, key), key);
}

/**
 * `record` with every key migrated by `migrateWorkspaceKey`. Never drops an
 * entry except when a legacy bare key and an already-qualified key resolve to
 * the same workspace; then the qualified one, the newer, wins.
 */
export function migrateWorkspaceKeyedRecord<T>(
  record: Readonly<Record<string, T>>,
  owners: readonly WorkspaceKeyOwner[],
): Record<string, T> {
  const out: Record<string, T> = {};
  const fromQualified = new Set<string>();
  for (const [key, value] of Object.entries(record)) {
    const migrated = migrateWorkspaceKey(key, owners);
    const qualified = isRemoteWorkspaceKey(key);
    if (migrated in out && fromQualified.has(migrated) && !qualified) continue;
    out[migrated] = value;
    if (qualified) fromQualified.add(migrated);
  }
  return out;
}
