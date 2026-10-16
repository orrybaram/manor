/**
 * `HostProxy` (ADR-227 D4) against a real host server in this process
 * (`useHostServerHarness`), over the real `HostServerClient`: the host's
 * events republished into a desktop bus in the desktop's form, its
 * subscriptions surviving a server restart, and its last state served from
 * the cache while it is away.
 */

import { describe, expect, it, onTestFinished } from "vitest";
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
} from "./adoption-fixtures";
import { HostProxy, type HostProxyOptions } from "../host-proxy";
import { HostServerClient, HostServerUnavailableError } from "../host-server-client";
import { hostLayoutSnapshot } from "../host-server-sync";
import { createBroadcastBus, type RendererBroadcast } from "../../renderer-broadcast";
import type { AgentInfo } from "../../agent-persistence";
import type { ProjectInfo } from "../../projects/types";
import type { LayoutBroadcast, LayoutEntry } from "../../../src/lib/layout/protocol";

const quiet = { info: () => {}, warn: () => {} };

/**
 * An owner channel to the harness's server that, unlike `h.owner()`, reads
 * the owner token on every dial — a restarted server writes a new one — and
 * retries a dropped channel at once.
 */
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

/** A desktop bus, and every broadcast published into it. */
function desktopBus() {
  const bus = createBroadcastBus();
  const heard: RendererBroadcast[] = [];
  bus.subscribe((broadcast) => heard.push(broadcast));
  return { bus, heard };
}

function proxyFor(
  h: HostServerHarness,
  client: HostServerClient,
  bus: HostProxyOptions["bus"],
  extra: Partial<HostProxyOptions> = {},
): HostProxy {
  const proxy = new HostProxy({
    client,
    bus,
    label: () => "me@box",
    cacheFile: path.join(h.tmp, "host-cache", "box.json"),
    saveDelayMs: 10,
    log: quiet,
    ...extra,
  });
  onTestFinished(() => proxy.dispose());
  return proxy;
}

