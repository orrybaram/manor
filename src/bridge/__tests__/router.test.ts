/**
 * The router over the server set (ADR-228 D1, D2, D3, D5, D6, D7), against
 * fake transports: the desktop's own server and a host server it holds a
 * bridge to (`desktop-hosts.ts`), or several.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { byPane, type RouteRule } from "../../../electron/bridge/routes";
import { UNAVAILABLE_HOST_AWAY_CODE } from "../../../electron/bridge/types";
import {
  BridgeDisconnectedError,
  BridgeUnavailableError,
  type BridgeTransport,
} from "../client";
import { onBridgeResync } from "../resync";
import { createRouter, storeResolver, type HostResolver } from "../router";
import { createServerSet, type ServerSet } from "../server-set";

type Handler = (...args: unknown[]) => unknown;

interface FakeServer {
  transport: BridgeTransport;
  invokes: Array<{ key: string; args: unknown[] }>;
  subs: Array<{ key: string; sub: string | undefined; cb: Handler; live: boolean }>;
  /** Fire `ns.event` at every live listener (with that key, if given). */
  emit(key: string, sub: string | undefined, ...args: unknown[]): void;
  live(key: string): number;
}

function fakeServer(
  answers: Record<string, Handler | unknown> = {},
  extra: Partial<BridgeTransport> = {},
): FakeServer {
  const invokes: FakeServer["invokes"] = [];
  const subs: FakeServer["subs"] = [];
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
      const answer = answers[key];
      try {
        return Promise.resolve(
          typeof answer === "function" ? (answer as Handler)(...args) : answer,
        );
      } catch (err) {
        return Promise.reject(err);
      }
    },
    subscribe(ns, event, sub, cb) {
      const record = { key: `${ns}.${event}`, sub, cb, live: true };
      subs.push(record);
      return () => {
        record.live = false;
      };
    },
    ...extra,
  };
  return {
    transport,
    invokes,
    subs,
    emit(key, sub, ...args) {
      for (const s of subs) {
        if (s.live && s.key === key && (sub === undefined || s.sub === sub)) s.cb(...args);
      }
    },
    live(key) {
      return subs.filter((s) => s.live && s.key === key).length;
    },
  };
}

/** A resolver over plain maps, as the stores would answer. */
function fakeResolver(maps: {
  project?: Record<string, string>;
  pane?: Record<string, string>;
  agent?: Record<string, string>;
}): HostResolver {
  return {
    hostOf(rule: RouteRule, args) {
      const arg = args[rule.arg];
      if (rule.by === "workspaceKey" && typeof arg === "string") {
        const at = arg.indexOf(":/");
        return at > 0 ? arg.slice(0, at) : "local";
      }
      if (typeof arg !== "string") return null;
      if (rule.by === "project") return maps.project?.[arg] ?? null;
      if (rule.by === "pane") return maps.pane?.[arg] ?? null;
      if (rule.by === "agent") return maps.agent?.[arg] ?? null;
      if (rule.by === "host") return arg;
      return null;
    },
  };
}

/** A one-pane workspace layout entry. */
function layoutWith(paneId: string, version = 1) {
  return {
    version,
    layout: {
      panelTree: { type: "leaf", panelId: "panel" },
      panels: {
        panel: {
          id: "panel",
          tabs: [{ id: "tab", title: "", rootNode: { type: "leaf", paneId } }],
          pinnedTabIds: [],
        },
      },
    },
  };
}

const GROUP = { id: "g", name: "App", memberIds: ["p0", "p1"], lastUsedHostId: null };

/** The desktop's own server (`local`, listing every host) and a host server. */
function desktopWithHost(
  home: FakeServer,
  box: FakeServer,
  opts: { homeLists?: "all" | string[] } = {},
): ServerSet {
  const set = createServerSet();
  set.add("local", home.transport, { home: true, lists: opts.homeLists ?? "all" });
  set.add("box", box.transport, { capabilities: ["viewer-bridge"] });
  set.recordHello("box", { hostName: "wsl-box", hostServer: true });
  set.setReachability("box", "connected");
  return set;
}

