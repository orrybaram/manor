/**
 * The bell across servers: every server keeps its own notification log, and
 * the router hands the page all of them merged, newest first, each record
 * naming the host that keeps it — on a read and on every server's
 * `notifications.changed`. A mark goes to that host's server.
 */

import { describe, expect, it, vi } from "vitest";

import type { BridgeTransport } from "../client";
import { createRouter, type HostResolver } from "../router";
import { createServerSet, type ServerSet } from "../server-set";

type Handler = (...args: unknown[]) => unknown;

interface FakeServer {
  transport: BridgeTransport;
  invokes: Array<{ key: string; args: unknown[] }>;
  emit(key: string, ...args: unknown[]): void;
}

function fakeServer(answers: Record<string, Handler> = {}): FakeServer {
  const invokes: FakeServer["invokes"] = [];
  const subs: Array<{ key: string; cb: Handler; live: boolean }> = [];
  const transport: BridgeTransport = {
    start() {},
    rendererId: "r1",
    platform: "electron",
    rootValues: { claim: null },
    localNamespaces: {},
    locallyServed: {},
    invoke(ns, method, args) {
      const key = `${ns}.${method}`;
      invokes.push({ key, args });
      return Promise.resolve(answers[key]?.(...args));
    },
    subscribe(ns, event, _sub, cb) {
      const record = { key: `${ns}.${event}`, cb, live: true };
      subs.push(record);
      return () => {
        record.live = false;
      };
    },
  };
  return {
    transport,
    invokes,
    emit(key, ...args) {
      for (const s of subs) if (s.live && s.key === key) s.cb(...args);
    },
  };
}

const resolver: HostResolver = {
  hostOf(rule, args) {
    if (rule.by !== "host") return null;
    const arg = args[rule.arg];
    return typeof arg === "string" && arg ? arg : "local";
  },
};

function record(id: string, timestamp: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: "automation-ran",
    title: id,
    body: "",
    timestamp,
    read: false,
    target: { type: "automation", automationId: `a-${id}` },
    hostId: "local",
    ...extra,
  };
}

/** The desktop's own server, listing every host, and the box's own server. */
function desktopWithHost(home: FakeServer, box: FakeServer): ServerSet {
  const set = createServerSet();
  set.add("local", home.transport, { home: true, lists: "all" });
  set.add("box", box.transport, { capabilities: ["viewer-bridge"] });
  set.recordHello("box", { hostName: "wsl-box", hostServer: true });
  set.setReachability("box", "connected");
  return set;
}

