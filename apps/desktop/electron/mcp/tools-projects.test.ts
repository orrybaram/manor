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

describe("move_workspace_to_host", () => {
  const moveTo = (answer: Record<string, unknown>) =>
    fakeHttp({ post: async () => ({ sourceHost: "This machine", targetHost: "me@box", ...answer }) });
  const run = async (http: Http, args: Record<string, unknown> = {}) => {
    const result = await projectsModule.handlers.move_workspace_to_host(
      { worktreePath: "/Users/me/app-feature", host: "box", ...args },
      http,
    );
    return result.content[0].text!;
  };

  it("posts the path, host and keepSource, and prints where the workspace went", async () => {
    const http = moveTo({
      ok: true,
      targetPath: "/home/me/.manor/worktrees/app/feature",
      reused: false,
      sourceRemoved: true,
    });
    const out = await run(http, { keepSource: false });
    // Outside a Manor pane there is no caller's project: the route finds it by path.
    expect(http.calls[0].path).toMatch(/^\/context/);
    expect(http.calls.slice(1)).toEqual([
      {
        method: "POST",
        path: "/workspaces/move-to-host",
        body: { worktreePath: "/Users/me/app-feature", host: "box", keepSource: false },
      },
    ]);
    expect(out).toBe(
      [
        "Moved workspace to me@box: /home/me/.manor/worktrees/app/feature",
        "Removed /Users/me/app-feature from this machine; the branch is kept.",
      ].join("\n"),
    );
  });

  it("says when it reused the target's workspace and kept the source", async () => {
    const out = await run(
      moveTo({ ok: true, targetPath: "/home/me/feature", reused: true, sourceRemoved: false }),
    );
    expect(out).toContain("Moved workspace to me@box: /home/me/feature");
    expect(out).toContain("already had on this branch");
    expect(out).toContain("Kept /Users/me/app-feature on this machine.");
  });

  it("lists the dirty files of a refusal", async () => {
    const out = await run(
      moveTo({
        ok: false,
        refusals: [
          {
            code: "dirty",
            files: [
              { code: " M", path: "src/a.ts" },
              { code: "??", path: "notes.md" },
            ],
          },
          { code: "no-origin" },
        ],
      }),
    );
    expect(out).toBe(
      [
        "Can't move /Users/me/app-feature to me@box:",
        "  Commit or discard 2 changed files first:",
        "     M src/a.ts",
        "    ?? notes.md",
        "  The repository has no 'origin' remote to push the branch to.",
        "Nothing was changed.",
      ].join("\n"),
    );
  });

  it("says to set the project up on the host first when the set up needs input", async () => {
    const out = await run(
      moveTo({ ok: false, needsInput: { reason: "no-origin", repoUrl: null, targetDir: "~/app" } }),
    );
    expect(out).toMatch(/set the project up on me@box first/);
  });

  it("names the failed step and its host, and that the source is as it was", async () => {
    const out = await run(moveTo({ ok: false, step: "create", error: "branch not found" }));
    expect(out).toBe(
      [
        "Couldn't move /Users/me/app-feature: Creating the workspace on me@box failed: branch not found",
        "/Users/me/app-feature is still on this machine, as it was.",
      ].join("\n"),
    );
    const push = await run(moveTo({ ok: false, step: "push", error: "rejected" }));
    expect(push).toContain("Pushing the branch on this machine failed: rejected");
  });

  it("names the caller's own project when it has the workspace, as remove_workspace finds it", async () => {
    const answer = { ok: true, targetPath: "/t", reused: false, sourceRemoved: true };
    const ownsIt = fakeHttp({
      get: async (path) =>
        path.startsWith("/context")
          ? { projectId: "p-local" }
          : { id: "p-local", workspaces: [{ path: "/Users/me/app-feature" }] },
      post: async () => ({ sourceHost: "This machine", targetHost: "me@box", ...answer }),
    });
    await run(ownsIt);
    expect(ownsIt.calls[1]).toMatchObject({ method: "GET", path: "/projects/p-local" });
    expect(ownsIt.calls[2].body).toMatchObject({ projectId: "p-local" });

    const elsewhere = fakeHttp({
      get: async (path) =>
        path.startsWith("/context") ? { projectId: "p-other" } : { id: "p-other", workspaces: [] },
      post: async () => ({ sourceHost: "This machine", targetHost: "me@box", ...answer }),
    });
    await run(elsewhere);
    expect(elsewhere.calls[2].body).not.toHaveProperty("projectId");

    const explicit = fakeHttp({ post: async () => ({ sourceHost: "a", targetHost: "b", ...answer }) });
    await run(explicit, { projectId: "p-box" });
    expect(explicit.calls).toEqual([
      expect.objectContaining({ method: "POST", body: expect.objectContaining({ projectId: "p-box" }) }),
    ]);
  });

  it("says this machine mid-sentence and This machine to start one", async () => {
    const out = await run(
      fakeHttp({
        post: async () => ({
          sourceHost: "me@box",
          targetHost: "This machine",
          ok: false,
          refusals: [{ code: "target-dirty", files: [{ code: " M", path: "a.ts" }] }],
        }),
      }),
    );
    expect(out).toContain("Can't move /Users/me/app-feature to this machine:");
    expect(out).toContain("  This machine already has this branch checked out, with 1 changed file:");
  });
});
