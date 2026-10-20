import { describe, it, expect } from "vitest";
import { projectsModule } from "./tools-projects";
import type { Http } from "./types";

/** A ~6-line fake `Http` that records every call and returns canned responses. */
function fakeHttp(overrides: Partial<Http> = {}): Http & {
  calls: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }>;
} {
  const calls: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }> = [];
  return {
    calls,
    get: async (path) => {
      calls.push({ method: "GET", path });
      if (overrides.get) return overrides.get(path);
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path, body) => {
      calls.push({ method: "POST", path, body });
      if (overrides.post) return overrides.post(path, body);
      return {};
    },
    del: async (path, body) => {
      calls.push({ method: "DEL", path, body });
      if (overrides.del) return overrides.del(path, body);
      return {};
    },
  };
}

describe("create_folder", () => {
  it("resolves the caller's project when projectId is omitted", async () => {
    const http = fakeHttp({
      get: async () => ({ projectId: "p1" }),
      post: async () => ({ id: "f1", name: "Feature Work" }),
    });

    const result = await projectsModule.handlers.create_folder(
      { name: "Feature Work" },
      http,
    );

    expect(http.calls[0]).toMatchObject({ method: "GET" });
    expect(http.calls[0].path).toMatch(/^\/context/);
    expect(http.calls[1]).toMatchObject({
      method: "POST",
      path: "/projects/p1/folders",
      body: { name: "Feature Work" },
    });
    expect(result.content[0].text).toContain("Feature Work");
    expect(result.content[0].text).toContain("f1");
  });

  it("an explicit args.projectId wins and /context is not called", async () => {
    const http = fakeHttp({
      post: async () => ({ id: "f2", name: "Bugs" }),
    });

    await projectsModule.handlers.create_folder(
      { projectId: "explicit-project", name: "Bugs" },
      http,
    );

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({
      method: "POST",
      path: "/projects/explicit-project/folders",
      body: { name: "Bugs" },
    });
  });
});

describe("move_folder", () => {
  it("posts the parent to the folder's parent route", async () => {
    const http = fakeHttp();

    const result = await projectsModule.handlers.move_folder(
      { projectId: "p1", folderId: "f2", parentId: "f1" },
      http,
    );

    expect(http.calls).toEqual([
      {
        method: "POST",
        path: "/projects/p1/folders/f2/parent",
        body: { parentId: "f1" },
      },
    ]);
    expect(result.content[0].text).toContain("f1");
  });

  it("an omitted parentId moves the folder to the top level", async () => {
    const http = fakeHttp();

    const result = await projectsModule.handlers.move_folder(
      { projectId: "p1", folderId: "f2" },
      http,
    );

    expect(http.calls[0].body).toEqual({ parentId: null });
    expect(result.content[0].text).toContain("top level");
  });
});

describe("rename_workspace", () => {
  it("resolves the caller's workspace via GET /context when omitted", async () => {
    const http = fakeHttp({
      get: async () => ({ projectId: "p1", workspacePath: "/resolved/ws" }),
    });

    const result = await projectsModule.handlers.rename_workspace(
      { name: "New Name" },
      http,
    );

    // resolveProjectId and resolveWorkspacePath each hit /context independently
    // when both are omitted — no shared cache between them.
    expect(http.calls[0]).toMatchObject({ method: "GET" });
    expect(http.calls[1]).toMatchObject({ method: "GET" });
    expect(http.calls[2]).toMatchObject({
      method: "POST",
      path: "/projects/p1/workspaces/rename",
      body: { workspacePath: "/resolved/ws", name: "New Name" },
    });
    expect(result.content[0].text).toContain("/resolved/ws");
    expect(result.content[0].text).toContain("New Name");
  });

  it("explicit args.projectId and args.workspacePath both win over /context", async () => {
    const http = fakeHttp();

    await projectsModule.handlers.rename_workspace(
      {
        projectId: "explicit-project",
        workspacePath: "/explicit/ws",
        name: "Renamed",
      },
      http,
    );

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({
      method: "POST",
      path: "/projects/explicit-project/workspaces/rename",
      body: { workspacePath: "/explicit/ws", name: "Renamed" },
    });
  });
});

describe("list_projects", () => {
  const ws = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      path: `/w${i}`,
      branch: "b",
      isMain: i === 0,
      name: null,
    }));
  const group = {
    id: "g1",
    name: "App",
    lastUsedHostId: "box",
    memberIds: ["local-app", "box-app"],
    members: [
      { projectId: "local-app", name: "App", hostId: "local", host: "this Mac" },
      { projectId: "box-app", name: "App", hostId: "box", host: "me@box" },
    ],
  };

  it("lists a group once with a line per member and its host", async () => {
    const http = fakeHttp({
      get: async () => [
        { id: "local-app", name: "App", path: "/app", hostId: "local", workspaces: ws(2), group },
        { id: "solo", name: "Solo", path: "/solo", hostId: "mini", host: "me@mini", workspaces: ws(1), group: null },
        { id: "box-app", name: "App", path: "/home/me/app", hostId: "box", workspaces: ws(1), group },
      ],
    });

    const result = await projectsModule.handlers.list_projects({}, http);

    expect(result.content[0].text).toBe(
      [
        "group g1: App (last used: me@box)",
        "  local-app: App (/app) on this Mac — 2 workspace(s)",
        "  box-app: App (/home/me/app) on me@box — 1 workspace(s)",
        "solo: Solo (/solo) on me@mini — 1 workspace(s)",
      ].join("\n"),
    );
  });
});

describe("create_workspace", () => {
  it("passes --host through to the route", async () => {
    const http = fakeHttp({
      post: async () => ({ id: "box-app", name: "App", hostId: "box", host: "me@box", workspaces: [] }),
    });

    const result = await projectsModule.handlers.create_workspace(
      { projectId: "local-app", name: "feat", host: "box" },
      http,
    );

    expect(http.calls[0]).toMatchObject({
      method: "POST",
      path: "/projects/local-app/workspaces",
      body: { name: "feat", host: "box" },
    });
    expect(result.content[0].text).toContain('in project "App" (box-app on me@box)');
  });
});