describe("the router with only the home server", () => {
  it("passes merged and routed answers through untouched", async () => {
    const projects = [{ id: "p1", hostId: "box", name: "A" }];
    const layouts = { "/a": layoutWith("x"), "box:/b": layoutWith("y") };
    const home = fakeServer({
      "projects.getAll": () => projects,
      "layout.getAll": () => layouts,
      "projects.renameWorkspace": (...args: unknown[]) => args,
    });
    const set = createServerSet();
    set.add("local", home.transport, { home: true, lists: "all" });
    const api = createRouter(set, fakeResolver({ project: { p1: "box" } }));

    expect(await api.projects.getAll()).toBe(projects);
    expect(await api.layout.getAll()).toBe(layouts);
    // A remote project's call is main's to forward: it goes home, as given.
    const args = ["p1", "box:/b", "new"];
    await api.projects.renameWorkspace("p1", "box:/b", "new");
    expect(home.invokes[home.invokes.length - 1]).toEqual({ key: "projects.renameWorkspace", args });
  });

  it("answers the page's facts from the home transport", () => {
    const home = fakeServer();
    const set = createServerSet();
    set.add("local", home.transport, { home: true });
    const api = createRouter(set, fakeResolver({}));
    expect(api.platform).toBe("electron");
    expect(api.rendererId).toBe("r1");
    expect(api.claim).toBeNull();
    expect((api as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it("subscribes a pane's listener with the caller's own callback", () => {
    const home = fakeServer();
    const set = createServerSet();
    set.add("local", home.transport, { home: true, lists: "all" });
    const api = createRouter(set, fakeResolver({}));
    const cb = vi.fn();
    api.chat.onEntry("pane", cb);
    expect(home.subs[0]).toMatchObject({ key: "chat.entry", sub: "pane", cb });
  });
});

describe("routed calls", () => {
  it("reach the host's own server, with its arguments and answer rewritten", async () => {
    const home = fakeServer({ "projects.renameWorkspace": "home" });
    const box = fakeServer({
      "projects.renameWorkspace": () => ({ id: "p1", hostId: "local", name: "A" }),
    });
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({ project: { p0: "local", p1: "box" } }));

    const result = await api.projects.renameWorkspace("p1", "box:/w", "new");
    expect(box.invokes).toEqual([
      { key: "projects.renameWorkspace", args: ["p1", "/w", "new"] },
    ]);
    expect(result).toEqual({ id: "p1", hostId: "box", name: "A" });

    // The desktop's own project, and one nobody knows, stay home.
    await api.projects.renameWorkspace("p0", "/w", "new");
    await api.projects.renameWorkspace("p9", "/w", "new");
    expect(home.invokes.map((i) => i.args[0])).toEqual(["p0", "p9"]);
    expect(home.invokes[0].args).toEqual(["p0", "/w", "new"]);
  });

  it("route by workspace key, pane and agent", async () => {
    const home = fakeServer();
    const box = fakeServer();
    const set = desktopWithHost(home, box);
    const api = createRouter(
      set,
      fakeResolver({ pane: { "pane-b": "box" }, agent: { "agent-b": "box" } }),
    );
    await api.layout.apply("box:/b", { type: "noop" } as never);
    await api.chat.send("pane-b", "hi");
    await api.agents.markSeen("agent-b");
    expect(box.invokes.map((i) => [i.key, i.args[0]])).toEqual([
      ["layout.apply", "/b"],
      ["chat.send", "pane-b"],
      ["agents.markSeen", "agent-b"],
    ]);
    expect(home.invokes).toEqual([]);
  });

  it("fall back to a server that lists the host while its own is away (D6)", async () => {
    const home = fakeServer();
    const box = fakeServer();
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({ project: { p1: "box" } }));
    set.setReachability("box", "unreachable");
    await api.projects.renameWorkspace("p1", "box:/w", "new");
    expect(box.invokes).toEqual([]);
    // Main's `HostRouting` is the one that knows the host's keys.
    expect(home.invokes[0].args).toEqual(["p1", "box:/w", "new"]);
  });

  it("refuse a host with no reachable source as host-away", async () => {
    const home = fakeServer();
    const box = fakeServer();
    const set = desktopWithHost(home, box, { homeLists: [] });
    const api = createRouter(set, fakeResolver({ project: { p1: "box" } }));
    set.setReachability("box", "unreachable");

    const refused = api.projects.renameWorkspace("p1", "box:/w", "new");
    await expect(refused).rejects.toBeInstanceOf(BridgeUnavailableError);
    await expect(refused).rejects.toMatchObject({
      code: UNAVAILABLE_HOST_AWAY_CODE,
      message: "wsl-box is offline",
    });
    expect(box.invokes).toEqual([]);
    expect(home.invokes).toEqual([]);
  });
});

describe("calls the home transport serves", () => {
  it("never reach another server", async () => {
    const viewport = vi.fn(() => ({ saved: true }));
    const native = { shell: { openExternal: vi.fn(() => "opened") } };
    const home = fakeServer(
      {},
      {
        platform: "web",
        locallyServed: { "viewport.load": viewport },
        localNamespaces: native,
      },
    );
    // A host server's socket transport serves the same calls for a browser
    // (ADR-228 ticket 3): it must never be the one asked.
    const boxViewport = vi.fn();
    const box = fakeServer(
      {},
      {
        platform: "web",
        locallyServed: { "viewport.load": boxViewport },
        rootValues: { claim: "box's", env: { isPackaged: false } },
      },
    );
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({}));

    expect(api.viewport.load()).toEqual({ saved: true });
    expect(boxViewport).not.toHaveBeenCalled();
    expect(api.claim).toBeNull();
    expect(api.shell.openExternal("https://x")).toBe("opened");
    // Refused in a browser, without asking anyone.
    await expect(api.webview.unregister("pane")).rejects.toBeInstanceOf(
      BridgeUnavailableError,
    );
    expect(api.platform).toBe("web");
    expect(home.invokes).toEqual([]);
    expect(box.invokes).toEqual([]);
  });
});

describe("merged reads", () => {
  it("merge every server, dropping a host's entries from all but its source", async () => {
    const home = fakeServer({
      "projects.getAll": () => [
        { id: "p0", hostId: "local", name: "Mine", group: GROUP },
        // The desktop's cached copy of the box's project.
        { id: "p1", hostId: "box", name: "Stale", group: GROUP },
      ],
      "layout.getAll": () => ({ "/a": layoutWith("x"), "box:/b": layoutWith("old") }),
      "agents.getAll": () => [
        { id: "a0", hostId: "local" },
        { id: "a1", hostId: "box", title: "stale" },
      ],
    });
    const box = fakeServer({
      // The host knows itself as `local`, and nothing of groups.
      "projects.getAll": () => [
        { id: "p2", hostId: "local", name: "Only on box" },
        { id: "p1", hostId: "local", name: "Fresh" },
      ],
      "layout.getAll": () => ({ "/b": layoutWith("new") }),
      "agents.getAll": () => [{ id: "a1", hostId: "local", title: "fresh" }],
    });
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({}));

    expect(await api.projects.getAll()).toEqual([
      { id: "p0", hostId: "local", name: "Mine", group: GROUP },
      // Its own fields from its source, its group from the desktop (D3).
      { id: "p1", hostId: "box", name: "Fresh", group: GROUP },
      { id: "p2", hostId: "box", name: "Only on box" },
    ]);
    expect(await api.layout.getAll()).toEqual({
      "/a": layoutWith("x"),
      "box:/b": layoutWith("new"),
    });
    expect(await api.agents.getAll()).toEqual([
      { id: "a0", hostId: "local" },
      { id: "a1", hostId: "box", title: "fresh" },
    ]);
  });

  it("keep the desktop's entries for a host whose own server is away", async () => {
    const home = fakeServer({
      "projects.getAll": () => [{ id: "p1", hostId: "box", name: "Cached" }],
    });
    const box = fakeServer({ "projects.getAll": () => [] });
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({}));
    set.setReachability("box", "unreachable");
    expect(await api.projects.getAll()).toEqual([
      { id: "p1", hostId: "box", name: "Cached" },
    ]);
    expect(box.invokes).toEqual([]);
  });

  it("answer from a server's last-known state while it is away", async () => {
    const home = fakeServer({ "projects.getAll": () => [] });
    const box = fakeServer({
      "projects.getAll": () => [{ id: "p1", hostId: "local", name: "Seen" }],
    });
    // A phone-like set: the home server does not list the box.
    const set = desktopWithHost(home, box, { homeLists: [] });
    const api = createRouter(set, fakeResolver({}));
    await api.projects.getAll();

    set.setReachability("box", "unreachable");
    expect(await api.projects.getAll()).toEqual([
      { id: "p1", hostId: "box", name: "Seen" },
    ]);
    expect(box.invokes).toHaveLength(1);
  });

  it("answer from the others, and the failed server's last answer, when one fails", async () => {
    let fail = false;
    const home = fakeServer({ "agents.getActive": () => [{ id: "a0", hostId: "local" }] });
    const box = fakeServer({
      "agents.getActive": () => {
        if (fail) throw new Error("dropped");
        return [{ id: "a1", hostId: "local" }];
      },
    });
    const set = desktopWithHost(home, box, { homeLists: [] });
    const api = createRouter(set, fakeResolver({}));
    await api.agents.getActive();
    fail = true;
    expect(await api.agents.getActive()).toEqual([
      { id: "a0", hostId: "local" },
      { id: "a1", hostId: "box" },
    ]);
  });
});

