/**
 * Manor-control HTTP routes — project/workspace management, GitHub issue
 * listing, batch issue→workspace fan-out, agent launching, and pane/tab
 * control.
 *
 * Extracted from WebviewServer (which is about webview inspection) so each
 * module stays cohesive. Consumed by webview-server.ts, which owns the HTTP
 * listener and delegates any matching request here.
 *
 * This file is now the table of contents: the route table, the prefixes it
 * answers for, and the re-exports that keep it the public face of the module.
 * The handlers live in `./routes/`, the matcher in `./routes/router.ts`, and
 * the "app-command" channel in `./routes/renderer-bridge.ts` — the last of
 * those sits under `routes/` only because the handlers need it, and importing
 * it back from here would be a cycle.
 */

import { dispatch } from "./routes/router";
import type { ControlDeps, Json, ReadBody, Route } from "./routes/types";
import { agentRoutes } from "./routes/agents";
import { contextRoutes } from "./routes/context";
import { paneRoutes, tabRoutes } from "./routes/panes";
import { projectRoutes } from "./routes/projects";
import { issueRoutes } from "./routes/issues";

export type {
  ControlDeps,
  Json,
  ReadBody,
  Route,
  RouteContext,
} from "./routes/types";

export {
  requestRenderer,
  proxyToRenderer,
  startAgent,
  runSetupScript,
  notifyProjectsChanged,
} from "./routes/renderer-bridge";

export type {
  AppCommand,
  AppCommandResult,
  RendererResponse,
} from "./routes/renderer-bridge";

/**
 * Every route this module serves, in match order.
 *
 * Order is only load-bearing where a static segment competes with a `:param`
 * that would also capture it — `/panes/split` before `/panes/:paneId`, and
 * `/projects/:projectId/workspaces/batch` before the `/workspaces` collection.
 * Each of those is commented at its definition.
 */
const routes: readonly Route[] = [
  ...agentRoutes,
  ...contextRoutes,
  ...paneRoutes,
  ...tabRoutes,
  ...projectRoutes,
  ...issueRoutes,
];

/**
 * First path segments this module answers for. A request under one of these
 * that matches no route is a `404`; anything else is somebody else's route and
 * falls through. See `dispatch`.
 */
const OWNED_PREFIXES = [
  "agents",
  "context",
  "panes",
  "tabs",
  "projects",
] as const;

/**
 * Handle a Manor-control route. Returns true if a route matched and a response
 * was written, false if the caller should try its own routes.
 */
export async function handleControlRequest(
  deps: ControlDeps,
  method: string,
  url: URL,
  json: Json,
  readBody: ReadBody,
): Promise<boolean> {
  return dispatch(routes, OWNED_PREFIXES, deps, method, url, json, readBody);
}
