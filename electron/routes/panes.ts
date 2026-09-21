/**
 * `/panes`, `/tabs`, and `/workspaces` (ADR-149, ADR-171) — layout inspection
 * and mutation.
 *
 * Split two ways (ADR-179 D5):
 *
 * - **Structural** routes — split, close, move, pin, reorder, new tab,
 *   reopen — call `deps.layoutStore.apply()` directly. They mint whatever
 *   ids the command needs (a sender's job, never the reducer's — see
 *   `src/lib/layout/commands/`), resolve which workspace from the request
 *   the same way every time (see `resolveWorkspacePath`), and need no
 *   window: `manor split-pane` now works with the desktop closed.
 * - **Viewport** routes — focus, select, next/prev tab, set the active
 *   workspace — stay a `proxyToRenderer` round-trip to the primary. "Which
 *   window?" has no server-side answer; a viewport is per renderer (D3).
 *
 * `GET /panes` is its own thing: a `LayoutSnapshot` built straight from
 * structure plus the primary's last reported viewport, again no window
 * required.
 *
 * Argument validation that used to live in `src/lib/app-commands.ts` moves
 * here with the routes it guarded — a bad argument is still a 400, just
 * thrown before the store is touched rather than inside a renderer.
 *
 * `command` / `paneCommand` — "open this tab and run `pnpm dev` in it" — is
 * queued on the server's `pendingCommands` map and typed by `pty.create` when
 * the pane first gets a shell (ticket 11). It cannot be sent from here,
 * because the pane does not exist yet and no renderer has mounted it.
 */

import { proxyToRenderer } from "../renderer-bridge";
import type { ControlDeps, Json, Route } from "./types";
import type { LayoutOrigin, LayoutStore } from "../layout/layout-store";
import type { LayoutCommand } from "../../src/lib/layout/commands";
import { allPaneIds, clonePaneTree } from "../../src/lib/layout/pane-tree";
import { createTab, newPaneId, newTabId } from "../../src/lib/layout/ids";
import {
  findPanelWithPane,
  findPanelWithTab,
  type PaneContentType,
  type WorkspaceLayout,
} from "../../src/lib/layout/workspace-layout";
import { focusedPaneOf, selectedTabOf } from "../../src/lib/layout/viewport";
import { buildLayoutSnapshot } from "../../src/lib/layout/snapshot";

// ── Every command from these routes names the same sender ──
const ROUTE_ORIGIN: LayoutOrigin = { kind: "route", id: "cli" };

// ── Small body validators, moved from `src/lib/app-commands.ts` ──

const SPLIT_CONTENT_TYPES = ["terminal", "browser", "diff", "agent"] as const;
type SplitContentType = (typeof SPLIT_CONTENT_TYPES)[number];

const TAB_CONTENT_TYPES = ["terminal", "browser"] as const;
type TabContentType = (typeof TAB_CONTENT_TYPES)[number];

const SPLIT_DIRECTIONS = ["horizontal", "vertical"] as const;
type SplitDirection = (typeof SPLIT_DIRECTIONS)[number];
const SPLIT_POSITIONS = ["first", "second"] as const;
type SplitPosition = (typeof SPLIT_POSITIONS)[number];

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Argument ${key} must be a string`);
  }
  return value;
}

function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`Argument ${key} must be a boolean`);
  }
  return value;
}

function requireStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`Argument ${key} must be an array of strings`);
  }
  return value as string[];
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(
      `Argument ${key} must be one of: ${allowed.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
  return value as T;
}

function parseOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string,
): T | undefined {
  if (value === undefined || value === null) return undefined;
  return parseEnum(value, allowed, key);
}

/** A handler's validation throw, turned into the same 400 `proxyToRenderer`
 *  would have produced for a renderer-side handler throw. */
function badRequest(json: Json, err: unknown): void {
  json(400, { error: err instanceof Error ? err.message : String(err) });
}

// ── Dependency and workspace resolution ──