describe("subscriptions", () => {
  it("are replayed on a server that joins, and stamped on the way in", () => {
    const home = fakeServer();
    const set = createServerSet();
    set.add("local", home.transport, { home: true, lists: "all" });
    const api = createRouter(set, fakeResolver({}));
    const changed = vi.fn();
    api.layout.onChanged(changed);
    expect(home.live("layout.changed")).toBe(1);

    const box = fakeServer();
    set.add("box", box.transport);
    expect(box.live("layout.changed")).toBe(1);

    box.emit("layout.changed", undefined, { ...layoutWith("y", 2), workspacePath: "/b" });
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspacePath: "box:/b", version: 2 }),
    );
    // The desktop's copy of the same host is not its source now.
    changed.mockClear();
    home.emit("layout.changed", undefined, { workspacePath: "box:/b", version: 2 });
    expect(changed).not.toHaveBeenCalled();
    home.emit("layout.changed", undefined, { workspacePath: "/a", version: 1 });
    expect(changed).toHaveBeenCalledOnce();

    set.remove("box");
    expect(box.live("layout.changed")).toBe(0);
  });

  it("stamp and dedupe agent updates by source", () => {
    const home = fakeServer();
    const box = fakeServer();
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({}));
    const updated = vi.fn();
    api.agents.onUpdate(updated);
    const flags = { responded: false, requires_input: false };
    box.emit("agents.updated", undefined, { id: "a1", hostId: "local" }, flags);
    home.emit("agents.updated", undefined, { id: "a1", hostId: "box" }, flags);
    home.emit("agents.updated", undefined, { id: "a0", hostId: "local" }, flags);
    expect(updated.mock.calls).toEqual([
      [{ id: "a1", hostId: "box" }, flags],
      [{ id: "a0", hostId: "local" }, flags],
    ]);
  });

  it("keep a machine-level listener on the home server", () => {
    const home = fakeServer();
    const box = fakeServer();
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({}));
    api.preferences.onChange(() => {});
    expect(home.live("preferences.changed")).toBe(1);
    expect(box.live("preferences.changed")).toBe(0);
  });

  it("open a pane's listener only on that pane's source", () => {
    const home = fakeServer();
    const box = fakeServer();
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({ pane: { "pane-b": "box" } }));
    const entry = vi.fn();
    const off = api.chat.onEntry("pane-b", entry);
    api.chat.onTaskEntry("pane-b/task-1", () => {});
    expect(box.subs.map((s) => [s.key, s.sub])).toEqual([
      ["chat.entry", "pane-b"],
      ["chat.taskEntry", "pane-b/task-1"],
    ]);
    expect(home.subs).toEqual([]);

    box.emit("chat.entry", "pane-b", "pane-b", { id: "e" });
    expect(entry).toHaveBeenCalledWith("pane-b", { id: "e" });

    // Its server leaves: the pane's listeners move to its next source.
    set.remove("box");
    expect(home.subs.map((s) => [s.key, s.sub])).toEqual([
      ["chat.entry", "pane-b"],
      ["chat.taskEntry", "pane-b/task-1"],
    ]);
    off();
    expect(home.live("chat.entry")).toBe(0);
  });

  it("move a pane's listeners to a server that joins as its source", () => {
    const home = fakeServer();
    const set = createServerSet();
    set.add("local", home.transport, { home: true, lists: "all" });
    const api = createRouter(set, fakeResolver({ pane: { "pane-b": "box" } }));
    api.chat.onEntry("pane-b", () => {});
    expect(home.live("chat.entry")).toBe(1);

    const box = fakeServer();
    set.add("box", box.transport);
    expect(home.live("chat.entry")).toBe(0);
    expect(box.live("chat.entry")).toBe(1);
  });

  it("refuse a pane id two servers' layouts both hold", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const home = fakeServer({ "layout.getAll": () => ({ "/a": layoutWith("dup") }) });
    const box = fakeServer({ "layout.getAll": () => ({ "/b": layoutWith("dup") }) });
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({ pane: { dup: "box" } }));
    await api.layout.getAll();

    const off = api.chat.onEntry("dup", () => {});
    expect(home.subs).toEqual([]);
    expect(box.subs).toEqual([]);
    off();
    await expect(api.chat.send("dup", "hi")).rejects.toThrow(/two servers/);
    expect(box.invokes.filter((i) => i.key === "chat.send")).toEqual([]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("per-server resync", () => {
  const offs: Array<() => void> = [];
  afterEach(() => {
    for (const off of offs.splice(0)) off();
  });

  it("emits on a resumed hello from any server, naming it", () => {
    const set = createServerSet();
    set.add("local", fakeServer().transport, { home: true });
    set.add("box", fakeServer().transport);
    const resync = vi.fn();
    offs.push(onBridgeResync(resync));

    const hooks = set.hooks("box");
    hooks.onHello({ hostName: "wsl-box", hostServer: true, resumed: false });
    expect(resync).not.toHaveBeenCalled();
    expect(set.get("box")).toMatchObject({
      reachability: "connected",
      hello: { name: "wsl-box", hostServer: true },
    });

    hooks.onStatus("unreachable");
    expect(set.get("box")?.reachability).toBe("unreachable");
    hooks.onHello({ hostName: "wsl-box", hostServer: true, resumed: true });
    expect(resync).toHaveBeenCalledExactlyOnceWith("box");
  });
});

describe("the server set", () => {
  it("lists home first and keeps it", () => {
    const set = createServerSet();
    set.add("box", fakeServer().transport);
    set.add("local", fakeServer().transport, { home: true });
    expect(set.list().map((e) => e.id)).toEqual(["local", "box"]);
    set.remove("local");
    expect(set.home().id).toBe("local");
  });

  it("notifies on change, with a new entry object", () => {
    const set = createServerSet();
    set.add("local", fakeServer().transport, { home: true });
    const before = set.home();
    const cb = vi.fn();
    set.subscribe(cb);
    set.setReachability("local", "unreachable");
    expect(cb).toHaveBeenCalledOnce();
    expect(set.home()).not.toBe(before);
    expect(set.home().bridge).toBe(before.bridge);
    set.setReachability("local", "unreachable");
    expect(cb).toHaveBeenCalledOnce();
  });
});

describe("a desktop window's terminals on a host's own bridge (D5)", () => {
  it("routes a remote pane's pty calls to its host, with the host option made local", async () => {
    const home = fakeServer();
    const box = fakeServer({
      "pty.create": () => ({ ok: true, hostId: "local", snapshot: null }),
    });
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({ pane: { "pane-b": "box" } }));

    const created = await api.pty.create("pane-b", "/w", 80, 24, { hostId: "box" } as never);
    void api.pty.write("pane-b", "ls\r");
    await api.pty.resize("pane-b", 100, 30);
    await api.pty.detach("pane-b");
    expect(box.invokes.map((i) => [i.key, i.args])).toEqual([
      ["pty.create", ["pane-b", "/w", 80, 24, { hostId: "local" }]],
      ["pty.write", ["pane-b", "ls\r"]],
      ["pty.resize", ["pane-b", 100, 30]],
      ["pty.detach", ["pane-b"]],
    ]);
    // The answer names the host as the desktop knows it.
    expect(created).toMatchObject({ ok: true, hostId: "box" });

    // A pane the renderer cannot place, and the window-only calls, stay home.
    await api.pty.create("mini-1", null, 80, 24);
    await api.pty.consumePrewarmed("/w", "box");
    expect(home.invokes.map((i) => i.key)).toEqual(["pty.create", "pty.consumePrewarmed"]);
  });

  it("opens a remote pane's pty listeners on its host, and moves them home while it is away", () => {
    const home = fakeServer();
    const box = fakeServer();
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({ pane: { "pane-b": "box" } }));
    const output = vi.fn();
    api.pty.onOutput("pane-b", output);
    expect(box.live("pty.output")).toBe(1);
    expect(home.live("pty.output")).toBe(0);
    box.emit("pty.output", "pane-b", "hello");
    expect(output).toHaveBeenCalledWith("hello");

    // The bridge drops: main answers for the host meanwhile (D6).
    set.setReachability("box", "unreachable");
    expect(home.live("pty.output")).toBe(1);
    expect(box.live("pty.output")).toBe(0);
    set.setReachability("box", "connected");
    expect(box.live("pty.output")).toBe(1);
    expect(home.live("pty.output")).toBe(0);
  });

  it("places a new pane by the host its create names, when no store does yet", () => {
    const create = byPane(0, 4);
    expect(storeResolver.hostOf(create, ["pane-new", "/w", 80, 24, { hostId: "box" }])).toBe("box");
    expect(storeResolver.hostOf(create, ["pane-new", "/w", 80, 24])).toBeNull();
    // Only a rule that says where to look reads the options.
    expect(storeResolver.hostOf(byPane(0), ["pane-new", "/w", 80, 24, { hostId: "box" }])).toBeNull();
  });

  it("sends a keystroke home while the pane's own bridge is not up, and lets one its drop lost go", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const home = fakeServer();
    const box = fakeServer({
      "pty.write": () => {
        throw new BridgeDisconnectedError();
      },
    });
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({ pane: { "pane-b": "box" } }));

    // In flight as the stream dropped: it may have landed, so it is not sent
    // again, and nobody is left holding a rejection.
    await expect(api.pty.write("pane-b", "a")).resolves.toBeUndefined();
    expect(box.invokes.map((i) => i.key)).toEqual(["pty.write"]);
    expect(home.invokes).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();

    // Not up yet: main forwards it. Only the keyboard takes that path.
    set.setReachability("box", "unknown");
    await api.pty.write("pane-b", "b");
    await api.pty.resize("pane-b", 90, 20);
    expect(home.invokes).toEqual([{ key: "pty.write", args: ["pane-b", "b"] }]);
    expect(box.invokes.map((i) => i.key)).toEqual(["pty.write", "pty.resize"]);
    warn.mockRestore();
  });

  it("sends a viewport report home, whatever host its workspace is on (D7)", async () => {
    const home = fakeServer();
    const box = fakeServer();
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({}));
    await api.layout.reportViewport("box:/b", { activeTabId: "t" } as never);
    expect(home.invokes).toEqual([
      { key: "layout.reportViewport", args: ["box:/b", { activeTabId: "t" }] },
    ]);
    expect(box.invokes).toEqual([]);
  });
});

