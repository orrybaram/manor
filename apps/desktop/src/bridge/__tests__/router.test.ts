/**
 * The router over the server set, against
 * fake transports: the desktop's own server and a host server it holds a
 * bridge to (`desktop-hosts.ts`), or several.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { byPane, type RouteRule } from "../../../electron/bridge/routes";
import { UNAVAILABLE_HOST_AWAY_CODE, UNAVAILABLE_HOST_CODE } from "../../../electron/bridge/types";
import {
  BridgeDisconnectedError,
  BridgeUnavailableError,
  type BridgeTransport,
} from "../client";
import { onBridgeResync } from "../resync";
import { createRouter, onBehalfOf, storeResolver, type HostResolver } from "../router";
import { createServerSet, type ServerSet } from "../server-set";
import { autoMatchLinearTeams } from "../../lib/linear-auto-match";
import type { ProjectInfo } from "../../store/project-store";

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
      if (rule.by === "delegated") return null;
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

  it("hands its whole watch home and passes its updates through", async () => {
    const home = fakeServer({ "branches.start": () => undefined });
    const set = createServerSet();
    set.add("local", home.transport, { home: true, lists: "all" });
    const api = createRouter(set, fakeResolver({}));
    const list = [
      { path: "/a", hostId: "local" },
      { path: "/b", hostId: "box" },
    ];
    await api.branches.start(list);
    expect(home.invokes).toEqual([{ key: "branches.start", args: [list] }]);
    const changed = vi.fn();
    api.branches.onChange(changed);
    const payload = { "/a": "main", "box:/b": "feat" };
    home.emit("branches.changed", undefined, payload);
    expect(changed).toHaveBeenCalledWith(payload);
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

  it("fall back to a server that lists the host while its own is away", async () => {
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
    // A host server's socket transport serves the same calls for a browser:
    // it must never be the one asked.
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
      // Its own fields from its source, its group from the desktop.
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

describe("a desktop window's terminals on a host's own bridge", () => {
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

    // The bridge drops: main answers for the host meanwhile.
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

  it("sends a viewport report home, whatever host its workspace is on", async () => {
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

describe("a detached window's claim on a remote tab", () => {
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

describe("on the phone, every server named by its room", () => {
  const DESK = "DeskRoom0000000000000a";
  const BOX = "BoxRoom00000000000000b";

  /** A phone paired with the desktop, which lists `h1` (the box) by its room. */
  function phone(desk: FakeServer, box?: FakeServer): ServerSet {
    const set = createServerSet();
    set.add(DESK, desk.transport, { home: true, roomId: DESK });
    set.recordHello(DESK, { hostName: "desk.local", hostServer: false });
    set.setAliases(DESK, [
      ["h1", BOX],
      ["h2", `${DESK}~h2`],
    ]);
    set.setLists(DESK, [BOX, `${DESK}~h2`]);
    if (box) {
      set.add(BOX, box.transport, { roomId: BOX });
      set.recordHello(BOX, { hostName: "wsl-box", hostServer: true });
      set.setReachability(BOX, "connected");
    }
    return set;
  }

  it("stamps a lone desktop's answers with its room and its hosts' rooms", async () => {
    const desk = fakeServer({
      "projects.getAll": () => [
        { id: "p0", hostId: "local", name: "Mine" },
        { id: "p1", hostId: "h1", name: "On box" },
        { id: "p2", hostId: "h2", name: "No room" },
      ],
      "layout.getAll": () => ({
        "/a": layoutWith("x"),
        "h1:/b": layoutWith("y"),
        __home__: layoutWith("z"),
      }),
      "layout.getLastActive": () => "h1:/b",
    });
    const api = createRouter(phone(desk), fakeResolver({}));

    expect(await api.projects.getAll()).toEqual([
      { id: "p0", hostId: DESK, name: "Mine" },
      { id: "p1", hostId: BOX, name: "On box" },
      { id: "p2", hostId: `${DESK}~h2`, name: "No room" },
    ]);
    expect(await api.layout.getAll()).toEqual({
      [`${DESK}:/a`]: layoutWith("x"),
      [`${BOX}:/b`]: layoutWith("y"),
      // Home's own pseudo-workspace keeps its name.
      __home__: layoutWith("z"),
    });
    expect(await api.layout.getLastActive()).toBe(`${BOX}:/b`);
  });

  it("sends home its own ids back, and stamps what it answers and pushes", async () => {
    const desk = fakeServer({
      "layout.reportViewport": () => undefined,
      "projects.setGroupLastUsedHost": () => undefined,
      "hosts.list": () => [{ hostId: "h1", status: "connected" }],
    });
    const api = createRouter(phone(desk), fakeResolver({}));

    await api.layout.reportViewport(`${DESK}:/a`, {} as never);
    await api.projects.setGroupLastUsedHost("g", BOX);
    await api.projects.setGroupLastUsedHost("g", `${DESK}~h2`);
    expect(desk.invokes.map((i) => i.args)).toEqual([
      ["/a", {}],
      ["g", "h1"],
      ["g", "h2"],
    ]);
    expect(await api.hosts.list()).toEqual([{ hostId: BOX, status: "connected" }]);

    const seen = vi.fn();
    api.hosts.onStatusChanged(seen);
    desk.emit("hosts.statusChanged", undefined, [{ hostId: "h1", status: "reconnecting" }]);
    expect(seen).toHaveBeenCalledWith([{ hostId: BOX, status: "reconnecting" }]);
  });

  it("watches an open file in home's ids, and stamps the workspace each change names", async () => {
    const desk = fakeServer({ "files.watch": () => undefined });
    const api = createRouter(phone(desk), fakeResolver({}));

    await api.files.watch({ path: "/a", hostId: DESK }, ["src/a.ts"]);
    await api.files.watch({ path: "/b", hostId: BOX }, ["b.ts"]);
    expect(desk.invokes.map((i) => i.args)).toEqual([
      [{ path: "/a", hostId: "local" }, ["src/a.ts"]],
      [{ path: "/b", hostId: "h1" }, ["b.ts"]],
    ]);

    const seen = vi.fn();
    api.files.onChanged(seen);
    desk.emit("files.changed", undefined, {
      workspace: { path: "/a", hostId: "local" },
      path: "src/a.ts",
      hash: "h1",
    });
    desk.emit("files.changed", undefined, {
      workspace: { path: "/b", hostId: "h1" },
      path: "b.ts",
      hash: null,
    });
    expect(seen.mock.calls).toEqual([
      [{ workspace: { path: "/a", hostId: DESK }, path: "src/a.ts", hash: "h1" }],
      [{ workspace: { path: "/b", hostId: BOX }, path: "b.ts", hash: null }],
    ]);
  });

  it("keeps an answer that comes back after its server's hello", async () => {
    let answer: (value: unknown) => void = () => {};
    const desk = fakeServer({
      "agents.getAll": () => new Promise((resolve) => (answer = resolve)),
    });
    const set = phone(desk);
    const api = createRouter(set, fakeResolver({}));
    const read = api.agents.getAll();
    await Promise.resolve();
    // The hello lands while the read is out: the entry is a new object.
    set.recordHello(DESK, { hostName: "renamed", hostServer: false });
    set.setReachability(DESK, "connected");
    answer([{ id: "a", hostId: "local" }]);
    expect(await read).toEqual([{ id: "a", hostId: DESK }]);
  });

  it("hands home only the workspaces of hosts it knows, in its own ids", async () => {
    const desk = fakeServer({ "branches.start": () => undefined });
    const api = createRouter(phone(desk), fakeResolver({}));
    await api.branches.start([
      { path: "/a", hostId: DESK },
      { path: "/b", hostId: BOX },
      { path: "/c", hostId: "OtherRoom0000000000000" },
    ]);
    expect(desk.invokes[0].args).toEqual([
      [
        { path: "/a", hostId: "local" },
        { path: "/b", hostId: "h1" },
      ],
    ]);
  });

  it("answers a host from its own pairing, else from the desktop", async () => {
    const desk = fakeServer({
      "projects.getAll": () => [
        { id: "p0", hostId: "local", name: "Mine" },
        { id: "p1", hostId: "h1", name: "Stale" },
      ],
    });
    const box = fakeServer({
      "projects.getAll": () => [{ id: "p1", hostId: "local", name: "Fresh" }],
      "projects.createWorktree": () => ({ id: "p1", hostId: "local" }),
    });
    const set = phone(desk, box);
    const api = createRouter(
      set,
      fakeResolver({ project: { p0: DESK, p1: BOX }, pane: { "new-pane": BOX } }),
    );

    expect(await api.projects.getAll()).toEqual([
      { id: "p0", hostId: DESK, name: "Mine" },
      { id: "p1", hostId: BOX, name: "Fresh" },
    ]);

    // A launch in the box's workspace goes to the box, in its own form.
    await api.layout.apply(`${BOX}:/w`, { type: "noop" } as never);
    await api.pty.create("new-pane", "/w", 80, 24, { hostId: BOX });
    expect(await api.projects.createWorktree("p1", "feat")).toEqual({ id: "p1", hostId: BOX });
    expect(box.invokes.slice(1).map((i) => [i.key, i.args])).toEqual([
      ["layout.apply", ["/w", { type: "noop" }]],
      ["pty.create", ["new-pane", "/w", 80, 24, { hostId: "local" }]],
      ["projects.createWorktree", ["p1", "feat"]],
    ]);

    // The box's pairing away: the desktop answers for it, in its own ids.
    set.setReachability(BOX, "unreachable");
    await api.layout.apply(`${BOX}:/w`, { type: "noop" } as never);
    expect(desk.invokes[desk.invokes.length - 1]).toEqual({
      key: "layout.apply",
      args: ["h1:/w", { type: "noop" }],
    });
  });

  it("keeps the host's projects live with the desktop away, and refuses its writes", async () => {
    let deskUp = true;
    const desk = fakeServer({
      "projects.getAll": () => {
        if (!deskUp) throw new BridgeDisconnectedError("gone");
        return [{ id: "p0", hostId: "local", name: "Mine" }];
      },
    });
    const box = fakeServer({
      "projects.getAll": () => [{ id: "p1", hostId: "local", name: "Fresh" }],
    });
    const set = phone(desk, box);
    const api = createRouter(set, fakeResolver({ project: { p0: DESK, p1: BOX } }));
    await api.projects.getAll();

    deskUp = false;
    set.setReachability(DESK, "unreachable");
    const calls = desk.invokes.length;
    // Its last answer, without asking it.
    expect(await api.projects.getAll()).toEqual([
      { id: "p0", hostId: DESK, name: "Mine" },
      { id: "p1", hostId: BOX, name: "Fresh" },
    ]);
    expect(desk.invokes).toHaveLength(calls);
    await expect(api.projects.renameWorkspace("p0", `${DESK}:/a`, "x")).rejects.toMatchObject({
      code: UNAVAILABLE_HOST_AWAY_CODE,
      message: "desk.local is offline",
    });
  });

  it("answers from the saved last-known while a server is away after a reload", async () => {
    const saved = new Map<string, Map<string, unknown>>();
    const store = {
      read: vi.fn(async (id: string) => saved.get(id) ?? new Map()),
      write: vi.fn((id: string, memo: string, value: unknown) => {
        const mine = saved.get(id) ?? new Map<string, unknown>();
        mine.set(memo, value);
        saved.set(id, mine);
      }),
      forget: vi.fn((id: string) => void saved.delete(id)),
    };
    const box = fakeServer({
      "projects.getAll": () => [{ id: "p1", hostId: "local", name: "Fresh" }],
    });
    const desk = fakeServer({ "projects.getAll": () => [{ id: "p0", hostId: "local" }] });
    await createRouter(phone(desk, box), fakeResolver({}), { lastKnown: store }).projects.getAll();
    expect(store.write).toHaveBeenCalledWith(BOX, expect.any(String), [
      { id: "p1", hostId: BOX, name: "Fresh" },
    ]);

    // The page reloads with both away.
    const set = phone(fakeServer(), fakeServer());
    set.setReachability(DESK, "unreachable");
    set.setReachability(BOX, "unreachable");
    const api = createRouter(set, fakeResolver({}), { lastKnown: store });
    expect(await api.projects.getAll()).toEqual([
      { id: "p0", hostId: DESK },
      { id: "p1", hostId: BOX, name: "Fresh" },
    ]);

    // A pairing removed takes its saved answers with it.
    set.remove(BOX);
    expect(store.forget).toHaveBeenCalledWith(BOX);
  });

  it("moves home without losing a listener", () => {
    const desk = fakeServer();
    const box = fakeServer();
    const set = createServerSet();
    set.add(BOX, box.transport, { home: true, roomId: BOX });
    set.add(DESK, desk.transport, { roomId: DESK });
    const api = createRouter(set, fakeResolver({}));
    const seen = vi.fn();
    api.agents.onUpdate(seen);
    set.setHome(DESK);
    expect(set.homeId).toBe(DESK);
    desk.emit("agents.updated", undefined, { id: "a", hostId: "local" });
    expect(seen).toHaveBeenCalledWith({ id: "a", hostId: DESK });
  });

  describe("branches and diffs, watched where each workspace lives", () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const watched = [
      { path: "/a", hostId: DESK },
      { path: "/b", hostId: BOX },
      { path: "/c", hostId: `${DESK}~h2` },
    ];
    const invoked = (server: FakeServer, key: string) =>
      server.invokes.filter((i) => i.key === key).map((i) => i.args);

    // Home's own `branches.changed` came back in home's keys,
    // which the phone's store, keyed by room, never matched.
    it("re-keys home's own branch updates into the phone's keys", () => {
      const desk = fakeServer();
      const api = createRouter(phone(desk), fakeResolver({}));
      const changed = vi.fn();
      api.branches.onChange(changed);
      desk.emit("branches.changed", undefined, { "/a": "main", "h1:/b": "feat", "h2:/c": "fix" });
      expect(changed).toHaveBeenLastCalledWith({
        [`${DESK}:/a`]: "main",
        [`${BOX}:/b`]: "feat",
        [`${DESK}~h2:/c`]: "fix",
      });
    });

    it("sends each server only the workspaces it answers for", async () => {
      const desk = fakeServer({ "branches.start": () => undefined });
      const box = fakeServer({ "branches.start": () => undefined });
      const api = createRouter(phone(desk, box), fakeResolver({}));
      await api.branches.start(watched);
      expect(invoked(desk, "branches.start")).toEqual([
        [
          [
            { path: "/a", hostId: "local" },
            { path: "/c", hostId: "h2" },
          ],
        ],
      ]);
      expect(invoked(box, "branches.start")).toEqual([[[{ path: "/b", hostId: "local" }]]]);

      await api.branches.stop();
      expect(invoked(desk, "branches.stop")).toEqual([[]]);
      expect(invoked(box, "branches.stop")).toEqual([[]]);
    });

    it("hears each server's branches under the host-stamped key, merged", () => {
      const desk = fakeServer();
      const box = fakeServer();
      const api = createRouter(phone(desk, box), fakeResolver({}));
      const changed = vi.fn();
      api.branches.onChange(changed);
      box.emit("branches.changed", undefined, { "/b": "feat" });
      expect(changed).toHaveBeenLastCalledWith({ [`${BOX}:/b`]: "feat" });
      // The desktop's copy of the box's workspace is not its to say.
      desk.emit("branches.changed", undefined, { "/a": "main", "h1:/b": "stale" });
      expect(changed).toHaveBeenLastCalledWith({ [`${DESK}:/a`]: "main", [`${BOX}:/b`]: "feat" });
    });

    it("skips an away server, and sends it its share when it comes back", async () => {
      const desk = fakeServer({ "branches.start": () => undefined });
      const box = fakeServer({ "branches.start": () => undefined });
      const set = phone(desk, box);
      set.setReachability(BOX, "unreachable");
      const api = createRouter(set, fakeResolver({}));
      await api.branches.start(watched);
      expect(invoked(box, "branches.start")).toEqual([]);

      set.setReachability(BOX, "connected");
      await flush();
      expect(invoked(box, "branches.start")).toEqual([[[{ path: "/b", hostId: "local" }]]]);
      // The desktop, which stood in for it, lets its workspaces go.
      expect(invoked(desk, "branches.start").slice(-1)[0]).toEqual([
        [
          { path: "/a", hostId: "local" },
          { path: "/c", hostId: "h2" },
        ],
      ]);
    });

    it("gives an older host server's workspaces to the desktop that lists it", async () => {
      const desk = fakeServer({ "branches.start": () => undefined });
      const box = fakeServer({
        "branches.start": () => {
          throw new BridgeUnavailableError("no", UNAVAILABLE_HOST_CODE);
        },
      });
      const api = createRouter(phone(desk, box), fakeResolver({}));
      const changed = vi.fn();
      api.branches.onChange(changed);
      await api.branches.start(watched);
      await flush();
      expect(invoked(desk, "branches.start").slice(-1)[0]).toEqual([
        [
          { path: "/a", hostId: "local" },
          { path: "/b", hostId: "h1" },
          { path: "/c", hostId: "h2" },
        ],
      ]);
      desk.emit("branches.changed", undefined, { "h1:/b": "feat" });
      expect(changed).toHaveBeenLastCalledWith({ [`${BOX}:/b`]: "feat" });
    });

    it("moves a desktop window's host workspaces to that host's bridge when it joins", async () => {
      const home = fakeServer({ "branches.start": () => undefined });
      const box = fakeServer({ "branches.start": () => undefined });
      const set = createServerSet();
      set.add("local", home.transport, { home: true, lists: "all" });
      const api = createRouter(set, fakeResolver({}));
      const list = [
        { path: "/a", hostId: "local" },
        { path: "/b", hostId: "box" },
      ];
      await api.branches.start(list);
      expect(invoked(home, "branches.start")).toEqual([[list]]);

      set.add("box", box.transport, { capabilities: ["viewer-bridge"] });
      set.recordHello("box", { hostName: "wsl-box", hostServer: true });
      set.setReachability("box", "connected");
      await flush();
      expect(invoked(box, "branches.start")).toEqual([[[{ path: "/b", hostId: "local" }]]]);
      expect(invoked(home, "branches.start").slice(-1)[0]).toEqual([[{ path: "/a", hostId: "local" }]]);
    });

    it("does the same for diffs", async () => {
      const desk = fakeServer({ "diffs.start": () => undefined });
      const box = fakeServer({ "diffs.start": () => undefined });
      const set = phone(desk, box);
      set.setReachability(BOX, "unreachable");
      const api = createRouter(set, fakeResolver({}));
      const changed = vi.fn();
      const fingerprints = vi.fn();
      api.diffs.onChange(changed);
      api.diffs.onFingerprintsChange(fingerprints);

      await api.diffs.start(watched.map((ws) => ({ ...ws, defaultBranch: "main" })));
      expect(invoked(box, "diffs.start")).toEqual([]);
      set.setReachability(BOX, "connected");
      await flush();
      expect(invoked(box, "diffs.start")).toEqual([
        [[{ path: "/b", hostId: "local", defaultBranch: "main" }]],
      ]);
      expect(invoked(desk, "diffs.start").slice(-1)[0]).toEqual([
        [
          { path: "/a", hostId: "local", defaultBranch: "main" },
          { path: "/c", hostId: "h2", defaultBranch: "main" },
        ],
      ]);

      box.emit("diffs.changed", undefined, { "/b": { added: 1, removed: 2 } });
      desk.emit("diffs.changed", undefined, { "/a": { added: 3, removed: 0 } });
      expect(changed).toHaveBeenLastCalledWith({
        [`${DESK}:/a`]: { added: 3, removed: 0 },
        [`${BOX}:/b`]: { added: 1, removed: 2 },
      });
      box.emit("diffs.fingerprintsChange", undefined, { "/b": "f1" });
      expect(fingerprints).toHaveBeenLastCalledWith({ [`${BOX}:/b`]: "f1" });
    });
  });
});

