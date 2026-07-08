/**
 * `/panes` and `/tabs` (ADR-149) — layout inspection and mutation, every one of
 * them a thin proxy to a renderer round-trip. Argument validation lives in
 * `src/lib/app-commands.ts`, which the renderer handler calls; a bad argument
 * surfaces as a handler throw, which `proxyToRenderer` maps to 400.
 *
 * These mutate *layout* state, not project state: no `notifyProjectsChanged()`
 * belongs anywhere in this file.
 */

import { proxyToRenderer } from "./renderer-bridge";
import type { Route } from "./types";

export const paneRoutes: Route[] = [
  {
    method: "GET",
    path: "/panes",
    async handler({ json }) {
      await proxyToRenderer(json, "list-panes");
    },
  },

  // Ahead of `/panes/:paneId` on purpose. They happen not to collide today
  // (POST vs DELETE), but a static segment must always outrank the param that
  // would otherwise capture it.
  {
    method: "POST",
    path: "/panes/split",
    async handler({ json, readBody }) {
      await proxyToRenderer(json, "split-pane", await readBody());
    },
  },

  {
    method: "POST",
    path: "/panes/:paneId/focus",
    async handler({ params, json, readBody }) {
      // Nothing in the body is read, but the request stream still has to be
      // drained before we answer.
      await readBody();
      await proxyToRenderer(json, "focus-pane", { paneId: params.paneId });
    },
  },

  {
    method: "DELETE",
    path: "/panes/:paneId",
    async handler({ params, json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "close-pane", { paneId: params.paneId });
    },
  },
];

export const tabRoutes: Route[] = [
  {
    method: "POST",
    path: "/tabs",
    async handler({ json, readBody }) {
      await proxyToRenderer(json, "new-tab", await readBody());
    },
  },
];