describe("the bell across servers", () => {
  it("merges every server's log newest first, each record stamped with its host", async () => {
    const home = fakeServer({
      "notifications.getAll": () => [
        record("d2", "2026-10-29T10:00:00.000Z", { kind: "agent-responded", target: null }),
        // The desktop's copy of the box's record: the box answers for it.
        record("b1", "2026-10-29T09:30:00.000Z", { hostId: "box" }),
        record("d1", "2026-10-29T08:00:00.000Z"),
      ],
    });
    const box = fakeServer({
      "notifications.getAll": () => [
        record("b2", "2026-10-29T11:00:00.000Z"),
        record("b1", "2026-10-29T09:30:00.000Z"),
      ],
    });
    const api = createRouter(desktopWithHost(home, box), resolver);

    const list = await api.notifications.getAll();
    expect(list.map((n) => [n.id, n.hostId])).toEqual([
      ["b2", "box"],
      ["d2", "local"],
      ["b1", "box"],
      ["d1", "local"],
    ]);
  });

  it("merges one server's change with every other server's last log", async () => {
    const home = fakeServer({
      "notifications.getAll": () => [record("d1", "2026-10-29T08:00:00.000Z")],
    });
    const box = fakeServer({
      "notifications.getAll": () => [record("b1", "2026-10-29T09:00:00.000Z")],
    });
    const api = createRouter(desktopWithHost(home, box), resolver);
    const changed = vi.fn();
    api.notifications.onChanged(changed);
    await api.notifications.getAll();

    // A run fired on the box: its whole log, which keeps the desktop's.
    box.emit("notifications.changed", [
      record("b2", "2026-10-29T12:00:00.000Z"),
      record("b1", "2026-10-29T09:00:00.000Z"),
    ]);
    expect(changed).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "b2", hostId: "box" }),
      expect.objectContaining({ id: "b1", hostId: "box" }),
      expect.objectContaining({ id: "d1", hostId: "local" }),
    ]);
  });

  it("takes a badge from home alone: another server's stats are not the trophy room's", async () => {
    const badge = { kind: "badge-unlocked", target: { type: "stats", badgeId: "fleet" } };
    const home = fakeServer({
      "notifications.getAll": () => [record("d1", "2026-10-09T08:00:00.000Z", badge)],
    });
    const box = fakeServer({
      "notifications.getAll": () => [
        record("b2", "2026-10-30T04:02:00.000Z", badge),
        record("b1", "2026-10-29T09:00:00.000Z"),
      ],
    });
    const api = createRouter(desktopWithHost(home, box), resolver);
    const changed = vi.fn();
    api.notifications.onChanged(changed);

    expect((await api.notifications.getAll()).map((n) => n.id)).toEqual(["b1", "d1"]);
    box.emit("notifications.changed", [
      record("b3", "2026-10-30T05:00:00.000Z", badge),
      record("b1", "2026-10-29T09:00:00.000Z"),
    ]);
    expect(changed.mock.lastCall?.[0].map((n: { id: string }) => n.id)).toEqual(["b1", "d1"]);
  });

  it("tells the listener again when a server leaves the set", async () => {
    const home = fakeServer({
      "notifications.getAll": () => [record("d1", "2026-10-29T08:00:00.000Z")],
    });
    const box = fakeServer({
      "notifications.getAll": () => [record("b1", "2026-10-29T09:00:00.000Z")],
    });
    const set = desktopWithHost(home, box);
    const api = createRouter(set, resolver);
    const changed = vi.fn();
    api.notifications.onChanged(changed);
    await api.notifications.getAll();

    set.remove("box");
    expect(changed).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "d1", hostId: "local" }),
    ]);
  });

  it("tells the listener the desktop's copy when the host's own server goes away", async () => {
    const home = fakeServer({
      "notifications.getAll": () => [
        record("b1", "2026-10-29T09:00:00.000Z", { hostId: "box", read: true }),
        record("d1", "2026-10-29T08:00:00.000Z"),
      ],
    });
    const box = fakeServer({
      "notifications.getAll": () => [record("b1", "2026-10-29T09:00:00.000Z")],
    });
    const set = desktopWithHost(home, box);
    const api = createRouter(set, resolver);
    const changed = vi.fn();
    api.notifications.onChanged(changed);
    const first = await api.notifications.getAll();
    expect(first.find((n) => n.id === "b1")?.read).toBe(false);

    set.setReachability("box", "unreachable");
    expect(changed).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "b1", hostId: "box", read: true }),
      expect.objectContaining({ id: "d1", hostId: "local" }),
    ]);
    // Nothing moved again: not told twice.
    const calls = changed.mock.calls.length;
    set.setReachability("box", "unreachable");
    expect(changed).toHaveBeenCalledTimes(calls);
  });

  it("marks a record read on the server of the host that keeps it", async () => {
    const home = fakeServer({ "notifications.markRead": () => false });
    const box = fakeServer({ "notifications.markRead": () => true });
    const api = createRouter(desktopWithHost(home, box), resolver);

    expect(await api.notifications.markRead("b1", "box")).toBe(true);
    // The box knows itself as `local`.
    expect(box.invokes).toEqual([{ key: "notifications.markRead", args: ["b1", "local"] }]);
    await api.notifications.markRead("d1", "local");
    expect(home.invokes).toEqual([{ key: "notifications.markRead", args: ["d1", "local"] }]);
  });
});
