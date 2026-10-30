/**
 * `HostProxy` against a real host server in this process
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

describe("HostProxy", () => {
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

describe("HostProxy and the host's notification log", () => {
  const h = useHostServerHarness();

  it("holds the host's automation records only, stamped, and hears them change", async () => {
    withoutGit();
    h.adopt();
    const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    fs.writeFileSync(
      path.join(h.paths.dataDir, "notifications.json"),
      JSON.stringify({
        notifications: [
          // The host never writes one of these, and the desktop records its own.
          { id: "agent-1", kind: "agent-responded", title: "t", body: "", timestamp: at(1), read: false, target: null },
          {
            id: "ran-1",
            kind: "automation-ran",
            title: "Triage ran",
            body: "Started Claude",
            timestamp: at(2),
            read: false,
            target: { type: "automation", automationId: "auto-1" },
          },
        ],
      }),
    );
    const past = at(5);
    fs.writeFileSync(
      path.join(h.paths.dataDir, "automations.json"),
      JSON.stringify({
        automations: [
          {
            id: "auto-1",
            name: "Triage",
            enabled: false,
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            projectId: "gone",
            prompt: "go",
            agentKind: "claude",
            workspace: { mode: "new" },
            missedGraceMinutes: 720,
            createdAt: past,
            updatedAt: past,
            lastScheduledFor: past,
            nextRunAt: null,
          },
        ],
      }),
    );
    await h.serve();
    const client = ownerClient(h);
    client.hostConnected();
    let told = 0;
    const proxy = proxyFor(h, client, desktopBus().bus, { onNotificationsChanged: () => (told += 1) });

    const first = await eventually(() => proxy.notifications(), (list) => list.length > 0, "the host's log");
    expect(first.map((n) => [n.id, n.hostId])).toEqual([["ran-1", "box"]]);

    // A run fails on the host: its changed log reaches the proxy.
    await client.invoke("automations", "runNow", [null, "auto-1"]);
    const after = await eventually(() => proxy.notifications(), (list) => list.length === 2, "the new record");
    expect(after.map((n) => n.kind)).toEqual(["automation-failed", "automation-ran"]);
    expect(told).toBeGreaterThanOrEqual(2);
  });
});

describe("HostProxy and the host's usage stats", () => {
  const h = useHostServerHarness();

  it("hands over the host's own history on a snapshot and again when its stats change", async () => {
    withoutGit();
    h.adopt();
    fs.writeFileSync(
      path.join(h.paths.dataDir, "stats.json"),
      JSON.stringify({ version: 1, days: { "2026-10-30": { prompts: 4 } }, badges: {} }),
    );
    await h.serve();
    const client = ownerClient(h);
    client.hostConnected();
    const heard: unknown[] = [];
    proxyFor(h, client, desktopBus().bus, { onStatsHistory: (history) => heard.push(history) });

    await eventually(() => heard, (list) => list.length > 0, "the host's history");
    expect(heard[0]).toEqual({ days: { "2026-10-30": { prompts: 4 } }, badges: {}, onceAt: {} });

    // The host's stats move (here, cleared): its `stats.changed` brings a re-read.
    await client.invoke("stats", "reset", []);
    const after = await eventually(() => heard, (list) => list.length > 1, "the re-read");
    expect(after[after.length - 1]).toEqual({ days: {}, badges: {}, onceAt: {} });
  });

  it("leaves out a host that has no history to give", async () => {
    withoutGit();
    h.adopt();
    await h.serve();
    const client = ownerClient(h);
    client.hostConnected();
    // A host server older than merged stats: no such method.
    let asked = false;
    const real = client.invoke.bind(client);
    client.invoke = ((ns: string, method: string, ...rest: unknown[]) => {
      if (ns !== "stats" || method !== "getHistory") return (real as (...a: unknown[]) => unknown)(ns, method, ...rest);
      asked = true;
      return Promise.reject(new Error("unavailable:host"));
    }) as typeof client.invoke;
    const heard: unknown[] = [];
    const warned: string[] = [];
    proxyFor(h, client, desktopBus().bus, {
      onStatsHistory: (history) => heard.push(history),
      log: { info: () => {}, warn: (m: string) => warned.push(m) },
    });
    await eventually(() => asked, (yes) => yes, "the history read");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard).toEqual([]);
    expect(warned).toEqual([]);
  });

  it("clears the host's stats before reading them when the desktop reset while it was away", async () => {
    withoutGit();
    h.adopt();
    fs.writeFileSync(
      path.join(h.paths.dataDir, "stats.json"),
      JSON.stringify({ version: 1, days: { "2026-10-30": { prompts: 4 } }, badges: {} }),
    );
    await h.serve();
    const client = ownerClient(h);
    client.hostConnected();
    let due = true;
    const heard: unknown[] = [];
    proxyFor(h, client, desktopBus().bus, {
      statsResetDue: () => due,
      onStatsReset: () => (due = false),
      onStatsHistory: (history) => heard.push(history),
    });

    await eventually(() => heard, (list) => list.length > 0, "the history");
    expect(due).toBe(false);
    expect(heard[0]).toEqual({ days: {}, badges: {}, onceAt: {} });
  });
});

