/**
 * The desktop as a client of a host server (ADR-227 D4), against a real host
 * server in this process (`useHostServerHarness`): a desktop that has handed
 * `box` its records reads them back through `box`'s proxy — merged into its
 * project list under its own groups — routes calls for them there, and is
 * refused while `box` is away.
 */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  eventually,
  hook,
  openOwnerStream,
  useHostServerHarness,
  withoutGit,
  type HostServerHarness,
} from "../../host-server/__tests__/harness";
import {
  BOX_APP,
  BOX_WT,
  openDesktop,
  seedDesktop,
} from "../../backend/__tests__/adoption-fixtures";
import { HostProxy } from "../../backend/host-proxy";
import { HostServerClient } from "../../backend/host-server-client";
import { ProjectManager } from "../../projects/project-manager";
import type { GitBackend } from "../../backend/types";
import { byAgent, byGhRepo, byHost, byPane, byProject, byWorkspaceKey, type Caller } from "../../bridge/method";
import { BridgeUnavailableRefusal } from "../../bridge/types";
import { PendingCommands } from "../../layout/pending-commands";
import { createBroadcastBus, type RendererBroadcast } from "../../renderer-broadcast";
import { createTab } from "../../../src/lib/layout/ids";
import type { LayoutBroadcast } from "../../../src/lib/layout/protocol";
import type { AgentInfo } from "../../agent-persistence";
import { HostRouting } from "../host-routing";
import type { WorkspaceKey } from "../../../src/lib/workspace-key";
import { handleServerControlRequest } from "../../routes/server-routes";
import type { ServerRouteDeps } from "../../routes/types";

const quiet = { info: () => {}, warn: () => {} };

const WINDOW: Caller = { id: "7", callerClass: "local" };

/**
 * One control request (MCP, the desktop's `manor` CLI) through the routes
 * the desktop's control server runs, over a desktop holding no agents of its
 * own. Resolves the answer.
 */
async function control(
  deps: Pick<ServerRouteDeps, "projectManager" | "hostRouting">,
  method: string,
  urlPath: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: unknown }> {
  let answer: { status: number; body: unknown } | undefined;
  const handled = await handleServerControlRequest(
    {
      ...deps,
      agentManager: {
        getAgentById: () => undefined,
        getAgentByPaneId: () => undefined,
        getActiveAgents: () => [],
        getAllAgents: () => [],
      },
      hostStatus: () => "connected",
      notifyProjectsChanged: () => {},
    } as unknown as ServerRouteDeps,
    method,
    new URL(urlPath, "http://desktop"),
    (status, b) => {
      answer ??= { status, body: b };
    },
    async () => body,
  );
  expect(handled).toBe(true);
  return answer!;
}

/** An owner channel that reads the token on every dial and retries at once. */
function ownerClient(h: HostServerHarness): HostServerClient {
  const client = new HostServerClient({
    hostId: "box",
    open: async () => {
      const token = fs.readFileSync(h.paths.ownerToken, "utf-8").trim();
      const socket = await openOwnerStream(h.paths.socket, token);
      socket.resume();
      return socket;
    },
    requestTimeoutMs: 3_000,
    retryDelayMs: () => 20,
    log: quiet,
  });
  onTestFinished(() => client.dispose());
  return client;
}

