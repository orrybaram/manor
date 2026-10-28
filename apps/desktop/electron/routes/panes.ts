/**
 * `/panes`, `/tabs`, and `/workspaces` — layout inspection
 * and mutation, split two ways:
 *
 * - **Structural** routes (`./panes-structural.ts`) — split, close, move,
 *   pin, reorder, new tab, reopen — call `LayoutStore.apply()` directly and
 *   need no window.
 * - **Viewport** routes (`./panes-viewport.ts`) — focus, select, next/prev
 *   tab, set the active workspace — proxy to the primary window, because a
 *   viewport is per renderer.
 *
 * Body validation is `./pane-validators.ts`. Every body-carrying route is
 * host-scoped first (`hostScoped`), except the move-to-workspace routes, which
 * default to the source's host.
 */

import type { Route } from "./types";
import { moveToWorkspaceRoutes, structuralRoutes } from "./panes-structural";
import { viewportRoutes } from "./panes-viewport";
import { withWorkspaceHost } from "./workspace-host";

/**
 * Resolve the host of the workspace a request body names before its handler
 * runs: `body.hostId` is the host it named, else the host of the
 * project that owns `workspacePath`. The handler reads the resolved body through the same `readBody`.
 */
function hostScoped(handler: Route["handler"]): Route["handler"] {
  return async (ctx) => {
    const resolved = withWorkspaceHost(ctx.deps, await ctx.readBody());
    await handler({ ...ctx, readBody: async () => resolved });
  };
}

/** Every body-carrying route of a table, host-scoped (see `hostScoped`). */
function scoped(routes: Route[]): Route[] {
  return routes.map((route) =>
    route.method === "GET" ? route : { ...route, handler: hostScoped(route.handler) },
  );
}

export const paneRoutes: Route[] = [
  ...scoped([...structuralRoutes, ...viewportRoutes]),
  ...moveToWorkspaceRoutes,
];
