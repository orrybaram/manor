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

export type Json = (status: number, body: unknown) => void;
export type ReadBody = () => Promise<Record<string, unknown>>;

/** Everything a route handler is given. `params` are already decoded. */
export interface RouteContext {
  deps: HostDeps;
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