describe("HostRouting (ADR-227 D4)", () => {
  const h = useHostServerHarness();

  /**
   * A desktop that has handed `box` its records (D3), opened again the way a
   * launch would: its `ProjectManager` reading `box`'s through the proxy.
   */
  async function adoptedDesktop() {
    withoutGit();
    await h.serve();
    const client = ownerClient(h);
    client.hostConnected();
    const dir = path.join(h.tmp, "desktop");
    seedDesktop(dir);
    const before = openDesktop(dir);
    await eventually(() => client.state, (s) => s === "connected", "the owner channel");
    expect(await before.adoption.run("box", client)).toMatchObject({ sent: true });

    const bus = createBroadcastBus();
    const heard: RendererBroadcast[] = [];
    bus.subscribe((b) => heard.push(b));
    const pendingCommands = new PendingCommands();
    let projectManager: ProjectManager | null = null;
    const proxy = new HostProxy({
      client,
      bus,
      label: () => "me@box",
      republishAgents: true,
      cacheFile: path.join(h.tmp, "host-cache", "box.json"),
      saveDelayMs: 10,
      log: quiet,
    });
    onTestFinished(() => proxy.dispose());
    const routing = new HostRouting({
      registry: {
        hostProxy: (hostId) => (hostId === "box" ? proxy : undefined),
        remoteHostIds: () => ["box", "mac"],
        sessions: { ownerOf: () => undefined },
      },
      isAdopted: (hostId) => projectManager!.isHostAdopted(hostId),
      hasLocalProject: (id) => !projectManager!.isRemoteProject(id),
      pendingCommands,
      decorateProject: (result) => projectManager!.decorateRemoteResult(result),
      bus,
      handOver: async () => {},
    });
    const git = {
      exec: async () => {
        throw new Error("no git here");
      },
      worktreeList: async () => [],
    } as unknown as GitBackend;
    projectManager = new ProjectManager(git, dir, { remote: routing.remoteProjects() });
    await eventually(
      () => proxy.projects().map((p) => p.id).sort(),
      (ids) => ids.length === 2,
      "box's projects through the proxy",
    );
    return { client, proxy, routing, projectManager, pendingCommands, heard, before };
  }

  it("lists an adopted host's projects in their places, under the desktop's group", async () => {
    const { projectManager } = await adoptedDesktop();
    const projects = await projectManager.getProjects();
    // The sidebar is unchanged by the hand-over: same projects, same order.
    expect(projects.map((p) => [p.id, p.hostId])).toEqual([
      ["local-app", "local"],
      ["box-app", "box"],
      ["box-other", "box"],
      ["mac-app", "mac"],
    ]);
    const boxApp = projects.find((p) => p.id === "box-app")!;
    expect(boxApp.group?.id).toBe("g1");
    expect(boxApp.color).toBe("red");
    // The host's own record: what adoption handed over came back.
    expect(boxApp.folders.map((f) => f.name)).toEqual(["Later"]);
    // Paths and project ids on `box` route there.
    expect(projectManager.hostIdForPath(`${BOX_APP}/src`)).toBe("box");
    expect(projectManager.getProjectHostId("box-other")).toBe("box");
  });

  it("routes a call to the host that holds what it names", async () => {
    const { routing } = await adoptedDesktop();
    expect(routing.target(byProject(0), ["box-app"])).toBe("box");
    expect(routing.target(byProject(0), ["local-app"])).toBeNull();
    // `mac` has not been adopted: the desktop still answers for it.
    expect(routing.target(byProject(0), ["mac-app"])).toBeNull();
    expect(routing.target(byWorkspaceKey(0), [`box:${BOX_WT}`])).toBe("box");
    expect(routing.target(byWorkspaceKey(0), ["mac:/Users/me/mac-app"])).toBeNull();
    expect(routing.target(byWorkspaceKey(0), ["/Users/me/app"])).toBeNull();
    await eventually(() => routing.target(byPane(0), ["pane-box"]), Boolean, "box's layout");
    expect(routing.target(byPane(0), ["pane-box"])).toBe("box");
    expect(routing.target(byPane(0), ["pane-local"])).toBeNull();
    // A pane no layout holds yet stays here, with its queued command.
    expect(routing.target(byPane(0), ["pane-new"])).toBeNull();
  });

  it("routes gh calls by the repo's or the asked host", async () => {
    const { routing } = await adoptedDesktop();
    expect(routing.target(byGhRepo(0), [{ path: BOX_APP, hostId: "box" }])).toBe("box");
    expect(routing.target(byGhRepo(0), [{ path: "/Users/me/app", hostId: "local" }])).toBeNull();
    expect(routing.target(byGhRepo(0), [{ path: "/x", hostId: "mac" }])).toBeNull();
    expect(routing.target(byHost(0), ["box"])).toBe("box");
    expect(routing.target(byHost(0), [undefined])).toBeNull();
    expect(routing.target(byHost(0), ["local"])).toBeNull();
  });

  it("forwards a workspace write, and the desktop's list shows it", async () => {
    const { routing, projectManager } = await adoptedDesktop();
    // No git on this box: its main checkout is the one workspace it lists.
    await routing.invoke("box", "projects", "renameWorkspace", ["box-app", BOX_APP, "Renamed"], WINDOW);
    await eventually(
      async () =>
        (await projectManager.getProjects())
          .find((p) => p.id === "box-app")
          ?.workspaces.find((w) => w.path === BOX_APP)?.name,
      (name) => name === "Renamed",
      "the rename, back through the proxy",
    );
  });

  it("sends a layout command with its pane's queued command and the caller's origin", async () => {
    const { routing, pendingCommands, heard } = await adoptedDesktop();
    pendingCommands.set("pane-new", "echo hi", "shell");
    const tab = createTab(undefined, "pane-new");
    await routing.invoke(
      "box",
      "layout",
      "apply",
      [`box:${BOX_WT}`, { type: "new-tab", tab }],
      WINDOW,
    );
    // The command went with the pane, to the host that runs it.
    expect(pendingCommands.peek("pane-new")).toBeNull();
    const broadcast = await eventually(
      () =>
        heard
          .filter((b) => b.ns === "layout" && b.event === "changed")
          .map((b) => b.args[0] as LayoutBroadcast)
          .find((b) => b.workspacePath === `box:${BOX_WT}` && b.origin.id === WINDOW.id),
      Boolean,
      "the host's broadcast",
    );
    // The hint is the sending window's: the host recorded its origin.
    expect(broadcast!.origin).toEqual({ kind: "window", id: "7" });
    expect(routing.lastActiveWorkspace(null)).toBe(`box:${BOX_WT}`);
  });

  it("writes a group's shared settings through to its remote members", async () => {
    const { projectManager, proxy } = await adoptedDesktop();
    await projectManager.updateGroup("g1", { color: "blue" });
    await eventually(
      () => proxy.projects().find((p) => p.id === "box-app")?.color,
      (color) => color === "blue",
      "box's own copy of the group's color",
    );
    // And a project's own setting goes to its host.
    const updated = await projectManager.updateProject("box-other", { defaultRunCommand: "make" });
    expect(updated).toMatchObject({ id: "box-other", hostId: "box", defaultRunCommand: "make" });
  });

  it("lists the host's agents", async () => {
    const { routing } = await adoptedDesktop();
    await eventually(() => routing.agents().length, (n) => n === 2, "box's agents");
    expect(routing.agents().map((a) => [a.id, a.hostId]).sort()).toEqual([
      ["box-1", "box"],
      ["box-2", "box"],
    ]);
  });

  it("reads the host's agents as the host holds them after a status change", async () => {
    const { client, routing, heard } = await adoptedDesktop();
    await eventually(() => routing.agents().length, (n) => n === 2, "box's agents");

    // A hook on the box moves an agent: only the host's server hears it.
    h.daemon.emitHook(hook("SessionStart"));
    h.daemon.emitHook(hook("UserPromptSubmit"));
    h.daemon.emitHook(hook("Stop"));
    const asHostHasThem = async () =>
      (await (client.invoke("agents", "getAll", []) as Promise<AgentInfo[]>)).map((a) => ({ ...a, hostId: "box" }));
    await eventually(
      () => routing.agents().find((a) => a.agentSessionId === "sess-1")?.lastAgentStatus,
      (status) => status === "responded",
      "the desktop's copy of the agent responding",
    );

    // The desktop's merged read is the host's own, with the host's name on it.
    const byId = (a: AgentInfo, b: AgentInfo) => a.id.localeCompare(b.id);
    expect([...routing.agents()].sort(byId)).toEqual((await asHostHasThem()).sort(byId));
    // And it was heard here once, under the host's id, with its pane's status.
    const updates = heard
      .filter((b) => b.ns === "agents" && b.event === "updated")
      .map((b) => b.args[0] as AgentInfo)
      .filter((a) => a.agentSessionId === "sess-1");
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((a) => a.hostId === "box")).toBe(true);
    await eventually(
      () => routing.paneStatuses().find((u) => u.paneId === "pane-1")?.status,
      Boolean,
      "the pane's status",
    );
    expect(heard.some((b) => b.ns === "agents" && b.event === "status")).toBe(true);
  });

  it("sends a write by agent id to the host that holds the agent", async () => {
    const { routing, client } = await adoptedDesktop();
    await eventually(() => routing.agents().length, (n) => n === 2, "box's agents");
    expect(routing.target(byAgent(0), ["box-1"])).toBe("box");
    expect(routing.target(byAgent(0), ["desktop-agent"])).toBeNull();

    await routing.invoke("box", "agents", "update", ["box-1", { name: "Renamed" }], WINDOW);
    expect((await (client.invoke("agents", "getAll", []) as Promise<AgentInfo[]>)).find((a) => a.id === "box-1")?.name).toBe(
      "Renamed",
    );
    await eventually(
      () => routing.agents().find((a) => a.id === "box-1")?.name,
      (name) => name === "Renamed",
      "the rename, back through the proxy",
    );
  });

  it("sends the desktop's control requests for the host's projects there (ADR-227 D8)", async () => {
    const { routing, projectManager } = await adoptedDesktop();
    const deps = { projectManager, hostRouting: routing };
    const answered = await control(deps, "POST", "/projects/box-app/workspaces/rename", {
      workspacePath: BOX_APP,
      name: "Via MCP",
    });
    expect(answered).toEqual({ status: 200, body: { ok: true } });
    expect(
      (await projectManager.getProjects())
        .find((p) => p.id === "box-app")
        ?.workspaces.find((w) => w.path === BOX_APP)?.name,
    ).toBe("Via MCP");

    // A create picks its target here, then goes to that host for it.
    const sent = vi.spyOn(routing, "control");
    await control(deps, "POST", "/projects/box-app/workspaces", { name: "feature", host: "box" });
    expect(sent).toHaveBeenCalledWith("box", "POST", "/projects/box-app/workspaces", {
      name: "feature",
    });
    // A read the merged list has stays here.
    sent.mockClear();
    const workspaces = await control(deps, "GET", "/projects/box-app/workspaces");
    expect(workspaces.status).toBe(200);
    expect(sent).not.toHaveBeenCalled();
  });

  it("launches an agent in the host's workspace on the host's server", async () => {
    const { routing, projectManager, proxy } = await adoptedDesktop();
    const launched = await control(
      { projectManager, hostRouting: routing },
      "POST",
      "/agents",
      { workspacePath: BOX_APP, hostId: "box", prompt: "hi" },
    );
    expect(launched.status).toBe(200);
    const { paneId } = launched.body as { paneId: string };
    // The tab is in the host's layout, under the desktop's key for it.
    await eventually(
      () => JSON.stringify(proxy.layout()[`box:${BOX_APP}` as WorkspaceKey] ?? null),
      (layout) => layout.includes(paneId),
      "the agent's tab on box",
    );
  });

  it("sends an agent write by id to the host that holds the agent", async () => {
    const { routing, projectManager, client } = await adoptedDesktop();
    await eventually(() => routing.agents().length, (n) => n === 2, "box's agents");
    const deps = { projectManager, hostRouting: routing };
    expect(await control(deps, "POST", "/agents/box-1/seen")).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(await control(deps, "DELETE", "/agents/box-1")).toEqual({
      status: 200,
      body: { ok: true },
    });
    const left = (await (client.invoke("agents", "getAll", []) as Promise<AgentInfo[]>)).map((a) => a.id);
    expect(left).not.toContain("box-1");
  });

  it("refuses a write while the host is away, and reads from the cache", async () => {
    const { routing, projectManager, proxy } = await adoptedDesktop();
    await h.stop();
    await eventually(() => proxy.away, Boolean, "box away");
    const err = await routing
      .invoke("box", "projects", "renameWorkspace", ["box-app", BOX_WT, "x"], WINDOW)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeUnavailableRefusal);
    expect(err).toMatchObject({ code: "unavailable:host-away", message: "me@box is offline" });
    expect((await projectManager.getProjects()).map((p) => p.id)).toContain("box-app");
  });
});