describe("the selected project on the merged list", () => {
  const DESK = "DeskRoom0000000000000a";
  const BOX = "BoxRoom00000000000000b";

  function setup() {
    const added: unknown[] = [];
    const desk = fakeServer({
      // `x` is the box's, which the box answers for, so the merged list
      // drops it and `b` sits one place earlier than in home's own list.
      "projects.getAll": () => [
        { id: "x", hostId: "h1" },
        { id: "a", hostId: "local" },
        { id: "b", hostId: "local" },
        ...added,
      ],
      "projects.getSelectedIndex": () => 2,
      "projects.select": undefined,
    });
    const box = fakeServer({ "projects.getAll": () => [{ id: "c", hostId: "local" }] });
    const set = createServerSet();
    set.add(DESK, desk.transport, { home: true, roomId: DESK });
    set.recordHello(DESK, { hostName: "desk.local", hostServer: false });
    set.setAliases(DESK, [["h1", BOX]]);
    set.setLists(DESK, [BOX]);
    set.add(BOX, box.transport, { roomId: BOX });
    set.recordHello(BOX, { hostName: "wsl-box", hostServer: true });
    set.setReachability(BOX, "connected");
    return { desk, added, api: createRouter(set, fakeResolver({})) };
  }

  const ids = async (api: ReturnType<typeof setup>["api"]) =>
    ((await api.projects.getAll()) as Array<{ id: string }>).map((p) => p.id);

  it("maps home's selected index to the merged index", async () => {
    const { api } = setup();
    const order = await ids(api);
    expect(await api.projects.getSelectedIndex()).toBe(order.indexOf("b"));
  });

  it("sends home its own index for a merged one", async () => {
    const { api, desk } = setup();
    const order = await ids(api);
    await api.projects.select(order.indexOf("b"));
    const sent = desk.invokes.filter((i) => i.key === "projects.select");
    expect(sent.map((i) => i.args)).toEqual([[2]]);
  });

  it("keeps a project home lacks selected on the page only", async () => {
    const { api, desk } = setup();
    const order = await ids(api);
    await api.projects.select(order.indexOf("c"));
    expect(desk.invokes.some((i) => i.key === "projects.select")).toBe(false);
    expect(await api.projects.getSelectedIndex()).toBe(order.indexOf("c"));
  });

  it("follows a page-only project when the merged list shifts", async () => {
    const { api, added } = setup();
    const before = await ids(api);
    await api.projects.select(before.indexOf("c"));
    added.push({ id: "n", hostId: "local" });
    const after = await ids(api);
    expect(after.indexOf("c")).not.toBe(before.indexOf("c"));
    expect(await api.projects.getSelectedIndex()).toBe(after.indexOf("c"));
  });

  it("passes the index through for a desktop with no direct bridges", async () => {
    const desk = fakeServer({
      "projects.getAll": () => [{ id: "a", hostId: "local" }],
      "projects.getSelectedIndex": () => 3,
      "projects.select": undefined,
    });
    const set = createServerSet();
    set.add("local", desk.transport, { home: true, lists: "all" });
    const api = createRouter(set, fakeResolver({}));
    expect(await api.projects.getSelectedIndex()).toBe(3);
    await api.projects.select(5);
    expect(desk.invokes.filter((i) => i.key === "projects.select")[0].args).toEqual([5]);
  });
});

