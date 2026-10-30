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

/**
 * A record with this host's id for whatever host id it names. A host only
 * speaks for itself: one naming another host, or none, must not be read as
 * the desktop's own (`local`) or another adopted host's.
 */
export function toDesktop<T>(hostId: string, value: T): T {
  if (isPlainObject(value) && "hostId" in value) return { ...value, hostId };
  return value;
}

/**
 * One of the host's own records (a project, agent or notification) with
 * this host's id, stamped even when the host left it out: a missing id
 * reads as `local` downstream, which would run its terminals and scripts
 * on the desktop.
 */
export function hostRecord<T>(hostId: string, value: T): T {
  return isPlainObject(value) ? { ...value, hostId } : value;
}

/** A project's shape: what `projects.*` answers with when it answers one. */
function isProjectRecord(value: unknown): boolean {
  return (
    isPlainObject(value) && typeof value.id === "string" && Array.isArray(value.workspaces)
  );
}

/**
 * The desktop's arguments in the host's form: a string that is one of
 * this host's keys becomes its bare path, and this host's id becomes
 * `local` — at the top level, one level into a plain object (a command's
 * `workspacePath`, a context's `hostId`), and one more into that object's
 * `workspace` (an automation's input or patch, `rewriteNestedWorkspace`).
 * Host ids are UUIDs, so a string that merely looks like `<hostId>:/path`
 * is not a worry.
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
    return rewriteNestedWorkspace(out, value);
  });
}

/**
 * `arg` with its `workspace` object's strings through `value`: an
 * automation's input or patch names the workspace it reuses there
 * (`workspace.workspacePath`), a level deeper than the rest of the rewrite
 * reaches. `arg` itself when it has no such object.
 */
export function rewriteNestedWorkspace(
  arg: Record<string, unknown>,
  value: (v: unknown) => unknown,
): Record<string, unknown> {
  const workspace = arg.workspace;
  if (!isPlainObject(workspace)) return arg;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(workspace)) out[k] = value(v);
  return { ...arg, workspace: out };
}

/**
 * An `automations.*` answer with each workspace path in it through `key`
 * (a server's own key for it in, the caller's out): a view's
 * `workspace.workspacePath`, its `lastRun`'s and each of a detail's `runs`'
 * `workspacePath`, and a run's own (`runNow`) — of a record or each record
 * of a list. A path `key` can't key is left as it is.
 */
export function keyAutomationPaths(
  result: unknown,
  key: (path: string) => string | null,
): unknown {
  const keyed = (path: unknown): unknown => (typeof path === "string" ? (key(path) ?? path) : path);
  const record = (value: unknown): unknown => {
    if (!isPlainObject(value)) return value;
    const out: Record<string, unknown> = { ...value };
    if ("workspacePath" in out) out.workspacePath = keyed(out.workspacePath);
    if (isPlainObject(out.workspace) && "workspacePath" in out.workspace) {
      out.workspace = { ...out.workspace, workspacePath: keyed(out.workspace.workspacePath) };
    }
    if (isPlainObject(out.lastRun)) out.lastRun = record(out.lastRun);
    if (Array.isArray(out.runs)) out.runs = out.runs.map(record);
    return out;
  };
  return Array.isArray(result) ? result.map(record) : record(result);
}

/**
 * The host's answer in the desktop's form: `layout.getAll` rekeyed,
 * `layout.getLastActive` keyed, an automation's workspace paths keyed
 * (`keyAutomationPaths`), and anything else with this host's id stamped
 * — a record, or each record of a list; a project always, any other
 * record where it names a host.
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
  // A move's answer names where the tab landed by the host's own key.
  if (ns === "layout" && methodName === "moveToWorkspace" && isPlainObject(result)) {
    const key = typeof result.workspacePath === "string" && keyFor(hostId, result.workspacePath);
    return key ? { ...result, workspacePath: key } : result;
  }
  const answer =
    ns === "automations" ? keyAutomationPaths(result, (path) => keyFor(hostId, path)) : result;
  const stamp = (item: unknown) =>
    ns === "projects" && isProjectRecord(item) ? hostRecord(hostId, item) : toDesktop(hostId, item);
  if (Array.isArray(answer)) return answer.map(stamp);
  return stamp(answer);
}