describe("HostProxy (ADR-227 D4)", () => {
  const h = useHostServerHarness();

  /** The host takes `box`'s records from a desktop, as ticket 6 runs it. */
  async function adoptFromDesktop(client: HostServerClient): Promise<void> {
    seedDesktop(path.join(h.tmp, "desktop"));
    const desktop = openDesktop(path.join(h.tmp, "desktop"));
    const outcome = await desktop.adoption.run("box", client);
    expect(outcome).toMatchObject({ ownership: "pending", sent: true });
  }

  it("republishes the host's events with keys rewritten and hostId stamped", async () => {
    withoutGit();
    await h.serve();
    const client = ownerClient(h);
    client.hostConnected();
    const { bus, heard } = desktopBus();
    const proxy = proxyFor(h, client, bus, { republishAgents: true });
    await proxy.ready;
    expect(proxy.projects()).toEqual([]);
    expect(proxy.layout()).toEqual({});

    await adoptFromDesktop(client);

    // ── events, in the desktop's form ──
    const layoutKeys = () =>
      heard
        .filter((b) => b.ns === "layout" && b.event === "changed")
        .map((b) => (b.args[0] as LayoutBroadcast).workspacePath)
        .sort();
    await eventually(layoutKeys, (keys) => keys.length === 2, "two layout.changed");
    expect(layoutKeys()).toEqual([`box:${BOX_APP}`, `box:${BOX_WT}`].sort());

    const agents = await eventually(
      () =>
        heard
          .filter((b) => b.ns === "agents" && b.event === "updated")
          .map((b) => b.args[0] as AgentInfo),
      (list) => list.length === 2,
      "two agents.updated",
    );
    expect(agents.map((a) => [a.id, a.hostId]).sort()).toEqual([
      ["box-1", "box"],
      ["box-2", "box"],
    ]);

    // `projects.changed` reaches the desktop once the projects are re-read.
    await eventually(
      () => proxy.projects().map((p) => p.id).sort(),
      (ids) => ids.length === 2,
      "the host's projects",
    );
    expect(heard.some((b) => b.ns === "projects" && b.event === "changed")).toBe(true);
    expect(proxy.projects().every((p) => p.hostId === "box")).toBe(true);
    expect(proxy.projects().find((p) => p.id === "box-app")?.path).toBe(BOX_APP);

    // ── the proxy's own reads ──
    await eventually(
      () => Object.keys(proxy.layout()).sort(),
      (keys) => keys.length === 2,
      "the layout re-read",
    );
    expect(Object.keys(proxy.layout()).sort()).toEqual([`box:${BOX_APP}`, `box:${BOX_WT}`].sort());
    expect(proxy.agents().map((a) => a.hostId)).toEqual(["box", "box"]);

    // ── calls: keys and hostIds in, the desktop's form out ──
    expect(
      Object.keys((await proxy.invoke("layout", "getAll", [])) as Record<string, LayoutEntry>).sort(),
    ).toEqual([`box:${BOX_APP}`, `box:${BOX_WT}`].sort());
    await proxy.invoke("projects", "renameWorkspace", ["box-app", `box:${BOX_APP}`, "Main"]);
    const projects = (await proxy.invoke("projects", "getAll", [])) as ProjectInfo[];
    const boxApp = projects.find((p) => p.id === "box-app");
    expect(boxApp?.hostId).toBe("box");
    expect(boxApp?.workspaces.find((w) => w.path === BOX_APP)?.name).toBe("Main");
  });

  it("forget() removes every workspace at the renderers, then lets go", async () => {
    withoutGit();
    await h.serve();
    const client = ownerClient(h);
    client.hostConnected();
    const { bus, heard } = desktopBus();
    const moved: Array<[string, unknown]> = [];
    const proxy = proxyFor(h, client, bus, {
      onLayoutMoved: (key, _before, after) => void moved.push([key, after]),
    });
    await proxy.ready;
    await adoptFromDesktop(client);
    await eventually(
      () => Object.keys(proxy.layout()).sort(),
      (keys) => keys.length === 2,
      "the layout re-read",
    );
    heard.length = 0;
    moved.length = 0;

    proxy.forget();

    const removed = heard
      .filter((b) => b.ns === "layout" && b.event === "changed")
      .map((b) => b.args[0] as LayoutBroadcast);
    expect(removed.map((b) => b.workspacePath).sort()).toEqual(
      [`box:${BOX_APP}`, `box:${BOX_WT}`].sort(),
    );
    expect(removed.every((b) => b.removed === true && b.claims.length === 0)).toBe(true);
    // Claims on its tabs are dropped the way a workspace the host removed drops them.
    expect(moved.map(([key, after]) => [key, after]).sort()).toEqual(
      [[`box:${BOX_APP}`, null], [`box:${BOX_WT}`, null]].sort(),
    );
    // Disposed: a second forget publishes nothing more.
    heard.length = 0;
    proxy.forget();
    expect(heard).toEqual([]);
  });

  it("does not republish agents unless asked", async () => {
    withoutGit();
    await h.serve();
    const client = ownerClient(h);
    client.hostConnected();
    const { bus, heard } = desktopBus();
    const proxy = proxyFor(h, client, bus);
    await proxy.ready;

    await adoptFromDesktop(client);
    await eventually(() => proxy.agents().length, (n) => n === 2, "the host's agents");
    expect(heard.some((b) => b.ns === "agents")).toBe(false);
  });

  it("resubscribes and reads a fresh snapshot after the server restarts", async () => {
    h.adopt();
    await h.serve();
    const client = ownerClient(h);
    client.hostConnected();
    const { bus, heard } = desktopBus();
    const proxy = proxyFor(h, client, bus);
    await proxy.ready;

    await h.stop();
    await eventually(() => proxy.away, Boolean, "the host away");
    heard.length = 0;

    await h.serve();
    await eventually(() => client.state, (s) => s === "connected", "the channel back");
    // The snapshot on reconnect tells the desktop to re-read.
    await eventually(
      () => heard.filter((b) => b.ns === "projects").length,
      (n) => n >= 1,
      "a snapshot after the reconnect",
    );
    heard.length = 0;

    // The new server was told what the client listens to: an adoption
    // resend publishes `projects.changed`, and the proxy hears it.
    await client.invoke("hostServer", "adopt", [
      {
        projects: [],
        agents: [],
        layout: hostLayoutSnapshot({}, null, "box", new Date().toISOString()),
      },
    ]);
    await eventually(
      () => heard.filter((b) => b.ns === "projects" && b.event === "changed").length,
      (n) => n >= 1,
      "projects.changed through the new channel",
    );
  });

  it("is synced once per connection, and says so for a box with no server", async () => {
    withoutGit();
    await h.serve();
    const client = ownerClient(h);
    client.hostConnected();
    const { bus } = desktopBus();
    const proxy = proxyFor(h, client, bus);
    await proxy.synced();

    await h.stop();
    await eventually(() => proxy.away, Boolean, "the host away");
    let synced = false;
    void proxy.synced().then(() => {
      synced = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(synced).toBe(false);

    await h.serve();
    await eventually(() => synced, Boolean, "synced after the reconnect");

    // A box without a host server has nothing to wait for.
    const bare = new HostServerClient({ hostId: "bare", open: null, log: quiet });
    onTestFinished(() => bare.dispose());
    bare.hostConnected();
    await proxyFor(h, bare, bus).synced();
  });

  it("hands each live agent update on with the agent as it was before", async () => {
    h.adopt();
    await h.serve();
    const client = ownerClient(h);
    client.hostConnected();
    const { bus, heard } = desktopBus();
    const seen: Array<{ status: string | null; was: string | null | undefined }> = [];
    const proxy = proxyFor(h, client, bus, {
      republishAgents: true,
      onAgentUpdate: (agent, _unseen, previous) =>
        seen.push({ status: agent.lastAgentStatus, was: previous?.lastAgentStatus }),
    });
    await proxy.ready;

    h.daemon.emitHook(hook("SessionStart"));
    h.daemon.emitHook(hook("UserPromptSubmit"));
    h.daemon.emitHook(hook("Stop"));
    await eventually(() => seen[seen.length - 1]?.status, (status) => status === "responded", "the Stop");

    expect(seen[0].was).toBeUndefined();
    expect(seen[seen.length - 1]).toEqual({ status: "responded", was: "thinking" });
    // The pane's status came along, and is held for the merged read.
    await eventually(
      () => proxy.paneStatuses().find((u) => u.paneId === "pane-1")?.status,
      (status) => status === "responded",
      "the pane's status",
    );
    expect(heard.some((b) => b.ns === "agents" && b.event === "status")).toBe(true);
  });

  it("serves the host's last state from the cache while it is away", async () => {
    withoutGit();
    await h.serve();
    const client = ownerClient(h);
    client.hostConnected();
    const { bus } = desktopBus();
    const proxy = proxyFor(h, client, bus);
    await proxy.ready;
    await adoptFromDesktop(client);
    await eventually(
      () => [proxy.projects().length, Object.keys(proxy.layout()).length, proxy.agents().length],
      ([p, l, a]) => p === 2 && l === 2 && a === 2,
      "the adopted state",
    );
    proxy.flush();

    await h.stop();
    await eventually(() => proxy.away, Boolean, "the host away");

    // The live proxy keeps what it had, and refuses writes by the host's alias.
    expect(proxy.projects().map((p) => p.id).sort()).toEqual(["box-app", "box-other"]);
    await expect(proxy.invoke("projects", "getAll", [])).rejects.toBeInstanceOf(
      HostServerUnavailableError,
    );
    await expect(proxy.invoke("projects", "getAll", [])).rejects.toThrow("me@box is offline");

    // A desktop that starts while the host is away reads the cache.
    const cold = new HostServerClient({ hostId: "box", open: null, log: quiet });
    onTestFinished(() => cold.dispose());
    const cached = proxyFor(h, cold, createBroadcastBus());
    expect(cached.away).toBe(true);
    expect(cached.projects().map((p) => [p.id, p.hostId]).sort()).toEqual([
      ["box-app", "box"],
      ["box-other", "box"],
    ]);
    expect(Object.keys(cached.layout()).sort()).toEqual([`box:${BOX_APP}`, `box:${BOX_WT}`].sort());
    expect(cached.agents().map((a) => [a.id, a.hostId]).sort()).toEqual([
      ["box-1", "box"],
      ["box-2", "box"],
    ]);
    // Bare paths and `local` on disk: the host's own form.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(h.tmp, "host-cache", "box.json"), "utf-8"),
    ) as { projects: ProjectInfo[]; layout: { workspaces: Record<string, unknown> } };
    expect(onDisk.projects.every((p) => p.hostId === "local")).toBe(true);
    expect(Object.keys(onDisk.layout.workspaces).sort()).toEqual([BOX_APP, BOX_WT].sort());
  });
});
