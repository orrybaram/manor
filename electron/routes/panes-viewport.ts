/**
 * Viewport routes (ADR-179 D5): focus, select, next/prev tab, set the active
 * workspace. Each is a `proxyToRenderer` round-trip to the primary window —
 * "which window?" has no server-side answer, because a viewport is per
 * renderer (D3).
 */

import { proxyToRenderer } from "../renderer-bridge";
import type { Route } from "./types";
import { proxyWithWorkspaceHost } from "./workspace-host";

/** A body-less route that forwards one app command to the primary window. */
function proxy(path: string, command: string): Route {
  return {
    method: "POST",
    path,
    async handler({ json, readBody }) {
      await readBody();
      await proxyToRenderer(json, command);
    },
  };
}

export const viewportRoutes: Route[] = [
  proxy("/panes/focus-next", "focus-next-pane"),
  proxy("/panes/focus-prev", "focus-prev-pane"),

  {
    method: "POST",
    path: "/panes/:paneId/focus",
    async handler({ params, json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "focus-pane", { paneId: params.paneId });
    },
  },

  proxy("/tabs/next", "next-tab"),
  proxy("/tabs/prev", "prev-tab"),

  {
    method: "POST",
    path: "/tabs/:tabId/select",
    async handler({ params, json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "select-tab", { tabId: params.tabId });
    },
  },

  {
    method: "POST",
    path: "/workspaces/active",
    // The renderer keys layouts by host plus path (ADR-191): main names the
    // host. Already host-scoped by `paneRoutes`; this resolves a body that
    // named none.
    async handler({ deps, json, readBody }) {
      await proxyWithWorkspaceHost(deps, json, "set-active-workspace", await readBody());
    },
  },
];
