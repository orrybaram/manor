/**
 * The rewrite between a host's own view of itself and its server's
 * ("one rewrite, two callers").
 *
 * A host server knows its own machine as `local` and keys a workspace by its
 * bare path. Whoever holds several hosts — `HostProxy` in main, the renderer's
 * router — knows that host by an id, and keys the workspace `<hostId>:<path>`.
 * These functions turn one form into the other, in both directions.
 *
 * Pure: imports only `src/lib/workspace-key.ts`, so it is read from the main
 * process and from a browser bundle alike. Each function takes the `hostId`
 * it rewrites for.
 */

import {
  LOCAL_HOST_ID,
  parseWorkspaceKey,
  workspaceKey,
  type WorkspaceKey,
} from "../../src/lib/workspace-key";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A bare path on the host as the desktop's key for it. Null for one that
 * cannot be keyed (not POSIX-absolute), which the desktop never sees.
 */
export function keyFor(hostId: string, bare: string): WorkspaceKey | null {
  try {
    return workspaceKey(hostId, bare);
  } catch {
    return null;
  }
}

/** A record with the host's `local` as this host's id. */
export function toDesktop<T>(hostId: string, value: T): T {
  if (isPlainObject(value) && value.hostId === LOCAL_HOST_ID) {
    return { ...value, hostId };
  }
  return value;
}

/**
 * The desktop's arguments in the host's form: a string that is one of
 * this host's keys becomes its bare path, and this host's id becomes
 * `local` — at the top level and one level into a plain object (a
 * command's `workspacePath`, a context's `hostId`). Host ids are UUIDs, so
 * a string that merely looks like `<hostId>:/path` is not a worry.
 */
export function toHostArgs(hostId: string, args: unknown[]): unknown[] {
  const value = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    if (v === hostId) return LOCAL_HOST_ID;
    const parsed = parseWorkspaceKey(v);
    return parsed.hostId === hostId ? parsed.path : v;
  };
  return args.map((arg) => {
    if (!isPlainObject(arg)) return value(arg);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(arg)) out[k] = value(v);
    return out;
  });
}

/**
 * The host's answer in the desktop's form: `layout.getAll` rekeyed,
 * `layout.getLastActive` keyed, and anything else with `hostId: "local"`
 * stamped — a record, or each record of a list.
 */
export function toDesktopResult(
  hostId: string,
  ns: string,
  methodName: string,
  result: unknown,
): unknown {
  if (ns === "layout" && methodName === "getAll" && isPlainObject(result)) {
    const out: Record<string, unknown> = {};
    for (const [bare, entry] of Object.entries(result)) {
      const key = keyFor(hostId, bare);
      if (key) out[key] = entry;
    }
    return out;
  }
  if (ns === "layout" && methodName === "getLastActive") {
    return typeof result === "string" ? keyFor(hostId, result) : result;
  }
  if (Array.isArray(result)) return result.map((item) => toDesktop(hostId, item));
  return toDesktop(hostId, result);
}
