/**
 * `POST /workspaces/move-to-host` — the CLI's and MCP's
 * `move_workspace_to_host` — finds the project from the workspace's path and
 * the host from an id, ssh target or label, then runs the same move the
 * sidebar does. It is the desktop's alone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const runWorkspaceMove = vi.fn();
vi.mock("../bridge/handlers/projects", () => ({
  runWorkspaceMove: (...args: unknown[]) => runWorkspaceMove(...args),
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "/tmp" },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { LOCAL_HOST_ID } from "../backend/types";
import { workspaceMoveRoutes } from "./projects";
import { routes } from "./index";
import { serverRoutes } from "./server-routes";
import type { RouteContext, ServerRouteDeps } from "./types";

const route = workspaceMoveRoutes[0];

const projects = [
  {
    id: "p-local",
    name: "app",
    hostId: LOCAL_HOST_ID,
    workspaces: [{ path: "/Users/me/app" }, { path: "/Users/me/app-feature" }],
  },
  {
    id: "p-box",
    name: "app",
    hostId: "box",
    workspaces: [{ path: "/home/me/app" }, { path: "/srv/shared" }],
  },
  {
    id: "p-pod",
    name: "app",
    hostId: "pod",
    workspaces: [{ path: "/srv/shared" }],
  },
];

const deps = {
  projectManager: {
    getProjects: vi.fn(async () => projects),
    getHosts: () => [
      { hostId: "box", spec: { kind: "ssh", target: "me@box" } },
      { hostId: "pod", spec: { kind: "ssh", target: "me@pod" } },
    ],
    hostLabel: (hostId: string) =>
      hostId === LOCAL_HOST_ID ? "this Mac" : hostId === "box" ? "me@box" : "me@pod",
  },
} as unknown as ServerRouteDeps;

async function post(body: Record<string, unknown>) {
  const json = vi.fn();
  const ctx = {
    deps,
    method: "POST",
    params: {},
    url: new URL("http://x/workspaces/move-to-host"),
    json,
    readBody: async () => body,
  } as unknown as RouteContext<ServerRouteDeps>;
  await route.handler(ctx);
  const [status, answer] = json.mock.calls[0];
  return { status, answer };
}

const moved = {
  ok: true,
  targetProjectId: "p-box",
  targetPath: "/home/me/.manor/worktrees/app/feature",
  targetWorkspaceKey: "box:/home/me/.manor/worktrees/app/feature",
  reused: false,
  sourceRemoved: true,
};

describe("POST /workspaces/move-to-host", () => {
  beforeEach(() => {
    runWorkspaceMove.mockReset();
    runWorkspaceMove.mockResolvedValue(moved);
  });

  it("is in the desktop's table and not a host server's", () => {
    expect(route).toMatchObject({ method: "POST", path: "/workspaces/move-to-host" });
    expect(routes).toContain(route);
    expect(serverRoutes).not.toContain(route);
  });

  it("finds the project by the workspace's path and the host by its ssh target", async () => {
    const { status, answer } = await post({
      worktreePath: "/Users/me/app-feature",
      host: "me@box",
    });
    expect(runWorkspaceMove).toHaveBeenCalledWith(deps, {
      projectId: "p-local",
      path: "/Users/me/app-feature",
      targetHostId: "box",
      keepSource: false,
    });
    expect(status).toBe(200);
    expect(answer).toEqual({
      ...moved,
      sourceHost: "this Mac",
      targetHostId: "box",
      targetHost: "me@box",
    });
  });

  it("takes a host id, 'local', and keepSource", async () => {
    await post({ worktreePath: "/home/me/app", host: LOCAL_HOST_ID, keepSource: true });
    expect(runWorkspaceMove).toHaveBeenCalledWith(deps, {
      projectId: "p-box",
      path: "/home/me/app",
      targetHostId: LOCAL_HOST_ID,
      keepSource: true,
    });
  });

  it("answers a refusal as the move's answer, not an HTTP error", async () => {
    runWorkspaceMove.mockResolvedValue({
      ok: false,
      refusals: [{ code: "dirty", files: [{ code: " M", path: "a.ts" }] }],
    });
    const { status, answer } = await post({ worktreePath: "/Users/me/app-feature", host: "box" });
    expect(status).toBe(200);
    expect(answer).toMatchObject({ ok: false, refusals: [{ code: "dirty" }], targetHost: "me@box" });
  });

  it("404s a path no project has", async () => {
    const { status, answer } = await post({ worktreePath: "/nowhere", host: "box" });
    expect(status).toBe(404);
    expect(answer.error).toContain("/nowhere");
    expect(runWorkspaceMove).not.toHaveBeenCalled();
  });

  it("asks for projectId when two hosts have a workspace at the path", async () => {
    const { status, answer } = await post({ worktreePath: "/srv/shared", host: "local" });
    expect(status).toBe(400);
    expect(answer.error).toMatch(/p-box.*p-pod.*projectId/);
    expect(runWorkspaceMove).not.toHaveBeenCalled();

    await post({ worktreePath: "/srv/shared", host: "local", projectId: "p-pod" });
    expect(runWorkspaceMove).toHaveBeenCalledWith(deps, expect.objectContaining({ projectId: "p-pod" }));
  });

  it("refuses an unknown host and a bad body", async () => {
    expect(await post({ worktreePath: "/Users/me/app-feature", host: "nope" })).toMatchObject({
      status: 400,
      answer: { error: "Unknown host 'nope'." },
    });
    expect((await post({ host: "box" })).status).toBe(400);
    expect((await post({ worktreePath: "/Users/me/app-feature" })).status).toBe(400);
    expect(
      (await post({ worktreePath: "/Users/me/app-feature", host: "box", keepSource: "yes" })).status,
    ).toBe(400);
    expect(runWorkspaceMove).not.toHaveBeenCalled();
  });
});
