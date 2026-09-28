import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../renderer-bridge", () => ({
  notifyProjectsChanged: vi.fn(),
  runSetupScript: vi.fn(),
  startAgent: vi.fn(),
}));

import { projectRoutes } from "./projects";
import type { ControlDeps, Route } from "./types";
import type { ProjectGroupInfo, ProjectInfo } from "../persistence";

function route(method: Route["method"], path: string): Route {
  const found = projectRoutes.find(
    (r) => r.method === method && r.path === path,
  );
  if (!found) throw new Error(`No route ${method} ${path}`);
  return found;
}

function project(
  id: string,
  hostId: string,
  group: ProjectGroupInfo | null = null,
): ProjectInfo {
  return {
    id,
    name: "App",
    path: `/${hostId}/app`,
    defaultBranch: "main",
    workspaces: [{ path: `/${hostId}/app`, branch: "main", isMain: true, name: null }],
    selectedWorkspaceIndex: 0,
    defaultRunCommand: null,
    worktreePath: null,
    worktreeStartScript: null,
    worktreeTeardownScript: null,
    linearAssociations: [],
    color: null,
    agentCommand: null,
    commands: [],
    themeName: null,
    setupComplete: true,
    portlessEnabled: true,
    hostId,
    folders: [],
    sidebarOrder: [],
    group,
  };
}

/**
 * Local and box members of group "App", plus an unlinked project on this
 * machine. `lastUsedHostId` is the box.
 */
function makeProjectManager(lastUsedHostId: string | null = "box") {
  const group: ProjectGroupInfo = {
    id: "g1",
    name: "App",
    memberIds: ["local-app", "box-app"],
    lastUsedHostId,
  };
  const projects = [
    project("local-app", "local", group),
    project("box-app", "box", group),
    { ...project("solo", "local"), name: "Solo" },
  ];
  return {
    getProjects: vi.fn(async () => projects),
    getHosts: vi.fn(() => [
      { hostId: "box", spec: { kind: "ssh" as const, target: "me@box" } },
      { hostId: "mini", spec: { kind: "ssh" as const, target: "me@mini" } },
    ]),
    createWorktree: vi.fn(async (projectId: string) =>
      projects.find((p) => p.id === projectId) ?? null,
    ),
  };
}

type Pm = ReturnType<typeof makeProjectManager>;

function deps(pm: Pm, callerHostId?: string): ControlDeps {
  return { projectManager: pm, callerHostId } as unknown as ControlDeps;
}

async function call(
  r: Route,
  d: ControlDeps,
  params: Record<string, string> = {},
  body: Record<string, unknown> = {},
) {
  const calls: Array<{ status: number; body: unknown }> = [];
  await r.handler({
    deps: d,
    params,
    url: new URL("http://localhost/"),
    json: (status, b) => calls.push({ status, body: b }),
    readBody: async () => body,
  });
  expect(calls).toHaveLength(1);
  return calls[0];
}

describe("GET /projects", () => {
  it("lists each group's members with their hosts", async () => {
    const res = await call(route("GET", "/projects"), deps(makeProjectManager()));
    expect(res.status).toBe(200);
    const [local, , solo] = res.body as Array<ProjectInfo & { group: unknown }>;
    expect(local.group).toEqual({
      id: "g1",
      name: "App",
      memberIds: ["local-app", "box-app"],
      lastUsedHostId: "box",
      members: [
        { projectId: "local-app", name: "App", hostId: "local", host: "local" },
        { projectId: "box-app", name: "App", hostId: "box", host: "me@box" },
      ],
    });
    expect(solo.group).toBeNull();
  });

  it("shows a relayed caller only its own host's members", async () => {
    const res = await call(
      route("GET", "/projects"),
      deps(makeProjectManager(), "box"),
    );
    const [local] = res.body as Array<{
      group: { memberIds: string[]; members: Array<{ projectId: string }> };
    }>;
    expect(local.group.memberIds).toEqual(["box-app"]);
    expect(local.group.members.map((m) => m.projectId)).toEqual(["box-app"]);
  });
});

describe("POST /projects/:projectId/workspaces", () => {
  const create = route("POST", "/projects/:projectId/workspaces");
  let pm: Pm;
  beforeEach(() => {
    pm = makeProjectManager();
  });

  it("creates in the member on the named host", async () => {
    const res = await call(create, deps(pm), { projectId: "local-app" }, {
      name: "feat",
      host: "box",
    });
    expect(res.status).toBe(200);
    expect(pm.createWorktree.mock.calls[0][0]).toBe("box-app");
  });

  it("accepts the local host id", async () => {
    await call(create, deps(pm), { projectId: "box-app" }, {
      name: "feat",
      host: "local",
    });
    expect(pm.createWorktree.mock.calls[0][0]).toBe("local-app");
  });

  it("defaults to a relayed caller's own host over the last-used host", async () => {
    pm = makeProjectManager("local");
    await call(create, deps(pm, "box"), { projectId: "box-app" }, { name: "feat" });
    expect(pm.createWorktree.mock.calls[0][0]).toBe("box-app");
  });

  it("defaults to the group's last-used host for a local caller", async () => {
    await call(create, deps(pm), { projectId: "local-app" }, { name: "feat" });
    expect(pm.createWorktree.mock.calls[0][0]).toBe("box-app");
  });

  it("falls back to the named project when the group has no last-used host", async () => {
    pm = makeProjectManager(null);
    await call(create, deps(pm), { projectId: "local-app" }, { name: "feat" });
    expect(pm.createWorktree.mock.calls[0][0]).toBe("local-app");
  });

  it("accepts a host's ssh target as well as its id", async () => {
    await call(create, deps(pm), { projectId: "local-app" }, {
      name: "feat",
      host: "me@box",
    });
    expect(pm.createWorktree.mock.calls[0][0]).toBe("box-app");
  });

  it("errors clearly on a host the group has no member on", async () => {
    const res = await call(create, deps(pm), { projectId: "local-app" }, {
      name: "feat",
      host: "me@mini",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      'Group "App" has no project on me@mini. Available hosts: local, me@box.',
    );
    expect(pm.createWorktree).not.toHaveBeenCalled();
  });

  it("errors on an unknown host", async () => {
    const res = await call(create, deps(pm), { projectId: "local-app" }, {
      name: "feat",
      host: "nowhere",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("Unknown host 'nowhere'");
  });

  it("refuses a relayed caller naming another host", async () => {
    const res = await call(create, deps(pm, "box"), { projectId: "box-app" }, {
      name: "feat",
      host: "local",
    });
    expect(res.status).toBe(403);
    expect(pm.createWorktree).not.toHaveBeenCalled();
  });

  it("creates an unlinked project in itself, and refuses another host for it", async () => {
    await call(create, deps(pm), { projectId: "solo" }, { name: "feat" });
    expect(pm.createWorktree.mock.calls[0][0]).toBe("solo");

    const res = await call(create, deps(pm), { projectId: "solo" }, {
      name: "feat",
      host: "box",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe(
      'Project "Solo" is on local, not me@box, and isn\'t linked with a project there.',
    );
  });
});
