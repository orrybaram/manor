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
  const hosts = [
    { hostId: "box", spec: { kind: "ssh" as const, target: "me@box" } },
    { hostId: "mini", spec: { kind: "ssh" as const, target: "me@mini" } },
  ];
  return {
    getProjects: vi.fn(async () => projects),
    hosts,
    getHosts: vi.fn(() => hosts),
    hostLabel: (hostId: string) =>
      hostId === "local"
        ? "this Mac"
        : (hosts.find((h) => h.hostId === hostId)?.spec.target ?? hostId),
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
        { projectId: "local-app", name: "App", hostId: "local", host: "this Mac" },
        { projectId: "box-app", name: "App", hostId: "box", host: "me@box" },
      ],
    });
    expect(solo.group).toBeNull();
    expect((solo as unknown as { host: string }).host).toBe("this Mac");
  });

  it("shows a relayed caller only its own host's members", async () => {
    const res = await call(
      route("GET", "/projects"),
      deps(makeProjectManager(), "box"),
    );
    const [local] = res.body as Array<{
      group: {
        memberIds: string[];
        lastUsedHostId: string | null;
        members: Array<{ projectId: string }>;
      };
    }>;
    expect(local.group.memberIds).toEqual(["box-app"]);
    expect(local.group.members.map((m) => m.projectId)).toEqual(["box-app"]);
    expect(local.group.lastUsedHostId).toBe("box");
  });

  it("hides another host's last-used id from a relayed caller", async () => {
    const res = await call(
      route("GET", "/projects"),
      deps(makeProjectManager("local"), "box"),
    );
    const [local] = res.body as Array<{ group: { lastUsedHostId: string | null } }>;
    expect(local.group.lastUsedHostId).toBeNull();
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
    expect((res.body as { host: string }).host).toBe("me@box");
    // The project list `withProject` fetched is reused, not fetched again.
    expect(pm.getProjects).toHaveBeenCalledTimes(1);
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
      'Group "App" has no project on me@mini. Available hosts: this Mac, me@box.',
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

  it("errors on a host argument naming more than one host", async () => {
    pm.hosts.push({ hostId: "box2", spec: { kind: "ssh", target: "me@box" } });
    const res = await call(create, deps(pm), { projectId: "local-app" }, {
      name: "feat",
      host: "me@box",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain("more than one host");

    pm.hosts.splice(1, 2, { hostId: "mini", spec: { kind: "ssh", target: "box" } });
    const idVsTarget = await call(create, deps(pm), { projectId: "local-app" }, {
      name: "feat",
      host: "box",
    });
    expect(idVsTarget.status).toBe(400);
    expect(pm.createWorktree).not.toHaveBeenCalled();
  });

  it("answers a relayed caller the same for every other host, real or not", async () => {
    const answers = [];
    for (const host of ["local", "me@mini", "nowhere"]) {
      answers.push(
        await call(create, deps(pm, "box"), { projectId: "box-app" }, {
          name: "feat",
          host,
        }),
      );
    }
    expect(answers[0]).toEqual({
      status: 403,
      body: { error: "A remote host can only create workspaces on its own host." },
    });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
    expect(pm.createWorktree).not.toHaveBeenCalled();
  });

  it("lets a relayed caller name its own host", async () => {
    await call(create, deps(pm, "box"), { projectId: "box-app" }, {
      name: "feat",
      host: "me@box",
    });
    expect(pm.createWorktree.mock.calls[0][0]).toBe("box-app");
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
      'Project "Solo" is on this Mac, not me@box, and isn\'t linked with a project there.',
    );
  });
});
