/**
 * Structural pane and tab routes (ADR-179 D5, ADR-182 D8): split, close,
 * move, extract, pin, reorder, duplicate, new tab, reopen — plus `GET /panes`
 * and a pane's title, which read and write the store without a command.
 *
 * Each command route is a `structural` spec (`./structural-route.ts`). None
 * of them needs a window: `manor split-pane` works with the desktop closed.
 * Ids a command needs are minted here, by the sender, never by the reducer
 * (`src/lib/layout/commands/`).
 *
 * `command` / `paneCommand` — "open this tab and run `pnpm dev` in it" — is
 * queued on the server's `pendingCommands` map and typed by `pty.create` when
 * the pane first gets a shell. It cannot be sent from here, because the pane
 * does not exist yet and no renderer has mounted it.
 */

import type { Route } from "./types";
import { allPaneIds } from "../../src/lib/layout/pane-tree";
import { createTab, newPaneId, newTabId } from "../../src/lib/layout/ids";
import {
  cloneTabWithFreshIds,
  createBrowserTab,
  createDiffTab,
  findDiffPane,
} from "../../src/lib/layout/tab-builders";
import {
  findPanelWithPane,
  findPanelWithTab,
} from "../../src/lib/layout/workspace-layout";
import { focusedPaneOf, selectedTabOf } from "../../src/lib/layout/viewport";
import { buildLayoutSnapshot } from "../../src/lib/layout/snapshot";
import {
  SPLIT_CONTENT_TYPES,
  TAB_CONTENT_TYPES,
  optionalBoolean,
  optionalString,
  parseEnum,
  parseOptionalEnum,
  parseSplitPlacement,
  requireString,
  requireStringArray,
} from "./pane-validators";
import { structural, tabRoute } from "./structural-route";

const REORDER_UNKNOWN = "reorder-tabs: no such panel for these tabIds";

