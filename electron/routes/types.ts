/**
 * The vocabulary every route in `electron/routes/` speaks: the dependency bag,
 * the two HTTP callbacks the listener hands down, and the `Route` shape the
 * matcher consumes.
 *
 * This module is the acyclic root of `electron/routes/`. `./index.ts` imports
 * the route modules to build its table, so nothing under `routes/` may import
 * back from `./index.ts` — the shared declarations live here instead.
 */

import type { ProjectManager } from "../persistence";
import type { GitHubManager } from "../github";
import type { LinearManager } from "../linear";
import type { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { AgentManager } from "../agent-persistence";
import type { LocalBackend } from "../backend/local-backend";

export interface ControlDeps {
  projectManager: ProjectManager | null;
  githubManager: GitHubManager | null;
  linearManager: LinearManager | null;
  layoutPersistence: LayoutPersistence | null;
  agentManager: AgentManager | null;
  backend: LocalBackend | null;
}

export type Json = (status: number, body: unknown) => void;
export type ReadBody = () => Promise<Record<string, unknown>>;

/** Everything a route handler is given. `params` are already decoded. */
export interface RouteContext {
  deps: ControlDeps;
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