describe("GitHub calls follow the repo's host", () => {
  it("send a repo's calls to its host's source, and a local repo's home", async () => {
    const home = fakeServer({ "github.getMyIssues": "home", "github.checkStatus": "home" });
    const box = fakeServer({ "github.getMyIssues": [], "github.checkStatus": { installed: true } });
    const api = createRouter(desktopWithHost(home, box), storeResolver);

    await api.github.getMyIssues({ path: "/r", hostId: "box" }, 1);
    await api.github.checkStatus("box");
    expect(box.invokes.map((i) => i.key)).toEqual(["github.getMyIssues", "github.checkStatus"]);
    expect(box.invokes[0].args).toEqual([{ path: "/r", hostId: "local" }, 1]);

    await api.github.getMyIssues({ path: "/r", hostId: "local" }, 1);
    await api.github.checkStatus(undefined);
    expect(home.invokes.map((i) => i.key)).toEqual(["github.getMyIssues", "github.checkStatus"]);
  });
});

describe("Linear calls pick their server per call", () => {
  const calls = (server: FakeServer) =>
    server.invokes.filter((i) => i.key === "linear.getViewer").length;

  it("go to the host's own server when it has Linear connected", async () => {
    const home = fakeServer({ "linear.isConnected": true, "linear.getViewer": "home" });
    const box = fakeServer({ "linear.isConnected": true, "linear.getViewer": "box" });
    const api = createRouter(desktopWithHost(home, box), fakeResolver({}));

    expect(await onBehalfOf("box", () => api.linear.getViewer())).toBe("box");
    expect(calls(home)).toBe(0);
  });

  it("fall to the desktop that lists the host when the host has none", async () => {
    const home = fakeServer({ "linear.isConnected": true, "linear.getViewer": "home" });
    const box = fakeServer({ "linear.isConnected": false, "linear.getViewer": "box" });
    const api = createRouter(desktopWithHost(home, box), fakeResolver({}));

    expect(await onBehalfOf("box", () => api.linear.getViewer())).toBe("home");
    expect(calls(box)).toBe(0);
  });

  it("refuse with a stated reason when neither has Linear", async () => {
    const home = fakeServer({ "linear.isConnected": false });
    const box = fakeServer({ "linear.isConnected": false });
    const api = createRouter(desktopWithHost(home, box), fakeResolver({}));

    const refused = onBehalfOf("box", () => api.linear.getViewer());
    await expect(refused).rejects.toBeInstanceOf(BridgeUnavailableError);
    await expect(refused).rejects.toThrow(
      "Linear isn't turned on for wsl-box, and Linear isn't connected on This Mac",
    );
    expect(calls(home) + calls(box)).toBe(0);
  });

  it("name a desktop that is away in the refusal", async () => {
    const desk = fakeServer({ "linear.isConnected": true });
    const box = fakeServer({ "linear.isConnected": false });
    const set = createServerSet();
    set.add("deskroom", desk.transport, { home: true, lists: "all", roomId: "deskroom" });
    set.recordHello("deskroom", { hostName: "mac", hostServer: false });
    set.add("boxroom", box.transport, { roomId: "boxroom" });
    set.recordHello("boxroom", { hostName: "wsl-box", hostServer: true });
    set.setReachability("boxroom", "connected");
    set.setReachability("deskroom", "unreachable");
    const api = createRouter(set, fakeResolver({}));

    await expect(onBehalfOf("boxroom", () => api.linear.getViewer())).rejects.toThrow(
      "Linear isn't turned on for wsl-box, and mac is away",
    );
  });

  it("try home first with no host, then any server with Linear", async () => {
    const home = fakeServer({ "linear.isConnected": true, "linear.getViewer": "home" });
    const box = fakeServer({ "linear.isConnected": true, "linear.getViewer": "box" });
    expect(await createRouter(desktopWithHost(home, box), fakeResolver({})).linear.getViewer()).toBe("home");

    const bare = fakeServer({ "linear.isConnected": false, "linear.getViewer": "home" });
    const holder = fakeServer({ "linear.isConnected": true, "linear.getViewer": "box" });
    const api = createRouter(desktopWithHost(bare, holder), fakeResolver({}));
    expect(await api.linear.getViewer()).toBe("box");
  });

  it("ask a server again once it says hello again", async () => {
    let on = false;
    const home = fakeServer({ "linear.isConnected": false, "linear.getViewer": "home" });
    const box = fakeServer({ "linear.isConnected": () => on, "linear.getViewer": "box" });
    const set = desktopWithHost(home, box);
    const api = createRouter(set, fakeResolver({}));

    await expect(onBehalfOf("box", () => api.linear.getViewer())).rejects.toThrow("wsl-box");
    // The host is turned on, drops and comes back: its hello refreshes the cache.
    on = true;
    set.setReachability("box", "unreachable");
    set.setReachability("box", "connected");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await onBehalfOf("box", () => api.linear.getViewer())).toBe("box");
  });

  it("write each auto-matched team to its project's own server", async () => {
    // A phone whose home is the host's room; the desktop is paired too.
    const team = (key: string) => ({ teamId: key, teamName: key, teamKey: key });
    const box = fakeServer({
      "linear.isConnected": true,
      "linear.autoMatch": { pd: team("D"), pb: team("B") },
      "linear.associateProject": true,
    });
    const desk = fakeServer({ "linear.isConnected": false, "linear.associateProject": true });
    const set = createServerSet();
    set.add("boxroom", box.transport, { home: true, roomId: "boxroom" });
    set.recordHello("boxroom", { hostName: "wsl-box", hostServer: true });
    set.add("deskroom", desk.transport, { lists: "all", roomId: "deskroom" });
    set.recordHello("deskroom", { hostName: "mac", hostServer: false });
    set.setReachability("boxroom", "connected");
    set.setReachability("deskroom", "connected");
    const api = createRouter(set, fakeResolver({ project: { pd: "deskroom", pb: "boxroom" } }));
    const project = (id: string, hostId: string) =>
      ({ id, name: id, hostId, linearAssociations: [], workspaces: [] }) as unknown as ProjectInfo;

    const count = await autoMatchLinearTeams([project("pd", "deskroom"), project("pb", "boxroom")], api);

    expect(count).toBe(2);
    // The host answered the match, and wrote only its own project.
    expect(box.invokes.map((i) => [i.key, i.args])).toEqual([
      ["linear.isConnected", []],
      ["linear.autoMatch", [[{ id: "pd", name: "pd" }, { id: "pb", name: "pb" }]]],
      ["linear.associateProject", ["pb", team("B")]],
    ]);
    expect(desk.invokes.filter((i) => i.key === "linear.associateProject").map((i) => i.args)).toEqual([
      ["pd", team("D")],
    ]);
  });

  it("keep linking an issue to its project's host", async () => {
    const home = fakeServer({});
    const box = fakeServer({ "linear.linkIssueToWorkspace": "ok" });
    const api = createRouter(desktopWithHost(home, box), fakeResolver({ project: { p1: "box" } }));
    await api.linear.linkIssueToWorkspace("p1", "box:/w", {} as never);
    expect(box.invokes.map((i) => i.key)).toEqual(["linear.linkIssueToWorkspace"]);
  });
});

