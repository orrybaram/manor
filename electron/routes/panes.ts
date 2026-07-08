/**
 * `/panes` and `/tabs` (ADR-149) — layout inspection and mutation, every one of
 * them a validation step in front of a renderer round-trip.
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
      const body = await readBody();
      if (body.direction !== "horizontal" && body.direction !== "vertical") {
        json(400, {
          error: "'direction' must be 'horizontal' or 'vertical'",
        });
        return;
      }
      await proxyToRenderer(json, "split-pane", body);
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
      const body = await readBody();
      if (body.contentType !== "terminal" && body.contentType !== "browser") {
        json(400, {
          error: "'contentType' must be 'terminal' or 'browser'",
        });
        return;
      }
      if (body.contentType === "browser" && typeof body.url !== "string") {
        json(400, {
          error:
            "contentType 'browser' requires a 'url' string in request body",
        });
        return;
      }
      await proxyToRenderer(json, "new-tab", body);
    },
  },
];