describe("a detached window's claim on a remote tab (D7)", () => {
  const CLAIM = [{ windowId: "9", tabId: "tab" }];

  it("comes from the desktop, onto the host's own layout and broadcasts", async () => {
    const home = fakeServer({
      "layout.getAll": () => ({ "box:/b": { ...layoutWith("x", 1), claims: CLAIM } }),
    });
    const box = fakeServer({
      "layout.getAll": () => ({ "/b": { ...layoutWith("x", 2), claims: [] } }),
    });
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({}));
    const merged = (await api.layout.getAll()) as unknown as Record<string, unknown>;
    // The host's layout, which is newer, with the desktop's claim on it.
    expect(merged["box:/b"]).toMatchObject({ version: 2, claims: CLAIM });

    const changed = vi.fn();
    api.layout.onChanged(changed);
    // A change on the host keeps the claim the host never heard of.
    box.emit("layout.changed", undefined, {
      ...layoutWith("y", 3),
      workspacePath: "/b",
      claims: [],
      origin: { kind: "bridge", id: "phone-1" },
    });
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspacePath: "box:/b", version: 3, claims: CLAIM }),
    );

    // The window closes: the desktop says so, from its own (older) copy of
    // the host's layout. Told with the host's layout, and no claim.
    home.emit("layout.changed", undefined, {
      ...layoutWith("x", 2),
      workspacePath: "box:/b",
      claims: [],
      origin: { kind: "window", id: "9" },
    });
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspacePath: "box:/b",
        version: 3,
        layout: layoutWith("y", 3).layout,
        claims: [],
      }),
    );

    // The desktop passing on a host change, claims unmoved, is not news.
    changed.mockClear();
    home.emit("layout.changed", undefined, {
      ...layoutWith("y", 3),
      workspacePath: "box:/b",
      claims: [],
      origin: { kind: "bridge", id: "phone-1" },
    });
    expect(changed).not.toHaveBeenCalled();
  });
});

