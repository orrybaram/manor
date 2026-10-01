import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../renderer-bridge", () => ({
  proxyToRenderer: vi.fn(async () => {}),
}));

import { proxyToRenderer } from "../renderer-bridge";
import { withWorkspaceHost } from "./workspace-host";
import { OWN_HOST_ONLY } from "./caller-host";
import { agentRoutes } from "./agents";
import { tabRoutes, workspaceRoutes } from "./panes";
import type { ControlDeps, Route } from "./types";
import { LayoutStore } from "../layout/layout-store";
import { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { LayoutStoreBackend } from "../layout/layout-store";

// ADR-191: main names the host of the workspace an app-command targets.
const projectManager = {
  hostIdForPath: (p: string) => (p.startsWith("/srv/") ? "box" : "local"),
} as unknown as ControlDeps["projectManager"];

describe("withWorkspaceHost", () => {
  it("names the host of the project that owns the path", () => {
    expect(withWorkspaceHost({ projectManager }, { workspacePath: "/srv/app" })).toEqual({
      ok: true,
      body: { workspacePath: "/srv/app", hostId: "box" },
    });
  });

  it("keeps a host a local caller named", () => {
    const body = { workspacePath: "/srv/app", hostId: "local" };
    expect(withWorkspaceHost({ projectManager }, body)).toEqual({ ok: true, body });
  });

  it("names the relaying host for a request from a remote manor CLI", () => {
    expect(
      withWorkspaceHost({ projectManager, callerHostId: "box" }, { workspacePath: "/home/a" }),
    ).toEqual({ ok: true, body: { workspacePath: "/home/a", hostId: "box" } });
  });

  it("leaves a body with no workspace alone", () => {
    const body = { contentType: "terminal" };
    expect(withWorkspaceHost({ projectManager }, body)).toEqual({ ok: true, body });
  });
});

/**
 * ADR-189: a relayed caller acts on its own host only. A box that names
 * another host — to start an agent in the laptop's workspace at a path both
 * share, say — gets the generic 403, and the command never reaches the
 * renderer.
 */
describe("relayed workspace commands", () => {
  const SHARED = "/home/me/app";
  const relayed = { projectManager, callerHostId: "box" } as unknown as ControlDeps;

  function route(routes: Route[], path: string): Route {
    const found = routes.find((r) => r.method === "POST" && r.path === path);
    if (!found) throw new Error(`no POST ${path}`);
    return found;
  }

  async function post(r: Route, deps: ControlDeps, body: Record<string, unknown>) {
    const json = vi.fn();
    await r.handler({ deps, params: {}, url: new URL("http://x/"), json, readBody: async () => body });
    return (json.mock.calls[0] ?? []) as [number?, unknown?];
  }

  // Viewport commands still go to the primary window (ADR-179 D5).
  const cases: Array<[string, Route, string, Record<string, unknown>]> = [
    ["/workspaces/active", route(workspaceRoutes, "/workspaces/active"), "set-active-workspace", {}],
  ];

  beforeEach(() => vi.mocked(proxyToRenderer).mockClear());

  describe.each(cases)("POST %s", (_path, r, cmd, extra) => {
    it("refuses a relayed caller that names another host", async () => {
      const [status, body] = await post(r, relayed, {
        ...extra,
        workspacePath: SHARED,
        hostId: "local",
      });

      expect(status).toBe(403);
      expect(body).toEqual({ error: OWN_HOST_ONLY });
      expect(proxyToRenderer).not.toHaveBeenCalled();
    });

    it("sends a relayed caller's command to its own host", async () => {
      await post(r, relayed, { ...extra, workspacePath: SHARED });

      expect(proxyToRenderer).toHaveBeenCalledWith(
        expect.any(Function),
        cmd,
        expect.objectContaining({ workspacePath: SHARED, hostId: "box" }),
      );
    });

    it("lets a relayed caller name its own host", async () => {
      await post(r, relayed, { ...extra, workspacePath: SHARED, hostId: "box" });

      expect(proxyToRenderer).toHaveBeenCalledWith(
        expect.any(Function),
        cmd,
        expect.objectContaining({ hostId: "box" }),
      );
    });
  });
});

/**
 * The structural launches run on the server's layout store (ADR-179), keyed
 * by host plus path (ADR-191): a relayed caller's tab lands in its own
 * host's layout, and naming another host is the same 403.
 */
describe("relayed structural workspace commands", () => {
  const SHARED = "/home/me/app";
  let tmpDir: string;
  let store: LayoutStore;
  let relayed: ControlDeps;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-ws-host-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    store = new LayoutStore(
      new LayoutPersistence(path.join(tmpDir, "layout.json")),
      () => {},
      { pty: { kill: vi.fn().mockResolvedValue(undefined) } } as unknown as LayoutStoreBackend,
    );
    relayed = {
      projectManager: { ...projectManager, getProjects: async () => [] },
      callerHostId: "box",
      layoutStore: store,
    } as unknown as ControlDeps;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function route(routes: Route[], p: string): Route {
    const found = routes.find((r) => r.method === "POST" && r.path === p);
    if (!found) throw new Error(`no POST ${p}`);
    return found;
  }

  async function post(r: Route, body: Record<string, unknown>) {
    const json = vi.fn();
    await r.handler({ deps: relayed, params: {}, url: new URL("http://x/"), json, readBody: async () => body });
    return (json.mock.calls[0] ?? []) as [number?, unknown?];
  }

  const cases: Array<[string, Route, Record<string, unknown>]> = [
    ["/agents", route(agentRoutes, "/agents"), { prompt: "hi" }],
    ["/tabs", route(tabRoutes, "/tabs"), { contentType: "terminal" }],
  ];

  describe.each(cases)("POST %s", (_path, r, extra) => {
    it("refuses a relayed caller that names another host", async () => {
      const [status, body] = await post(r, { ...extra, workspacePath: SHARED, hostId: "local" });

      expect(status).toBe(403);
      expect(body).toEqual({ error: OWN_HOST_ONLY });
      expect(store.getAll()).toEqual({});
    });

    it("opens the tab in the caller's own host's layout", async () => {
      const [status] = await post(r, { ...extra, workspacePath: SHARED });

      expect(status).toBe(200);
      expect(Object.keys(store.getAll())).toEqual([`box:${SHARED}`]);
    });
  });
});
