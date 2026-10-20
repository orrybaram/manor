/**
 * The vocabulary every route in `electron/routes/` speaks: the deps it runs
 * over, the two HTTP callbacks the listener hands down, and the `Route` shape the
 * matcher consumes.
 *
 * This module is the acyclic root of `electron/routes/`. `./index.ts` imports
 * the route modules to build its table, so nothing under `routes/` may import
 * back from `./index.ts` — the shared declarations live here instead.
 */

import type { HostDeps, SharedDeps } from "../ipc/types";

/**
 * A route runs over the same non-null deps a bridge handler does: `app-lifecycle.ts` builds one `HostDeps` and hands it to both, so a
 * route can call a bridge handler with `localCtx(deps)` instead of keeping
 * its own copy of what that handler does.
 */
export type { HostDeps };

/** What one request runs over: the shared `HostDeps`. */
export type RouteDeps = HostDeps;

/**
 * What a route every Manor server answers runs over: the
 * window-free deps `createManorServer` builds on every platform, so the host
 * server dispatches the same routes for its box's `manor` CLI
 * (`./server-routes.ts`). `RouteDeps` has all of it.
 */
export type ServerRouteDeps = SharedDeps;

/** One buffered `console-message` from a webview's `WebContents`. */
export interface ConsoleEntry {
  timestamp: string;
  level: "log" | "warn" | "error" | "info";
  message: string;
}

/**
 * Pane→`WebContents` resolution and buffered console logs, owned by
 * `WebviewServer`. Structural, so `routes/` keeps no import edge
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
export interface RouteContext<D = RouteDeps> {
  deps: D;
  /** The request's method, as the route matched it. */
  method: Route["method"];
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
export interface Route<D = RouteDeps> {
  method: "GET" | "POST" | "DELETE";
  path: string;
  handler: (ctx: RouteContext<D>) => Promise<void>;
}

/** A route every server answers: it reads only `ServerRouteDeps`. */
export type ServerRoute = Route<ServerRouteDeps>;
