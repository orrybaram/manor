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