function requireLayoutStore(deps: ControlDeps, json: Json): LayoutStore | null {
  if (!deps.layoutStore) {
    json(503, { error: "Layout store is not available" });
    return null;
  }
  return deps.layoutStore;
}

function findWorkspaceWithPane(store: LayoutStore, paneId: string): string | null {
  for (const [workspacePath, entry] of Object.entries(store.getAll())) {
    if (findPanelWithPane(entry.layout, paneId)) return workspacePath;
  }
  return null;
}

function findWorkspaceWithTab(store: LayoutStore, tabId: string): string | null {
  for (const [workspacePath, entry] of Object.entries(store.getAll())) {
    if (findPanelWithTab(entry.layout, tabId)) return workspacePath;
  }
  return null;
}

const NO_WORKSPACE_ERROR =
  "No workspace: pass workspacePath, name a paneId/tabId already open in one, or open a workspace first";

/**
 * Which workspace a structural request is about (ADR-179 D5).
 *
 * `body.workspacePath` always wins. Failing that, most routes name an id —
 * the workspace holding it is unambiguous, since a pane or tab lives in
 * exactly one. Failing that too, the primary's last-active workspace is the
 * boot fallback ticket 4 left this for, not a general default — but it is
 * the only thing left to try before answering 400.
 */
function resolveWorkspacePath(
  store: LayoutStore,
  body: Record<string, unknown>,
  named?: { paneId?: string; tabId?: string },
): string | null {
  if (typeof body.workspacePath === "string" && body.workspacePath) {
    return body.workspacePath;
  }
  if (named?.paneId) {
    const found = findWorkspaceWithPane(store, named.paneId);
    if (found) return found;
  }
  if (named?.tabId) {
    const found = findWorkspaceWithTab(store, named.tabId);
    if (found) return found;
  }
  return store.getLastActiveWorkspacePath();
}

/** Send one command, answering 400 on refusal. Resolves `true` iff it landed. */
async function applyOrError(
  store: LayoutStore,
  workspacePath: string,
  command: LayoutCommand,
  json: Json,
): Promise<boolean> {
  const result = await store.apply(workspacePath, command, ROUTE_ORIGIN);
  if ("error" in result) {
    json(400, { error: result.error });
    return false;
  }
  return true;
}

/**
 * Queue a route's `command` for the pane it is about to mint (ticket 11).
 *
 * Before the `apply`, never after: the broadcast the apply sends is what makes
 * a renderer mount the pane, and a mount that reached `pty.create` first would
 * find nothing waiting and open a bare shell. If the command is then refused,
 * the caller clears the entry again.
 *
 * This is the whole of what `command` / `paneCommand` used to mean and stopped
 * meaning when these routes left the renderer: it seeded the *sender's* own
 * pending map, and a route has no sender to seed.
 */
function queuePendingCommand(
  store: LayoutStore,
  paneId: string,
  command: string | undefined,
  contentType?: SplitContentType | TabContentType,
): void {
  if (!command) return;
  store.pendingCommands.set(
    paneId,
    command,
    contentType === "agent" ? "agent-startup" : "shell",
  );
}