describe("what main's HostRouting did on the way, done by the router", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a new pane's queued command to the server its layout command goes to", async () => {
    const home = fakeServer();
    const box = fakeServer();
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({}));

    await api.layout.setPendingCommand("new-pane", "claude", "agent-startup");
    expect(home.invokes).toEqual([]);
    expect(box.invokes).toEqual([]);

    await api.layout.apply("box:/b", { type: "add-tab", paneId: "new-pane" } as never);
    expect(box.invokes.map((i) => [i.key, i.args[0]])).toEqual([
      ["layout.setPendingCommand", "new-pane"],
      ["layout.apply", "/b"],
    ]);
    // Unchanged: the line is the user's, not a key to rewrite.
    expect(box.invokes[0].args).toEqual(["new-pane", "claude", "agent-startup"]);
    expect(home.invokes).toEqual([]);
  });

  it("sends a queued command home when no layout command claims it in time", async () => {
    vi.useFakeTimers();
    const home = fakeServer();
    const box = fakeServer();
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({}));
    await api.layout.setPendingCommand("orphan", "ls");
    expect(home.invokes).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(home.invokes).toEqual([
      { key: "layout.setPendingCommand", args: ["orphan", "ls"] },
    ]);
  });

  it("gives a host's project the desktop's group", async () => {
    const home = fakeServer({
      "projects.getAll": () => [{ id: "p1", hostId: "box", workspaces: [], group: GROUP }],
    });
    const box = fakeServer({
      "projects.getAll": () => [{ id: "p1", hostId: "local", workspaces: [] }],
      "projects.renameWorkspace": () => ({ id: "p1", hostId: "local", workspaces: [] }),
    });
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({ project: { p1: "box" } }));
    await api.projects.getAll();
    const renamed = await api.projects.renameWorkspace("p1", "box:/w", "new");
    expect(renamed).toEqual({ id: "p1", hostId: "box", workspaces: [], group: GROUP });
  });

  it("names this window as the origin of a layout command it sent a host itself", () => {
    const home = fakeServer({}, { rendererId: "7" });
    const box = fakeServer({}, { rendererId: "box-conn-3" });
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({}));
    const changed = vi.fn();
    api.layout.onChanged(changed);

    const hint = { focusPaneId: "x" };
    box.emit("layout.changed", undefined, {
      ...layoutWith("x", 2),
      workspacePath: "/b",
      origin: { kind: "bridge", id: "box-conn-3" },
      hint,
    });
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspacePath: "box:/b", origin: { kind: "window", id: "7" }, hint }),
    );

    // Someone else's command keeps its origin.
    box.emit("layout.changed", undefined, {
      ...layoutWith("x", 3),
      workspacePath: "/b",
      origin: { kind: "bridge", id: "phone-1" },
    });
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ origin: { kind: "bridge", id: "phone-1" } }),
    );
  });
});
