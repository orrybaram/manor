/**
 * The vocabulary every route in `electron/routes/` speaks: the deps it runs
 * over, the two HTTP callbacks the listener hands down, and the `Route` shape the
 * matcher consumes.
 *
 * This module is the acyclic root of `electron/routes/`. `./index.ts` imports
 * the route modules to build its table, so nothing under `routes/` may import
 * back from `./index.ts` — the shared declarations live here instead.
 */

import type { HostDeps } from "../ipc/types";

/**
 * A route runs over the same non-null deps a bridge handler does (ADR-182
 * D8): `app-lifecycle.ts` builds one `HostDeps` and hands it to both, so a
 * route can call a bridge handler with `localCtx(deps)` instead of keeping
 * its own copy of what that handler does.
 */
export type { HostDeps };

/**
 * What one request runs over: the shared `HostDeps`, plus the one fact that
 * belongs to the request rather than the host.
 */
export interface RouteDeps extends HostDeps {
  /**
   * Set per request when it was relayed from a remote host's `manor` CLI
   * (ADR-189 §2): the host it came from. Routes that infer "the caller's
   * project" from a path use it to only consider that host's projects, since
   * the same path can exist on this machine too. Unset for local callers.
   */
  callerHostId?: string;
}

/** One buffered `console-message` from a webview's `WebContents`. */
export interface ConsoleEntry {
  timestamp: string;
  level: "log" | "warn" | "error" | "info";
  message: string;
}

/**
 * Pane→`WebContents` resolution and buffered console logs, owned by
 * `WebviewServer` (ADR-183). Structural, so `routes/` keeps no import edge
 * back to its host module.
 */
export interface WebviewPaneAccess {
  /** paneId → webContentsId, for `GET /webviews`. */
  registry: ReadonlyMap<string, number>;
  /** The pane's live `WebContents`, or why it can't be reached. */
  getWebContents(
    paneId: string,
  ): { wc: Electron.WebContents } | { error: string; status: number };
  /** Buffered `console-message` entries per pane, oldest first. */
  consoleLogs: ReadonlyMap<string, ConsoleEntry[]>;
}

export type Json = (status: number, body: unknown) => void;
export type ReadBody = () => Promise<Record<string, unknown>>;

/** Everything a route handler is given. `params` are already decoded. */
export interface RouteContext {
  deps: RouteDeps;
  params: Record<string, string>;
  url: URL;
  json: Json;
  readBody: ReadBody;
}

/**
 * One row of the route table. `path` is a `/`-delimited pattern whose `:name`
 * segments capture into `RouteContext.params`.
 *
 * Handlers return `void`, not `boolean`: a handler that ran *is* the response.
 * The dispatcher owns the `true`/`false` the HTTP listener switches on.
 */
export interface Route {
  method: "GET" | "POST" | "DELETE";
  path: string;
  handler: (ctx: RouteContext) => Promise<void>;
}
