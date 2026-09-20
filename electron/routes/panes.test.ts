/**
 * `/panes`, `/tabs` and `/workspaces` (ADR-179 D5) — structural routes call
 * `LayoutStore.apply()` directly and need no window; viewport routes still
 * proxy to the primary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../renderer-bridge", () => ({
  proxyToRenderer: vi.fn(async (json: (status: number, body: unknown) => void) => {
    json(200, { ok: true });
  }),
}));

import { proxyToRenderer } from "../renderer-bridge";
import { paneRoutes, tabRoutes } from "./panes";
import type { ControlDeps, Route } from "./types";
import { LayoutStore } from "../layout/layout-store";
import { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { LocalBackend } from "../backend/local-backend";

const WS = "/project/main";
const OTHER_WS = "/project/other";

function findRoute(routes: Route[], method: Route["method"], path: string): Route {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`No route ${method} ${path}`);
  return route;
}

async function call(
  route: Route,
  deps: ControlDeps,
  {
    params = {},
    body = {},
    query = "",
  }: {
    params?: Record<string, string>;
    body?: Record<string, unknown>;
    query?: string;
  } = {},
) {
  const calls: Array<{ status: number; body: any }> = [];
  await route.handler({
    deps,
    params,
    url: new URL(`http://localhost${route.path}${query}`),
    json: (status, b) => calls.push({ status, body: b }),
    readBody: async () => body,
  });
  return calls[0];
}

describe("panes/tabs routes (ADR-179 D5)", () => {
  let tmpDir: string;
  let store: LayoutStore;
  let deps: ControlDeps;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-panes-routes-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const persistence = new LayoutPersistence(path.join(tmpDir, "layout.json"));
    store = new LayoutStore(
      persistence,
      () => {},
      { pty: { kill: vi.fn().mockResolvedValue(undefined) } } as unknown as Pick<
        LocalBackend,
        "pty"
      >,
    );
    deps = { layoutStore: store } as ControlDeps;
    vi.mocked(proxyToRenderer).mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A plain terminal tab, seeded directly through the real reducer. */
  async function seedTab(workspacePath: string): Promise<{
    tabId: string;
    paneId: string;
  }> {
    const tabId = `tab-${crypto.randomUUID()}`;
    const paneId = `pane-${crypto.randomUUID()}`;
    await store.apply(
      workspacePath,
      {
        type: "new-tab",
        tab: { id: tabId, title: "Terminal", rootNode: { type: "leaf", paneId } },
      },
      { kind: "route", id: "test" },
    );
    return { tabId, paneId };
  }

  describe("POST /panes/split", () => {
    const route = findRoute(paneRoutes, "POST", "/panes/split");

    it("mints a new paneId and applies split-pane-at", async () => {
      const { paneId } = await seedTab(WS);
      const res = await call(route, deps, {
        body: { paneId, direction: "horizontal", workspacePath: WS },
      });

      expect(res.status).toBe(200);
      expect(res.body.paneId).toEqual(expect.any(String));
      expect(res.body.paneId).not.toBe(paneId);

      const entry = store.get(WS)!;
      const tab = entry.layout.panels[Object.keys(entry.layout.panels)[0]].tabs[0];
      expect(tab.rootNode.type).toBe("split");
    });

    it("resolves the workspace from the named paneId when workspacePath is omitted", async () => {
      const { paneId } = await seedTab(WS);
      const res = await call(route, deps, {
        body: { paneId, direction: "horizontal" },
      });
      expect(res.status).toBe(200);
    });

    it("targets the primary viewport's focused pane when no paneId is given", async () => {
      const { paneId } = await seedTab(WS);
      const entry = store.get(WS)!;
      const panelId = Object.keys(entry.layout.panels)[0];
      store.reportViewport(
        WS,
        { kind: "window", id: "win-1" },
        {
          activePanelId: panelId,
          selectedTabIds: { [panelId]: entry.layout.panels[panelId].tabs[0].id },
          focusedPaneIds: { [entry.layout.panels[panelId].tabs[0].id]: paneId },
        },
      );

      const res = await call(route, deps, {
        body: { direction: "vertical", workspacePath: WS },
      });
      expect(res.status).toBe(200);
      expect(res.body.paneId).toEqual(expect.any(String));
    });

    it("400s when no paneId is given and no window has reported a viewport", async () => {
      await seedTab(WS);
      const res = await call(route, deps, {
        body: { direction: "horizontal", workspacePath: WS },
      });
      expect(res.status).toBe(400);
    });

    it("400s on an unknown paneId", async () => {
      await seedTab(WS);
      const res = await call(route, deps, {
        body: { paneId: "no-such-pane", direction: "horizontal", workspacePath: WS },
      });
      expect(res.status).toBe(400);
    });

    it("400s naming the option when no workspace resolves at all", async () => {
      const res = await call(route, deps, {
        body: { direction: "horizontal" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/workspacePath/);
    });

    it("400s on an invalid direction", async () => {
      const { paneId } = await seedTab(WS);
      const res = await call(route, deps, {
        body: { paneId, direction: "sideways", workspacePath: WS },
      });
      expect(res.status).toBe(400);
    });

    /**
     * What MCP's `split_pane` and the agent fan-out (ADR-176) actually ask
     * for. Between ticket 5 and ticket 11 the argument was validated and then
     * silently dropped, because the only home for it was a renderer's own map.
     */
    it("records a pending command for the pane it minted", async () => {
      const { paneId } = await seedTab(WS);
      const res = await call(route, deps, {
        body: {
          paneId,
          direction: "horizontal",
          contentType: "agent",
          command: "claude",
          workspacePath: WS,
        },
      });

      expect(res.status).toBe(200);
      expect(store.pendingCommands.take(res.body.paneId)).toEqual({
        text: "claude",
        kind: "agent-startup",
      });
    });

    it("records a plain shell command for a terminal split", async () => {
      const { paneId } = await seedTab(WS);
      const res = await call(route, deps, {
        body: {
          paneId,
          direction: "horizontal",
          command: "pnpm dev",
          workspacePath: WS,
        },
      });

      expect(store.pendingCommands.take(res.body.paneId)).toEqual({
        text: "pnpm dev",
        kind: "shell",
      });
    });

    it("leaves nothing queued when the split is refused", async () => {
      await seedTab(WS);
      const res = await call(route, deps, {
        body: {
          paneId: "no-such-pane",
          direction: "horizontal",
          command: "pnpm dev",
          workspacePath: WS,
        },
      });

      expect(res.status).toBe(400);
      expect(store.pendingCommands.size).toBe(0);
    });

    it("400s a command on a browser split, and queues nothing", async () => {
      const { paneId } = await seedTab(WS);
      const res = await call(route, deps, {
        body: {
          paneId,
          direction: "horizontal",
          contentType: "browser",
          command: "pnpm dev",
          workspacePath: WS,
        },
      });

      expect(res.status).toBe(400);
      expect(store.pendingCommands.size).toBe(0);
    });
  });

  describe("POST /panes/reopen", () => {
    const route = findRoute(paneRoutes, "POST", "/panes/reopen");

    it("reports nothing to reopen when the stack is empty", async () => {
      await seedTab(WS);
      const res = await call(route, deps, { body: { workspacePath: WS } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reopened: false });
    });

    it("reopens the most recently closed pane and names it", async () => {
      const { tabId, paneId } = await seedTab(WS);
      await seedTab(WS); // a second tab, so closing the first doesn't empty the panel
      await store.apply(
        WS,
        { type: "close-tab", tabId },
        { kind: "route", id: "test" },
      );

      const res = await call(route, deps, { body: { workspacePath: WS } });
      expect(res.status).toBe(200);
      expect(res.body.reopened).toBe(true);
      expect(res.body.paneId).toBe(paneId);
    });
  });

  describe("DELETE /panes/:paneId", () => {
    const route = findRoute(paneRoutes, "DELETE", "/panes/:paneId");

    it("closes an existing pane", async () => {
      const { paneId } = await seedTab(WS);
      const res = await call(route, deps, {
        params: { paneId },
        body: { workspacePath: WS },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const entry = store.get(WS)!;
      const panel = entry.layout.panels[Object.keys(entry.layout.panels)[0]];
      expect(panel.tabs.some((t) => t.rootNode.type === "leaf" && t.rootNode.paneId === paneId)).toBe(false);
    });

    it("400s on an unknown paneId", async () => {
      const res = await call(route, deps, {
        params: { paneId: "no-such-pane" },
        body: { workspacePath: WS },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /tabs", () => {
    const route = findRoute(tabRoutes, "POST", "/tabs");

    it("creates a terminal tab in the given workspace", async () => {
      const res = await call(route, deps, {
        body: { contentType: "terminal", workspacePath: WS },
      });
      expect(res.status).toBe(200);
      expect(res.body.tabId).toEqual(expect.any(String));
      expect(res.body.paneId).toEqual(expect.any(String));

      const entry = store.get(WS)!;
      const panel = entry.layout.panels[Object.keys(entry.layout.panels)[0]];
      expect(panel.tabs.map((t) => t.id)).toContain(res.body.tabId);
    });

    it("falls back to the last-active workspace when none is given", async () => {
      await seedTab(WS); // sets lastActiveWorkspacePath
      const res = await call(route, deps, { body: { contentType: "terminal" } });
      expect(res.status).toBe(200);
      const entry = store.get(WS)!;
      const panel = entry.layout.panels[Object.keys(entry.layout.panels)[0]];
      expect(panel.tabs.map((t) => t.id)).toContain(res.body.tabId);
    });

    it("400s naming the option when nothing resolves a workspace", async () => {
      const res = await call(route, deps, { body: { contentType: "terminal" } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/workspacePath/);
    });

    it("400s when a browser tab has no url", async () => {
      const res = await call(route, deps, {
        body: { contentType: "browser", workspacePath: WS },
      });
      expect(res.status).toBe(400);
    });

    /**
     * `command` is why this route could not be trusted between ticket 5 and
     * ticket 11: it was validated and then dropped, because the only place to
     * put it was the *sending renderer's* map and a route has no renderer.
     */
    it("queues a command for the pane the tab minted", async () => {
      const res = await call(route, deps, {
        body: {
          contentType: "terminal",
          workspacePath: WS,
          command: "echo hello",
        },
      });

      expect(res.status).toBe(200);
      expect(store.pendingCommands.take(res.body.paneId)).toEqual({
        text: "echo hello",
        kind: "shell",
      });
    });

    it("queues nothing when no command is given", async () => {
      const res = await call(route, deps, {
        body: { contentType: "terminal", workspacePath: WS },
      });

      expect(res.status).toBe(200);
      expect(store.pendingCommands.take(res.body.paneId)).toBeNull();
    });

    it("400s a command on a browser tab, and queues nothing", async () => {
      const res = await call(route, deps, {
        body: {
          contentType: "browser",
          url: "https://example.com",
          workspacePath: WS,
          command: "echo hello",
        },
      });

      expect(res.status).toBe(400);
      expect(store.pendingCommands.size).toBe(0);
    });
  });

  describe("POST /tabs/diff", () => {
    const route = findRoute(tabRoutes, "POST", "/tabs/diff");

    it("creates a diff tab, then returns the same one on a second call", async () => {
      await seedTab(WS);
      const first = await call(route, deps, { body: { workspacePath: WS } });
      expect(first.status).toBe(200);

      const second = await call(route, deps, { body: { workspacePath: WS } });
      expect(second.status).toBe(200);
      expect(second.body.tabId).toBe(first.body.tabId);
    });
  });

  describe("POST /tabs/:tabId/pin", () => {
    const route = findRoute(tabRoutes, "POST", "/tabs/:tabId/pin");

    it("pins then unpins a tab, reporting the new state", async () => {
      const { tabId } = await seedTab(WS);
      const pinned = await call(route, deps, {
        params: { tabId },
        body: { workspacePath: WS },
      });
      expect(pinned.body).toEqual({ tabId, pinned: true });

      const unpinned = await call(route, deps, {
        params: { tabId },
        body: { workspacePath: WS },
      });
      expect(unpinned.body).toEqual({ tabId, pinned: false });
    });

    it("400s on an unknown tabId", async () => {
      const res = await call(route, deps, {
        params: { tabId: "no-such-tab" },
        body: { workspacePath: WS },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /tabs/:tabId/duplicate", () => {
    const route = findRoute(tabRoutes, "POST", "/tabs/:tabId/duplicate");

    it("mints a new tab id distinct from the source", async () => {
      const { tabId } = await seedTab(WS);
      const res = await call(route, deps, {
        params: { tabId },
        body: { workspacePath: WS },
      });
      expect(res.status).toBe(200);
      expect(res.body.tabId).toEqual(expect.any(String));
      expect(res.body.tabId).not.toBe(tabId);
    });
  });

  describe("workspace resolution order", () => {
    const route = findRoute(paneRoutes, "POST", "/panes/:paneId/title");

    it("prefers body.workspacePath over the pane's own workspace", async () => {
      const { paneId } = await seedTab(WS);
      // The pane only exists in WS — an explicit, wrong workspacePath 400s
      // rather than silently searching elsewhere.
      const res = await call(route, deps, {
        params: { paneId },
        body: { title: "hello", workspacePath: OTHER_WS },
      });
      expect(res.status).toBe(400);
    });

    it("finds the workspace holding the named pane when workspacePath is omitted", async () => {
      const { paneId } = await seedTab(WS);
      const res = await call(route, deps, {
        params: { paneId },
        body: { title: "hello" },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("viewport routes still proxy to the renderer", () => {
    it("POST /panes/focus-next", async () => {
      const route = findRoute(paneRoutes, "POST", "/panes/focus-next");
      await call(route, deps, {});
      expect(proxyToRenderer).toHaveBeenCalledWith(expect.any(Function), "focus-next-pane");
    });

    it("POST /panes/:paneId/focus", async () => {
      const route = findRoute(paneRoutes, "POST", "/panes/:paneId/focus");
      await call(route, deps, { params: { paneId: "pane-1" } });
      expect(proxyToRenderer).toHaveBeenCalledWith(
        expect.any(Function),
        "focus-pane",
        { paneId: "pane-1" },
      );
    });

    it("POST /workspaces/active", async () => {
      const route = findRoute(tabRoutes, "POST", "/workspaces/active");
      await call(route, deps, { body: { workspacePath: WS } });
      expect(proxyToRenderer).toHaveBeenCalledWith(
        expect.any(Function),
        "set-active-workspace",
        { workspacePath: WS },
      );
    });

    it("POST /tabs/:tabId/select", async () => {
      const route = findRoute(tabRoutes, "POST", "/tabs/:tabId/select");
      await call(route, deps, { params: { tabId: "tab-1" } });
      expect(proxyToRenderer).toHaveBeenCalledWith(
        expect.any(Function),
        "select-tab",
        { tabId: "tab-1" },
      );
    });
  });

  describe("GET /panes", () => {
    const route = findRoute(paneRoutes, "GET", "/panes");

    it("renders a snapshot without a window, focus fields null", async () => {
      await seedTab(WS);
      const res = await call(route, deps, { query: `?workspacePath=${encodeURIComponent(WS)}` });
      expect(res.status).toBe(200);
      expect(res.body.workspacePath).toBe(WS);
      expect(res.body.activeTabId).toBeNull();
      expect(res.body.focusedPaneId).toBeNull();
      expect(res.body.tabs).toHaveLength(1);
    });

    it("names the active tab and focused pane once a window has reported a viewport", async () => {
      const { tabId, paneId } = await seedTab(WS);
      const entry = store.get(WS)!;
      const panelId = Object.keys(entry.layout.panels)[0];
      store.reportViewport(
        WS,
        { kind: "window", id: "win-1" },
        {
          activePanelId: panelId,
          selectedTabIds: { [panelId]: tabId },
          focusedPaneIds: { [tabId]: paneId },
        },
      );

      const res = await call(route, deps, { query: `?workspacePath=${encodeURIComponent(WS)}` });
      expect(res.body.activeTabId).toBe(tabId);
      expect(res.body.focusedPaneId).toBe(paneId);
    });

    it("400s when no workspace resolves", async () => {
      const res = await call(route, deps, {});
      expect(res.status).toBe(400);
    });
  });
});