describe("the router waking a sleeping host", () => {
  /** `fakeResolver` with `box` asleep until `wake` says otherwise. */
  function sleepyResolver(maps: Parameters<typeof fakeResolver>[0]) {
    const asleep = new Set(["box"]);
    return {
      resolver: { ...fakeResolver(maps), asleep: (hostId: string) => asleep.has(hostId) },
      awake: () => asleep.delete("box"),
    };
  }

  it("asks home to wake the host, then sends a write to the host's own bridge", async () => {
    const box = fakeServer({ "projects.createWorktree": { ok: true } });
    const order: string[] = [];
    const sets: ServerSet[] = [];
    const { resolver, awake } = sleepyResolver({ project: { p1: "box" } });
    const home = fakeServer({
      "hosts.wake": async () => {
        order.push("wake");
        awake();
        // The host's own bridge redials a moment after home says it is up.
        setTimeout(() => sets[0].setReachability("box", "connected"), 5);
      },
    });
    const set = desktopWithHost(home, box);
    sets.push(set);
    set.setReachability("box", "unreachable");
    const api = createRouter(set, resolver);

    const answer = await api.projects.createWorktree("p1", "feature");

    expect(home.invokes.map((i) => i.key)).toEqual(["hosts.wake"]);
    expect(home.invokes[0].args).toEqual(["box"]);
    expect(box.invokes.map((i) => i.key)).toEqual(["projects.createWorktree"]);
    expect(answer).toEqual({ ok: true });
    expect(order).toEqual(["wake"]);
  });

  it("wakes through home even when home alone is in the set", async () => {
    const home = fakeServer({ "hosts.wake": undefined, "pty.create": { ok: true } });
    const set = createServerSet();
    set.add("local", home.transport, { home: true, lists: "all" });
    const { resolver } = sleepyResolver({ pane: { "pane-1": "box" } });
    const api = createRouter(set, resolver);

    await api.pty.create("pane-1", "/w", 80, 24, { hostId: "box" });

    expect(home.invokes.map((i) => i.key)).toEqual(["hosts.wake", "pty.create"]);
  });

  it("leaves the host asleep for a create or attach that declines to wake", async () => {
    const home = fakeServer({ "hosts.wake": undefined, "pty.create": { ok: true } });
    const set = createServerSet();
    set.add("local", home.transport, { home: true, lists: "all" });
    const { resolver } = sleepyResolver({ pane: { "pane-1": "box" } });
    const api = createRouter(set, resolver);

    const created = await api.pty.create("pane-1", "/w", 80, 24, { hostId: "box", wake: false });
    const attached = await api.pty.attach("pane-1", { wake: false });

    expect(home.invokes).toEqual([]);
    for (const answer of [created, attached]) {
      expect(answer).toMatchObject({ ok: false, reason: "host-unavailable", hostId: "box" });
    }
  });

  it("never wakes the host for a read", async () => {
    const box = fakeServer();
    const home = fakeServer({ "projects.listLocalBranches": ["main"] });
    const set = desktopWithHost(home, box);
    set.setReachability("box", "unreachable");
    const { resolver } = sleepyResolver({ project: { p1: "box" } });
    const api = createRouter(set, resolver);

    await api.projects.listLocalBranches("p1");

    expect(home.invokes.map((i) => i.key)).toEqual(["projects.listLocalBranches"]);
  });

  it("shares one wake between calls that find the host asleep together", async () => {
    let finish!: () => void;
    const home = fakeServer({
      "hosts.wake": () => new Promise<void>((resolve) => (finish = resolve)),
      "projects.renameWorkspace": undefined,
    });
    const set = createServerSet();
    set.add("local", home.transport, { home: true, lists: "all" });
    const { resolver } = sleepyResolver({ project: { p1: "box" } });
    const api = createRouter(set, resolver);

    const a = api.projects.renameWorkspace("p1", "/w", "a");
    const b = api.projects.renameWorkspace("p1", "/w", "b");
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish();
    await Promise.all([a, b]);

    expect(home.invokes.filter((i) => i.key === "hosts.wake")).toHaveLength(1);
  });

  it("says it is waking the host, once per wake, for the toast", async () => {
    let finish!: () => void;
    const home = fakeServer({
      "hosts.wake": () => new Promise<void>((resolve) => (finish = resolve)),
      "projects.renameWorkspace": undefined,
    });
    const set = createServerSet();
    set.add("local", home.transport, { home: true, lists: "all" });
    const { resolver } = sleepyResolver({ project: { p1: "box" } });
    const waking = vi.fn();
    const api = createRouter(set, { ...resolver, waking });

    const a = api.projects.renameWorkspace("p1", "/w", "a");
    const b = api.projects.renameWorkspace("p1", "/w", "b");
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(waking).toHaveBeenCalledTimes(1);
    expect(waking.mock.calls[0][0]).toBe("box");
    let settled = false;
    void (waking.mock.calls[0][1] as Promise<void>).then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await Promise.all([a, b]);
    expect(settled).toBe(true);
  });
});