export const paneRoutes: Route[] = [
  {
    method: "GET",
    path: "/panes",
    async handler({ deps, url, json }) {
      const store = requireLayoutStore(deps, json);
      if (!store) return;
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
    async handler({ deps, json, readBody }) {
      const store = requireLayoutStore(deps, json);
      if (!store) return;
      const body = await readBody();
      try {
        const paneId = optionalString(body, "paneId");
        const direction = parseEnum<SplitDirection>(
          body.direction,
          SPLIT_DIRECTIONS,
          "direction",
        );
        const position =
          parseOptionalEnum<SplitPosition>(
            body.position,
            SPLIT_POSITIONS,
            "position",
          ) ?? "second";
        const contentType = parseOptionalEnum<SplitContentType>(
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

        const workspacePath = resolveWorkspacePath(
          store,
          body,
          paneId ? { paneId } : undefined,
        );
        if (!workspacePath) {
          json(400, { error: NO_WORKSPACE_ERROR });
          return;
        }

        const entry = store.get(workspacePath);
        const layout = entry?.layout ?? null;
        // No paneId named: best guess is the primary's focused pane. There is
        // no viewport to ask when nothing has ever reported one.
        const viewport = store.primaryViewport(workspacePath) ?? undefined;
        const target =
          paneId ??
          focusedPaneOf(viewport, selectedTabOf(viewport, viewport?.activePanelId));
        if (!target) {
          json(400, {
            error:
              "No paneId given and no window has reported a focused pane to guess from",
          });
          return;
        }
        if (!layout || !findPanelWithPane(layout, target)) {
          json(400, { error: `Unknown paneId: ${target}` });
          return;
        }

        const treeContentType: PaneContentType | undefined =
          contentType === "agent" ? undefined : contentType;
        const mintedPaneId = newPaneId();
        queuePendingCommand(store, mintedPaneId, command, contentType);
        const ok = await applyOrError(
          store,
          workspacePath,
          {
            type: "split-pane-at",
            paneId: target,
            direction,
            position,
            newPaneId: mintedPaneId,
            contentType: treeContentType,
            url,
          },
          json,
        );
        if (!ok) {
          store.pendingCommands.clear(mintedPaneId);
          return;
        }
        json(200, { paneId: mintedPaneId });
      } catch (err) {
        badRequest(json, err);
      }
    },
  },

  {
    method: "POST",
    path: "/panes/reopen",
    async handler({ deps, json, readBody }) {
      const store = requireLayoutStore(deps, json);
      if (!store) return;
      const body = await readBody();
      const workspacePath = resolveWorkspacePath(store, body);
      if (!workspacePath) {
        json(400, { error: NO_WORKSPACE_ERROR });
        return;
      }

      // Viewport default: the active panel, when a window has reported one.
      const panelId =
        store.primaryViewport(workspacePath)?.activePanelId ?? undefined;

      const result = await store.apply(
        workspacePath,
        { type: "reopen-closed-pane", newTabId: newTabId(), panelId },
        ROUTE_ORIGIN,
      );
      if ("error" in result) {
        json(400, { error: result.error });
        return;
      }
      const { addedPaneIds } = result;
      json(200, {
        reopened: addedPaneIds.length > 0,
        ...(addedPaneIds.length === 1 && { paneId: addedPaneIds[0] }),
      });
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
      await readBody();
      await proxyToRenderer(json, "focus-pane", { paneId: params.paneId });
    },
  },

  {
    method: "POST",
    path: "/panes/:paneId/title",
    async handler({ deps, params, json, readBody }) {
      const store = requireLayoutStore(deps, json);
      if (!store) return;
      const body = await readBody();
      const { paneId } = params;
      if (body.title !== null && typeof body.title !== "string") {
        json(400, { error: "Argument title must be a string or null" });
        return;
      }

      // Off the command channel (ADR-182 D1): `LayoutStore.setPaneTitle`
      // finds the owning workspace itself and broadcasts, so this route no
      // longer resolves a workspace or sends a command — both of which the
      // old `set-pane-title` command swallowed silently.
      const ok = store.setPaneTitle(paneId, body.title as string | null);
      if (!ok) {
        json(400, { error: `Unknown paneId: ${paneId}` });
        return;
      }
      json(
        200,
        body.title === null ? { paneId } : { paneId, title: body.title },
      );
    },
  },

  {
    method: "POST",
    path: "/panes/:paneId/move",
    async handler({ deps, params, json, readBody }) {
      const store = requireLayoutStore(deps, json);
      if (!store) return;
      const body = await readBody();
      try {
        const paneId = params.paneId;
        const targetPaneId = requireString(body, "targetPaneId");
        const direction = parseEnum<SplitDirection>(
          body.direction,
          SPLIT_DIRECTIONS,
          "direction",
        );
        const position =
          parseOptionalEnum<SplitPosition>(
            body.position,
            SPLIT_POSITIONS,
            "position",
          ) ?? "second";

        const workspacePath = resolveWorkspacePath(store, body, { paneId });
        if (!workspacePath) {
          json(400, { error: NO_WORKSPACE_ERROR });
          return;
        }
        const entry = store.get(workspacePath);
        if (!entry || !findPanelWithPane(entry.layout, paneId)) {
          json(400, { error: `Unknown paneId: ${paneId}` });
          return;
        }
        if (!findPanelWithPane(entry.layout, targetPaneId)) {
          json(400, { error: `Unknown paneId: ${targetPaneId}` });
          return;
        }

        const ok = await applyOrError(
          store,
          workspacePath,
          {
            type: "move-pane",
            sourcePaneId: paneId,
            targetPaneId,
            direction,
            position,
          },
          json,
        );
        if (!ok) return;
        json(200, { paneId });
      } catch (err) {
        badRequest(json, err);
      }
    },
  },

  {
    method: "POST",
    path: "/panes/:paneId/extract",
    async handler({ deps, params, json, readBody }) {
      const store = requireLayoutStore(deps, json);
      if (!store) return;
      const body = await readBody();
      try {
        const paneId = params.paneId;
        const targetPanelId = optionalString(body, "targetPanelId");

        const workspacePath = resolveWorkspacePath(store, body, { paneId });
        if (!workspacePath) {
          json(400, { error: NO_WORKSPACE_ERROR });
          return;
        }
        const entry = store.get(workspacePath);
        if (!entry || !findPanelWithPane(entry.layout, paneId)) {
          json(400, { error: `Unknown paneId: ${paneId}` });
          return;
        }
        if (targetPanelId && !entry.layout.panels[targetPanelId]) {
          json(400, { error: `Unknown panelId: ${targetPanelId}` });
          return;
        }

        const mintedTabId = newTabId();
        const result = await store.apply(
          workspacePath,
          {
            type: "extract-pane-to-tab",
            paneId,
            targetPanelId,
            newTabId: mintedTabId,
          },
          ROUTE_ORIGIN,
        );
        if ("error" in result) {
          json(400, { error: result.error });
          return;
        }
        // The tab the pane ended up in — the minted one, or the tab it
        // already had when it was that tab's only pane.
        json(200, { tabId: result.hint?.selectTab?.tabId ?? mintedTabId });
      } catch (err) {
        badRequest(json, err);
      }
    },
  },

  {
    method: "DELETE",
    path: "/panes/:paneId",
    async handler({ deps, params, json, readBody }) {
      const store = requireLayoutStore(deps, json);
      if (!store) return;
      const body = await readBody();
      const paneId = params.paneId;

      const workspacePath = resolveWorkspacePath(store, body, { paneId });
      if (!workspacePath) {
        json(400, { error: NO_WORKSPACE_ERROR });
        return;
      }
      const entry = store.get(workspacePath);
      if (!entry || !findPanelWithPane(entry.layout, paneId)) {
        json(400, { error: `Unknown paneId: ${paneId}` });
        return;
      }

      const ok = await applyOrError(
        store,
        workspacePath,
        { type: "close-pane", paneId },
        json,
      );
      if (!ok) return;
      json(200, { ok: true });
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
    async handler({ deps, json, readBody }) {
      const store = requireLayoutStore(deps, json);
      if (!store) return;
      const body = await readBody();
      try {
        const contentType = parseEnum<TabContentType>(
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

        const workspacePath = resolveWorkspacePath(store, body);
        if (!workspacePath) {
          json(400, { error: NO_WORKSPACE_ERROR });
          return;
        }

        const tab =
          contentType === "browser"
            ? browserTab(url!)
            : createTab();
        const select = contentType === "browser" ? !(background ?? false) : true;
        const tabPaneId = allPaneIds(tab.rootNode)[0];
        queuePendingCommand(store, tabPaneId, command);

        const ok = await applyOrError(
          store,
          workspacePath,
          { type: "new-tab", tab, select },
          json,
        );
        if (!ok) {
          store.pendingCommands.clear(tabPaneId);
          return;
        }
        json(200, { tabId: tab.id, paneId: tabPaneId });
      } catch (err) {
        badRequest(json, err);
      }
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
    async handler({ deps, json, readBody }) {
      const store = requireLayoutStore(deps, json);
      if (!store) return;
      const body = await readBody();
      try {
        const tabIds = requireStringArray(body, "tabIds");

        const workspacePath = resolveWorkspacePath(
          store,
          body,
          tabIds[0] ? { tabId: tabIds[0] } : undefined,
        );
        if (!workspacePath) {
          json(400, { error: NO_WORKSPACE_ERROR });
          return;
        }
        const entry = store.get(workspacePath);
        const found = tabIds[0]
          ? entry && findPanelWithTab(entry.layout, tabIds[0])
          : null;
        if (!entry || !found) {
          json(400, { error: "reorder-tabs: no such panel for these tabIds" });
          return;
        }
        const { panel } = found;
        const current = panel.tabs.map((t) => t.id);
        const sameSet =
          tabIds.length === current.length &&
          new Set(tabIds).size === tabIds.length &&
          current.every((id) => tabIds.includes(id));
        if (!sameSet) {
          json(400, {
            error:
              "reorder-tabs: tabIds must contain exactly the panel's current tabs",
          });
          return;
        }

        const ok = await applyOrError(
          store,
          workspacePath,
          { type: "reorder-tabs", panelId: panel.id, tabIds },
          json,
        );
        if (!ok) return;
        json(200, { ok: true });
      } catch (err) {
        badRequest(json, err);
      }
    },
  },

  {
    method: "POST",
    path: "/tabs/diff",
    async handler({ deps, json, readBody }) {
      const store = requireLayoutStore(deps, json);
      if (!store) return;
      const body = await readBody();
      const workspacePath = resolveWorkspacePath(store, body);
      if (!workspacePath) {
        json(400, { error: NO_WORKSPACE_ERROR });
        return;
      }

      const entry = store.get(workspacePath);
      const existing = entry && findDiffTab(entry.layout);
      if (existing) {
        json(200, { tabId: existing });
        return;
      }

      const tab = diffTab();
      const ok = await applyOrError(
        store,
        workspacePath,
        { type: "new-tab", tab },
        json,
      );
      if (!ok) return;
      json(200, { tabId: tab.id });
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
    async handler({ deps, params, json, readBody }) {
      await withTab(deps, params.tabId, json, readBody, async (store, workspacePath) => {
        const ok = await applyOrError(
          store,
          workspacePath,
          { type: "close-tab", tabId: params.tabId },
          json,
        );
        if (ok) json(200, { ok: true });
      });
    },
  },

  {
    method: "POST",
    path: "/tabs/:tabId/close-others",
    async handler({ deps, params, json, readBody }) {
      await withTab(deps, params.tabId, json, readBody, async (store, workspacePath) => {
        const ok = await applyOrError(
          store,
          workspacePath,
          { type: "close-other-tabs", tabId: params.tabId },
          json,
        );
        if (ok) json(200, { ok: true });
      });
    },
  },

  {
    method: "POST",
    path: "/tabs/:tabId/close-right",
    async handler({ deps, params, json, readBody }) {
      await withTab(deps, params.tabId, json, readBody, async (store, workspacePath) => {
        const ok = await applyOrError(
          store,
          workspacePath,
          { type: "close-tabs-to-right", tabId: params.tabId },
          json,
        );
        if (ok) json(200, { ok: true });
      });
    },
  },

  {
    method: "POST",
    path: "/tabs/:tabId/pin",
    async handler({ deps, params, json, readBody }) {
      const store = requireLayoutStore(deps, json);
      if (!store) return;
      const body = await readBody();
      const tabId = params.tabId;
      const workspacePath = resolveWorkspacePath(store, body, { tabId });
      if (!workspacePath) {
        json(400, { error: NO_WORKSPACE_ERROR });
        return;
      }
      const entry = store.get(workspacePath);
      if (!entry || !findPanelWithTab(entry.layout, tabId)) {
        json(400, { error: `Unknown tabId: ${tabId}` });
        return;
      }
      const ok = await applyOrError(
        store,
        workspacePath,
        { type: "toggle-pin-tab", tabId },
        json,
      );
      if (!ok) return;
      const after = store.get(workspacePath);
      const found = after && findPanelWithTab(after.layout, tabId);
      json(200, {
        tabId,
        pinned: found ? found.panel.pinnedTabIds.includes(tabId) : false,
      });
    },
  },

  {
    method: "POST",
    path: "/tabs/:tabId/duplicate",
    async handler({ deps, params, json, readBody }) {
      const store = requireLayoutStore(deps, json);
      if (!store) return;
      const body = await readBody();
      const tabId = params.tabId;
      const workspacePath = resolveWorkspacePath(store, body, { tabId });
      if (!workspacePath) {
        json(400, { error: NO_WORKSPACE_ERROR });
        return;
      }
      const entry = store.get(workspacePath);
      const found = entry && findPanelWithTab(entry.layout, tabId);
      if (!entry || !found) {
        json(400, { error: `Unknown tabId: ${tabId}` });
        return;
      }
      const sourceTab = found.tab;
      // Every pane of the source gets a fresh id: a duplicated tab is a
      // second set of sessions, not a second view of the first.
      const { tree: clonedRoot } = clonePaneTree(sourceTab.rootNode, newPaneId);
      const newTab = {
        id: newTabId(),
        title: sourceTab.title,
        rootNode: clonedRoot,
      };
      const ok = await applyOrError(
        store,
        workspacePath,
        { type: "duplicate-tab", tabId, newTab },
        json,
      );
      if (!ok) return;
      json(200, { tabId: newTab.id });
    },
  },

  ...workspaceRoutes,
];

/** The first tab, anywhere in the layout, whose pane is a `diff` leaf. */
function findDiffTab(layout: WorkspaceLayout): string | null {
  for (const panel of Object.values(layout.panels)) {
    for (const tab of panel.tabs) {
      if (tab.rootNode.type === "leaf" && tab.rootNode.contentType === "diff") {
        return tab.id;
      }
    }
  }
  return null;
}

function diffTab() {
  const paneId = newPaneId();
  return {
    id: newTabId(),
    title: "Diff",
    rootNode: { type: "leaf" as const, paneId, contentType: "diff" as const },
  };
}

/** A fresh single-pane browser tab, titled from the URL's host. */
function browserTab(url: string) {
  const paneId = newPaneId();
  let title: string;
  try {
    title = new URL(url).host || url;
  } catch {
    title = url;
  }
  return {
    id: newTabId(),
    title,
    rootNode: {
      type: "leaf" as const,
      paneId,
      contentType: "browser" as const,
      url,
    },
  };
}

/**
 * Shared preamble for the `/tabs/:tabId/*` routes that only need the tab to
 * exist: resolve the store and workspace, validate the tab, drain the body,
 * then hand off to `run`.
 */
async function withTab(
  deps: ControlDeps,
  tabId: string,
  json: Json,
  readBody: () => Promise<Record<string, unknown>>,
  run: (store: LayoutStore, workspacePath: string) => Promise<void>,
): Promise<void> {
  const store = requireLayoutStore(deps, json);
  if (!store) return;
  const body = await readBody();
  const workspacePath = resolveWorkspacePath(store, body, { tabId });
  if (!workspacePath) {
    json(400, { error: NO_WORKSPACE_ERROR });
    return;
  }
  const entry = store.get(workspacePath);
  if (!entry || !findPanelWithTab(entry.layout, tabId)) {
    json(400, { error: `Unknown tabId: ${tabId}` });
    return;
  }
  await run(store, workspacePath);
}
