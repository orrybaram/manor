/**
 * The desktop as a client of a host server (ADR-227 D4), against a real host
 * server in this process (`useHostServerHarness`): a desktop that has handed
 * `box` its records reads them back through `box`'s proxy — merged into its
 * project list under its own groups — routes calls for them there, and is
 * refused while `box` is away.
 */

import { describe, expect, it, onTestFinished } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  eventually,
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
import { byPane, byProject, byWorkspaceKey, type Caller } from "../../bridge/method";
import { BridgeUnavailableRefusal } from "../../bridge/types";
import { PendingCommands } from "../../layout/pending-commands";
import { createBroadcastBus, type RendererBroadcast } from "../../renderer-broadcast";
import { createTab } from "../../../src/lib/layout/ids";
import type { LayoutBroadcast } from "../../../src/lib/layout/protocol";
import { HostRouting } from "../host-routing";

const quiet = { info: () => {}, warn: () => {} };

const WINDOW: Caller = { id: "7", callerClass: "local" };

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
      hasLocalAgentSession: (sessionId) =>
        before.agentManager.getAgentBySessionId(sessionId) !== null,
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

  it("lists the host's agents the desktop holds no copy of", async () => {
    const { routing } = await adoptedDesktop();
    await eventually(() => routing.agents().length, (n) => n === 2, "box's agents");
    expect(routing.agents().map((a) => [a.id, a.hostId]).sort()).toEqual([
      ["box-1", "box"],
      ["box-2", "box"],
    ]);
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
