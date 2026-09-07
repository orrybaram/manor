/**
 * `/panes`, `/tabs`, and `/workspaces` (ADR-149, ADR-171) — layout inspection
 * and mutation, every one of them a thin proxy to a renderer round-trip.
 * Argument validation lives in `src/lib/app-commands.ts`, which the renderer
 * handler calls; a bad argument surfaces as a handler throw, which
 * `proxyToRenderer` maps to 400.
 *
 * These mutate *layout* state, not project state: no `notifyProjectsChanged()`
 * belongs anywhere in this file.
 */

import { proxyToRenderer } from "../renderer-bridge";
import type { Route } from "./types";

export const paneRoutes: Route[] = [
  {
    method: "GET",
    path: "/panes",
    async handler({ json }) {
      await proxyToRenderer(json, "list-panes");
    },
  },

  {
    method: "POST",
    path: "/panes/split",
    async handler({ json, readBody }) {
      await proxyToRenderer(json, "split-pane", await readBody());
    },
  },

  {
    method: "POST",
    path: "/panes/reopen",
    async handler({ json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "reopen-closed-pane");
    },
  },

  {
    method: "POST",
    path: "/panes/focus-next",
    async handler({ json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "focus-next-pane");
    },
  },

  {
    method: "POST",
    path: "/panes/focus-prev",
    async handler({ json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "focus-prev-pane");
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
    method: "POST",
    path: "/panes/:paneId/title",
    async handler({ params, json, readBody }) {
      const body = await readBody();
      const { paneId } = params;
      // `{ title: null }` clears the title; anything else sets it.
      if (body.title === null) {
        await proxyToRenderer(json, "clear-pane-title", { paneId });
      } else {
        await proxyToRenderer(json, "set-pane-title", {
          paneId,
          title: body.title,
        });
      }
    },
  },

  {
    method: "POST",
    path: "/panes/:paneId/move",
    async handler({ params, json, readBody }) {
      const body = await readBody();
      await proxyToRenderer(json, "move-pane", {
        ...body,
        paneId: params.paneId,
      });
    },
  },

  {
    method: "POST",
    path: "/panes/:paneId/extract",
    async handler({ params, json, readBody }) {
      const body = await readBody();
      await proxyToRenderer(json, "extract-pane-to-tab", {
        ...body,
        paneId: params.paneId,
      });
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

const workspaceRoutes: Route[] = [
  {
    method: "POST",
    path: "/workspaces/active",
    async handler({ json, readBody }) {
      await proxyToRenderer(json, "set-active-workspace", await readBody());
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

  {
    method: "POST",
    path: "/tabs/next",
    async handler({ json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "next-tab");
    },
  },

  {
    method: "POST",
    path: "/tabs/prev",
    async handler({ json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "prev-tab");
    },
  },

  {
    method: "POST",
    path: "/tabs/reorder",
    async handler({ json, readBody }) {
      await proxyToRenderer(json, "reorder-tabs", await readBody());
    },
  },

  {
    method: "POST",
    path: "/tabs/diff",
    async handler({ json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "open-diff");
    },
  },

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
    path: "/tabs/:tabId/close",
    async handler({ params, json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "close-tab", { tabId: params.tabId });
    },
  },

  {
    method: "POST",
    path: "/tabs/:tabId/close-others",
    async handler({ params, json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "close-other-tabs", { tabId: params.tabId });
    },
  },

  {
    method: "POST",
    path: "/tabs/:tabId/close-right",
    async handler({ params, json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "close-tabs-to-right", {
        tabId: params.tabId,
      });
    },
  },

  {
    method: "POST",
    path: "/tabs/:tabId/pin",
    async handler({ params, json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "pin-tab", { tabId: params.tabId });
    },
  },

  {
    method: "POST",
    path: "/tabs/:tabId/duplicate",
    async handler({ params, json, readBody }) {
      await readBody();
      await proxyToRenderer(json, "duplicate-tab", { tabId: params.tabId });
    },
  },

  ...workspaceRoutes,
];
