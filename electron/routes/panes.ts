/**
 * `/panes`, `/tabs`, and `/workspaces` (ADR-149, ADR-171) — layout inspection
 * and mutation, split two ways (ADR-179 D5):
 *
 * - **Structural** routes (`./panes-structural.ts`) — split, close, move,
 *   pin, reorder, new tab, reopen — call `LayoutStore.apply()` directly and
 *   need no window.
 * - **Viewport** routes (`./panes-viewport.ts`) — focus, select, next/prev
 *   tab, set the active workspace — proxy to the primary window, because a
 *   viewport is per renderer (D3).
 *
 * Body validation is `./pane-validators.ts`. Every body-carrying route is
 * host-scoped first (`hostScoped`, ADR-191/189).
 */

import type { Route } from "./types";
import { structuralRoutes } from "./panes-structural";
import { viewportRoutes } from "./panes-viewport";
import { withWorkspaceHost } from "./workspace-host";

/**
 * Resolve the host of the workspace a request body names before its handler
 * runs (ADR-191, ADR-189): `body.hostId` becomes the caller's own host for a
 * relayed request — a body naming another host is the generic 403 — else the
 * host it named, else the host of the project that owns `workspacePath`. The
 * handler reads the resolved body through the same `readBody`.
 */
function hostScoped(handler: Route["handler"]): Route["handler"] {
  return async (ctx) => {
    const resolved = withWorkspaceHost(ctx.deps, await ctx.readBody());
    if (!resolved.ok) {
      ctx.json(resolved.status, { error: resolved.error });
      return;
    }
    await handler({ ...ctx, readBody: async () => resolved.body });
  };
}

/** Every body-carrying route of a table, host-scoped (see `hostScoped`). */
function scoped(routes: Route[]): Route[] {
  return routes.map((route) =>
    route.method === "GET" ? route : { ...route, handler: hostScoped(route.handler) },
  );
}

export const paneRoutes: Route[] = scoped([
  ...structuralRoutes,
  ...viewportRoutes,
]);
