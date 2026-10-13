/**
 * The control routes every Manor server answers (ADR-227 D8): projects,
 * workspaces, folders, issues, agents and `/context`. They read only
 * `ServerRouteDeps` and import no Electron, so the host server dispatches
 * them for its box's `manor` CLI (`../host-server/cli-relay.ts`) and for
 * the desktop's requests about its projects, through the same code the
 * desktop's own control server runs (`./index.ts`).
 *
 * What only the desktop answers — panes, tabs, webviews, the browser and
 * the system routes (`shell`, the updater, windows) — is not here.
 *
 * Electron-free: the host server bundles it.
 */

import { agentRoutes } from "./agents";
import { contextRoutes } from "./context";
import { folderRoutes } from "./folders";
import { integrationRoutes } from "./integrations";
import { issueRoutes } from "./issues";
import { projectRoutes } from "./projects";
import { dispatch } from "./router";
import type { Json, ReadBody, ServerRoute, ServerRouteDeps } from "./types";

/** In the desktop table's order (`./index.ts`), less its desktop-only rows. */
export const serverRoutes: readonly ServerRoute[] = [
  ...agentRoutes,
  ...contextRoutes,
  ...folderRoutes,
  ...projectRoutes,
  ...issueRoutes,
  ...integrationRoutes,
];

/** First path segments `serverRoutes` answers for; see `./index.ts`. */
const SERVER_PREFIXES = new Set(serverRoutes.map((r) => r.path.split("/")[1]));

/**
 * Handle a request with `serverRoutes`. False when none of them owns its
 * first segment, as `handleControlRequest` answers.
 */
export function handleServerControlRequest(
  deps: ServerRouteDeps,
  method: string,
  url: URL,
  json: Json,
  readBody: ReadBody,
): Promise<boolean> {
  return dispatch(serverRoutes, SERVER_PREFIXES, deps, method, url, json, readBody);
}
