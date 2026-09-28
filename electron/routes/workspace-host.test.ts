import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../renderer-bridge", () => ({
  proxyToRenderer: vi.fn(async () => {}),
}));

import { proxyToRenderer } from "../renderer-bridge";
import { withWorkspaceHost } from "./workspace-host";
import { OWN_HOST_ONLY } from "./caller-host";
import { agentRoutes } from "./agents";
import { tabRoutes, workspaceRoutes } from "./panes";
import type { ControlDeps, Route } from "./types";

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

  const cases: Array<[string, Route, string, Record<string, unknown>]> = [
    ["/agents", route(agentRoutes, "/agents"), "start-agent", { prompt: "hi" }],
    ["/workspaces/active", route(workspaceRoutes, "/workspaces/active"), "set-active-workspace", {}],
    ["/tabs", route(tabRoutes, "/tabs"), "new-tab", {}],
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
