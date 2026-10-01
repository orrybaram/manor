/**
 * Manor-control HTTP routes — project/workspace management, GitHub issue
 * listing, batch issue→workspace fan-out, agent launching, pane/tab control,
 * and webview inspection (ADR-183 folds `webview-server.ts`'s routes in
 * here too, so there is one table and one dispatcher).
 *
 * Consumed by webview-server.ts, which owns the HTTP listener and delegates
 * every request here; a request under none of `OWNED_PREFIXES` is the only
 * thing it can still 404 on its own.
 *
 * This is the table of contents: the route table, the prefixes it answers
 * for (derived from the table, not hand-listed), and `handleControlRequest`.
 * The handlers live alongside this file, the matcher in `./router.ts`, and
 * the "app-command" channel in `../renderer-bridge.ts`.
 */

import { dispatch } from "./router";
import type { RouteDeps, Json, ReadBody, Route } from "./types";
import { agentRoutes } from "./agents";
import { contextRoutes } from "./context";
import { paneRoutes } from "./panes";
import { folderRoutes } from "./folders";
import { projectRoutes } from "./projects";
import { issueRoutes } from "./issues";
import { gitRoutes } from "./git";
import { integrationRoutes } from "./integrations";
import { systemRoutes } from "./system";
import { webviewRoutes } from "./webview";

/**
 * Every route this module serves, in match order. See `router.ts`'s header
 * for when order is load-bearing. Exported for `router.test.ts`, which checks
 * the table itself for ordering hazards rather than trusting a comment.
 */
export const routes: readonly Route[] = [
  ...agentRoutes,
  ...contextRoutes,
  ...paneRoutes,
  ...folderRoutes,
  ...projectRoutes,
  ...issueRoutes,
  ...gitRoutes,
  ...integrationRoutes,
  ...systemRoutes,
  ...webviewRoutes,
];

/**
 * First path segments this module answers for, derived from `routes` so it
 * can never drift from the table: a request under one of these that matches
 * no route is a `404`; anything else is somebody else's route and falls
 * through. See `dispatch`.
 */
const OWNED_PREFIXES = new Set(routes.map((r) => r.path.split("/")[1]));

/**
 * Handle a Manor-control route. Returns true if a route matched and a response
 * was written, false if the caller should try its own routes.
 */
export async function handleControlRequest(
  deps: RouteDeps,
  method: string,
  url: URL,
  json: Json,
  readBody: ReadBody,
): Promise<boolean> {
  return dispatch(routes, OWNED_PREFIXES, deps, method, url, json, readBody);
}