export const structuralRoutes: Route[] = [
  {
    method: "GET",
    path: "/panes",
    async handler({ deps, url, json }) {
      const store = deps.layoutStore;
      const workspacePath =
        url.searchParams.get("workspacePath") ||
        store.getLastActiveWorkspacePath();
      if (!workspacePath) {
        json(400, { error: "No active workspace" });
        return;
      }
      const entry = store.get(workspacePath);
      if (!entry) {
        json(400, { error: `Unknown workspace: ${workspacePath}` });
        return;
      }
      // The primary window's own report, with the most recent window report
      // as the fallback — see `LayoutStore.primaryViewport`.
      const viewport = store.primaryViewport(workspacePath);
      json(200, buildLayoutSnapshot(workspacePath, entry.layout, viewport));
    },
  },

  {
    method: "POST",
    path: "/panes/split",
    handler: structural({
      parse: ({ body }) => {
        const paneId = optionalString(body, "paneId");
        const placement = parseSplitPlacement(body);
        const contentType = parseOptionalEnum(
          body.contentType,
          SPLIT_CONTENT_TYPES,
          "contentType",
        );
        const url = optionalString(body, "url");
        const command = optionalString(body, "command");
        if (url && contentType !== "browser") {
          throw new Error("url applies only to contentType 'browser'");
        }
        if (command && (contentType === "browser" || contentType === "diff")) {
          throw new Error("command applies only to a terminal or agent pane");
        }
        return { paneId, ...placement, contentType, url, command };
      },
      locate: ({ paneId }) => (paneId ? { paneId } : undefined),
      command: (p, { store, workspacePath, entry }) => {
        // No paneId named: best guess is the primary's focused pane. There
        // is no viewport to ask when nothing has ever reported one.
        const viewport = store.primaryViewport(workspacePath) ?? undefined;
        const target =
          p.paneId ??
          focusedPaneOf(viewport, selectedTabOf(viewport, viewport?.activePanelId));
        if (!target) {
          throw new Error(
            "No paneId given and no window has reported a focused pane to guess from",
          );
        }
        if (!entry || !findPanelWithPane(entry.layout, target)) {
          throw new Error(`Unknown paneId: ${target}`);
        }
        return {
          type: "split-pane-at",
          paneId: target,
          direction: p.direction,
          position: p.position,
          newPaneId: newPaneId(),
          // `agent` is a terminal that runs a command; the tree never says so.
          contentType: p.contentType === "agent" ? undefined : p.contentType,
          url: p.url,
        };
      },
      pending: (p, command) => ({
        paneId: command.newPaneId,
        text: p.command,
        kind: p.contentType === "agent" ? "agent-startup" : "shell",
      }),
      respond: ({ command }) => ({ paneId: command.newPaneId }),
    }),
  },

  {
    method: "POST",
    path: "/panes/reopen",
    handler: structural({
      // Viewport default: the active panel, when a window has reported one.
      command: (_, { store, workspacePath }) => ({
        type: "reopen-closed-pane",
        newTabId: newTabId(),
        panelId: store.primaryViewport(workspacePath)?.activePanelId ?? undefined,
      }),
      respond: ({ result: { addedPaneIds } }) => ({
        reopened: addedPaneIds.length > 0,
        ...(addedPaneIds.length === 1 && { paneId: addedPaneIds[0] }),
      }),
    }),
  },

  {
    method: "POST",
    path: "/panes/:paneId/title",
    async handler({ deps, params, json, readBody }) {
      const store = deps.layoutStore;
      const body = await readBody();
      const { paneId } = params;
      if (body.title !== null && typeof body.title !== "string") {
        json(400, { error: "Argument title must be a string or null" });
        return;
      }
      // Off the command channel (ADR-182 D1): `LayoutStore.setPaneTitle`
      // finds the owning workspace itself and broadcasts, so this route
      // neither resolves a workspace nor sends a command.
      if (!store.setPaneTitle(paneId, body.title as string | null)) {
        json(400, { error: `Unknown paneId: ${paneId}` });
        return;
      }
      json(200, body.title === null ? { paneId } : { paneId, title: body.title });
    },
  },

  {
    method: "POST",
    path: "/panes/:paneId/move",
    handler: structural({
      parse: ({ body, params }) => ({
        paneId: params.paneId,
        targetPaneId: requireString(body, "targetPaneId"),
        ...parseSplitPlacement(body),
      }),
      locate: ({ paneId }) => ({ paneId }),
      command: (p, { entry }) => {
        if (!entry || !findPanelWithPane(entry.layout, p.targetPaneId)) {
          throw new Error(`Unknown paneId: ${p.targetPaneId}`);
        }
        return {
          type: "move-pane",
          sourcePaneId: p.paneId,
          targetPaneId: p.targetPaneId,
          direction: p.direction,
          position: p.position,
        };
      },
      respond: ({ parsed }) => ({ paneId: parsed.paneId }),
    }),
  },

  {
    method: "POST",
    path: "/panes/:paneId/extract",
    handler: structural({
      parse: ({ body, params }) => ({
        paneId: params.paneId,
        targetPanelId: optionalString(body, "targetPanelId"),
      }),
      locate: ({ paneId }) => ({ paneId }),
      command: ({ paneId, targetPanelId }, { entry }) => {
        if (targetPanelId && !entry?.layout.panels[targetPanelId]) {
          throw new Error(`Unknown panelId: ${targetPanelId}`);
        }
        return {
          type: "extract-pane-to-tab",
          paneId,
          targetPanelId,
          newTabId: newTabId(),
        };
      },
      // The tab the pane ended up in — the minted one, or the tab it already
      // had when it was that tab's only pane.
      respond: ({ command, result }) => ({
        tabId: result.hint?.selectTab?.tabId ?? command.newTabId,
      }),
    }),
  },

  {
    method: "DELETE",
    path: "/panes/:paneId",
    handler: structural({
      parse: ({ params }) => params.paneId,
      locate: (paneId) => ({ paneId }),
      command: (paneId) => ({ type: "close-pane", paneId }),
      respond: () => ({ ok: true }),
    }),
  },

  {
    method: "POST",
    path: "/tabs",
    handler: structural({
      parse: ({ body }) => {
        const contentType = parseEnum(
          body.contentType,
          TAB_CONTENT_TYPES,
          "contentType",
        );
        const url = optionalString(body, "url");
        const command = optionalString(body, "command");
        const background = optionalBoolean(body, "background");
        if (command && contentType === "browser") {
          throw new Error("command applies only to a terminal tab");
        }
        if (contentType === "browser" && !url) {
          throw new Error('new-tab with contentType "browser" requires a url');
        }
        if (contentType !== "browser" && url) {
          throw new Error("url applies only to contentType 'browser'");
        }
        if (contentType !== "browser" && background !== undefined) {
          throw new Error("background applies only to contentType 'browser'");
        }
        return { contentType, url, command, background };
      },
      command: ({ contentType, url, background }) =>
        contentType === "browser"
          ? {
              type: "new-tab",
              tab: createBrowserTab(url!),
              select: !(background ?? false),
            }
          : { type: "new-tab", tab: createTab(), select: true },
      pending: (p, command) => ({
        paneId: allPaneIds(command.tab.rootNode)[0],
        text: p.command,
      }),
      respond: ({ command: { tab } }) => ({
        tabId: tab.id,
        paneId: allPaneIds(tab.rootNode)[0],
      }),
    }),
  },

  {
    method: "POST",
    path: "/tabs/reorder",
    handler: structural({
      parse: ({ body }) => requireStringArray(body, "tabIds"),
      locate: (tabIds) =>
        tabIds[0] ? { tabId: tabIds[0], unknown: REORDER_UNKNOWN } : undefined,
      command: (tabIds, { entry }) => {
        const found = tabIds[0] && entry && findPanelWithTab(entry.layout, tabIds[0]);
        if (!found) throw new Error(REORDER_UNKNOWN);
        const current = found.panel.tabs.map((t) => t.id);
        const sameSet =
          tabIds.length === current.length &&
          new Set(tabIds).size === tabIds.length &&
          current.every((id) => tabIds.includes(id));
        if (!sameSet) {
          throw new Error(
            "reorder-tabs: tabIds must contain exactly the panel's current tabs",
          );
        }
        return { type: "reorder-tabs", panelId: found.panel.id, tabIds };
      },
      respond: () => ({ ok: true }),
    }),
  },

  {
    method: "POST",
    path: "/tabs/diff",
    handler: structural({
      // A workspace has at most one diff pane, anywhere in any tab: an
      // existing one is named back rather than opened twice.
      answer: (_, { entry }) => {
        const existing = entry && findDiffPane(entry.layout);
        return existing ? { tabId: existing.tabId } : undefined;
      },
      command: () => ({ type: "new-tab", tab: createDiffTab() }),
      respond: ({ command }) => ({ tabId: command.tab.id }),
    }),
  },

  tabRoute("/tabs/:tabId/close", (tabId) => ({ type: "close-tab", tabId })),
  tabRoute("/tabs/:tabId/close-others", (tabId) => ({
    type: "close-other-tabs",
    tabId,
  })),
  tabRoute("/tabs/:tabId/close-right", (tabId) => ({
    type: "close-tabs-to-right",
    tabId,
  })),

  tabRoute(
    "/tabs/:tabId/pin",
    (tabId) => ({ type: "toggle-pin-tab", tabId }),
    (tabId, _, { store, workspacePath }) => {
      const after = store.get(workspacePath);
      const found = after && findPanelWithTab(after.layout, tabId);
      return {
        tabId,
        pinned: found ? found.panel.pinnedTabIds.includes(tabId) : false,
      };
    },
  ),

  tabRoute(
    "/tabs/:tabId/duplicate",
    (tabId, { entry }) => {
      const found = entry && findPanelWithTab(entry.layout, tabId);
      if (!found) throw new Error(`Unknown tabId: ${tabId}`);
      return {
        type: "duplicate-tab",
        tabId,
        newTab: cloneTabWithFreshIds(found.tab).tab,
      };
    },
    (_, command) => ({ tabId: command.newTab.id }),
  ),
];
