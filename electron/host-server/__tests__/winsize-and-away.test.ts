import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Caller } from "../../bridge/method";
import {
  FOREIGN_CONNECTION_ID,
  attach,
  onAttachmentChange,
  ownerOf,
  release,
  resetAttachments,
  setForeign,
} from "../../pty-attachments";
import type { LayoutEntry } from "../../../src/lib/layout/protocol";
import type { SessionInfo } from "../../terminal-host/types";
import { HOST_TABLE, type HostServerDeps } from "../handlers";
import {
  STARTED_WHILE_AWAY_TITLE,
  withStartedWhileAway,
  missingSessions,
} from "../started-while-away";
import { createHostWinsize, hasOtherClients } from "../winsize";

const device = {
  id: "phone-1",
  callerClass: "device",
  deviceId: "d1",
  deviceLabel: "phone",
} as unknown as Caller;
const owner: Caller = {
  id: "desktop",
  callerClass: "owner",
  deviceId: null,
  deviceLabel: null,
} as unknown as Caller;

type Handler = (ctx: unknown, ...args: unknown[]) => unknown;
const handler = (key: string): Handler =>
  HOST_TABLE.handlers[key] as unknown as Handler;

function session(
  sessionId: string,
  attachedClients: number | undefined,
  cwd = "/ws/a",
): SessionInfo {
  return { sessionId, cwd, cols: 100, rows: 30, alive: true, attachedClients };
}

function entryWith(paneId: string, panelId = "p1"): LayoutEntry {
  return {
    version: 3,
    layout: {
      panelTree: { type: "leaf", panelId },
      panels: {
        [panelId]: {
          id: panelId,
          pinnedTabIds: [],
          tabs: [
            {
              id: "t1",
              title: "shell",
              rootNode: { type: "leaf", paneId, contentType: "terminal" },
            },
          ],
        },
      },
    },
    defaultViewport: { activePanelId: null, selectedTabIds: {}, focusedPaneIds: {} },
    paneSessions: { [paneId]: { daemonSessionId: paneId, lastCwd: null, lastTitle: null } },
    claims: [],
  };
}

describe("hasOtherClients", () => {
  it("excludes this server's own socket, and unknown is someone else", () => {
    expect(hasOtherClients(1, 1)).toBe(false);
    expect(hasOtherClients(2, 1)).toBe(true);
    expect(hasOtherClients(0, 0)).toBe(false);
    expect(hasOtherClients(1, 0)).toBe(true);
    expect(hasOtherClients(undefined, 1)).toBe(true);
    expect(hasOtherClients(undefined, 0)).toBe(true);
  });
});

describe("host pty.create winsize (ADR-225 D5)", () => {
  let sessions: SessionInfo[];
  let createOrAttach: ReturnType<typeof vi.fn>;
  let watched: Array<[string, number | undefined]>;
  let deps: HostServerDeps;
  let winsize: ReturnType<typeof createHostWinsize>;

  beforeEach(() => {
    resetAttachments();
    sessions = [];
    watched = [];
    winsize = createHostWinsize({ listSessions: async () => sessions });
    createOrAttach = vi.fn(async () => ({ snapshot: null }));
    deps = {
      backend: {
        pty: {
          listSessions: async () => sessions,
          createOrAttach,
          attachExisting: vi.fn(async (id: string) =>
            sessions.some((s) => s.sessionId === id && s.alive)
              ? { screenAnsi: "$ ", seq: 7, cols: 90, rows: 20 }
              : null,
          ),
          getSnapshot: async () => ({ cols: 90, rows: 20 }),
          write: vi.fn(),
          resize: vi.fn(async () => {}),
          detach: vi.fn(async () => {}),
        },
      },
      winsize: {
        watch: (id: string, attachedClients: number | undefined) => {
          watched.push([id, attachedClients]);
          winsize.watch(id, attachedClients);
        },
        dispose: () => winsize.dispose(),
      },
    } as unknown as HostServerDeps;
  });
  afterEach(() => {
    winsize.dispose();
    resetAttachments();
  });

  const create = (caller: Caller, paneId = "pane-1") =>
    handler("pty.create")({ deps, caller }, paneId, null, 120, 40);

  it("owns the winsize when only this server is attached, and sizes the session", async () => {
    sessions = [session("pane-1", 0)];
    expect(await create(device)).toMatchObject({
      ok: true,
      winsizeOwner: true,
      cols: 120,
      rows: 40,
    });
    expect(createOrAttach).toHaveBeenCalledWith("pane-1", expect.anything(), 120, 40);
  });

  it("is a follower when another client is attached, and does not resize", async () => {
    sessions = [session("pane-1", 1)];
    expect(await create(device)).toMatchObject({
      ok: true,
      winsizeOwner: false,
      cols: 90,
      rows: 20,
    });
    expect(createOrAttach).toHaveBeenCalledWith("pane-1", expect.anything(), 90, 20);
    expect(watched).toEqual([["pane-1", 1]]);
    expect(ownerOf("pane-1")?.connectionId).toBe(FOREIGN_CONNECTION_ID);
  });

  it("is a follower when an old daemon reports no count", async () => {
    sessions = [session("pane-1", undefined)];
    expect(await create(device)).toMatchObject({ ok: true, winsizeOwner: false });
  });

  it("does not count its own subscription once a device already holds the pane", async () => {
    sessions = [session("pane-1", 0)];
    await create(device);
    // A second phone: the daemon now shows one socket, this server's own.
    sessions = [session("pane-1", 1)];
    const second = await create({ ...device, id: "phone-2" } as Caller);
    expect(second).toMatchObject({ ok: true, winsizeOwner: true });
    // The daemon shows a desktop as well.
    sessions = [session("pane-1", 2)];
    const third = await create({ ...device, id: "phone-3" } as Caller);
    expect(third).toMatchObject({ winsizeOwner: false });
  });

  const reattach = (caller: Caller, paneId = "pane-1") =>
    handler("pty.attach")({ deps, caller }, paneId);

  it("re-attaches a returning device without taking the winsize, and never spawns", async () => {
    sessions = [session("pane-1", 0)];
    await create(device);
    const other = { ...device, id: "phone-2" } as Caller;
    await create(other);
    release("pane-1", { connectionId: device.id, callerClass: "device" });
    // The first phone comes back: the second keeps the grid it fitted to.
    expect(await reattach(device)).toEqual({
      ok: true,
      hostId: "local",
      snapshot: "$ ",
      snapshotSeq: 7,
      winsizeOwner: false,
      cols: 90,
      rows: 20,
    });
    expect(ownerOf("pane-1")?.connectionId).toBe("phone-2");
    expect(createOrAttach).toHaveBeenCalledTimes(2);
  });

  it("answers exited for a session that is gone", async () => {
    expect(await reattach(device)).toEqual({ ok: false, reason: "exited" });
  });

  it("ranks the owner channel with a device, not as a local viewer", async () => {
    sessions = [session("pane-1", 0)];
    await create(device);
    sessions = [session("pane-1", 1)];
    expect(await create(owner)).toMatchObject({ winsizeOwner: true });
    expect(ownerOf("pane-1")).toMatchObject({
      connectionId: "desktop",
      callerClass: "owner",
    });
    // A `local` arrival would have outranked it; a device among equals does.
    const third = await create({ ...device, id: "phone-2" } as Caller);
    expect(third).toMatchObject({ winsizeOwner: true });
  });

  it("drops a device's resize and claim while another client holds the pane", async () => {
    sessions = [session("pane-1", 1)];
    await create(device);
    await handler("pty.resize")({ deps, caller: device }, "pane-1", 50, 10);
    expect(deps.backend.pty.resize).not.toHaveBeenCalled();
    expect(
      handler("pty.claimWinsize")({ deps, caller: device }, "pane-1"),
    ).toBe(false);

    setForeign("pane-1", false);
    await handler("pty.resize")({ deps, caller: device }, "pane-1", 50, 10);
    expect(deps.backend.pty.resize).toHaveBeenCalledWith("pane-1", 50, 10);
  });
});

describe("createHostWinsize poll", () => {
  beforeEach(() => {
    resetAttachments();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetAttachments();
  });

  const phone = { connectionId: "phone-1", callerClass: "device" } as const;
  const isForeign = (paneId: string) =>
    ownerOf(paneId)?.connectionId === FOREIGN_CONNECTION_ID;

  /** Panes the registry told its sinks about, as the bridge server hears them. */
  function listen(): { changed: string[]; stop: () => void } {
    const changed: string[] = [];
    const stop = onAttachmentChange((paneId) => changed.push(paneId));
    return { changed, stop };
  }

  it("pushes when another client arrives or leaves, and stops once nothing is held", async () => {
    let count: number | undefined = 0;
    const w = createHostWinsize({
      listSessions: async () => [session("pane-1", count)],
      intervalMs: 2000,
    });
    w.watch("pane-1", count);
    attach("pane-1", phone);
    count = 1; // this server's own subscription
    const { changed, stop } = listen();

    await vi.advanceTimersByTimeAsync(2000);
    expect(changed).toEqual([]);

    count = 2; // the desktop attached
    await vi.advanceTimersByTimeAsync(2000);
    expect(changed).toEqual(["pane-1"]);
    expect(isForeign("pane-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(2000); // unchanged: quiet
    expect(changed).toHaveLength(1);

    count = 1; // it left
    await vi.advanceTimersByTimeAsync(2000);
    expect(changed).toEqual(["pane-1", "pane-1"]);
    expect(ownerOf("pane-1")).toEqual(phone);

    release("pane-1", phone);
    await vi.advanceTimersByTimeAsync(2000);
    expect(vi.getTimerCount()).toBe(0);
    stop();
    w.dispose();
  });

  it("keeps an old daemon's follower answer and does not flap", async () => {
    const w = createHostWinsize({
      listSessions: async () => [session("pane-1", undefined)],
    });
    w.watch("pane-1", undefined);
    attach("pane-1", phone);
    const { changed, stop } = listen();
    await vi.advanceTimersByTimeAsync(6000);
    expect(changed).toEqual([]);
    expect(isForeign("pane-1")).toBe(true);
    stop();
    w.dispose();
  });

  it("lets go of the hold once nobody here holds the pane, and on dispose", async () => {
    const w = createHostWinsize({
      listSessions: async () => [session("pane-1", 2)],
    });
    w.watch("pane-1", 2);
    attach("pane-1", phone);
    expect(isForeign("pane-1")).toBe(true);
    release("pane-1", phone);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ownerOf("pane-1")).toBeNull();

    w.watch("pane-2", undefined);
    expect(isForeign("pane-2")).toBe(true);
    w.dispose();
    expect(ownerOf("pane-2")).toBeNull();
  });
});

describe("Started while away (ADR-225 D5)", () => {
  const paths = ["/ws/a", "/ws/a/sub", "/ws/b"];

  it("appends a missing live session to the workspace it runs in", () => {
    const snapshot = { "/ws/a": entryWith("known") };
    const missing = missingSessions(snapshot, [
      session("known", 1),
      session("new-1", 0, "/ws/a/src"),
      { ...session("dead", 0), alive: false },
    ]);
    expect(missing.map((s) => s.sessionId)).toEqual(["new-1"]);

    const out = withStartedWhileAway(snapshot, missing, paths);
    const tabs = out["/ws/a"].layout.panels.p1.tabs;
    expect(tabs.map((t) => t.title)).toEqual(["shell", STARTED_WHILE_AWAY_TITLE]);
    expect(tabs[1].rootNode).toMatchObject({ type: "leaf", paneId: "new-1" });
    expect(out["/ws/a"].paneSessions["new-1"].daemonSessionId).toBe("new-1");
    // The input is untouched.
    expect(snapshot["/ws/a"].layout.panels.p1.tabs).toHaveLength(1);
  });

  it("uses the longest workspace path and ignores sessions outside every workspace", () => {
    const out = withStartedWhileAway(
      {},
      [session("s1", 0, "/ws/a/sub/x"), session("s2", 0, "/elsewhere")],
      paths,
    );
    expect(Object.keys(out)).toEqual(["/ws/a/sub"]);
  });

  it("has stable ids across calls", () => {
    const snapshot = { "/ws/a": entryWith("known") };
    const sessions = [session("n2", 0), session("n1", 0)];
    const first = withStartedWhileAway(snapshot, missingSessions(snapshot, sessions), paths);
    const second = withStartedWhileAway(
      snapshot,
      missingSessions(snapshot, [...sessions].reverse()),
      paths,
    );
    expect(second).toEqual(first);
    const tab = first["/ws/a"].layout.panels.p1.tabs[1];
    expect(tab.id).toBe("away:/ws/a");
    expect(tab.rootNode).toMatchObject({ type: "split", first: { paneId: "n1" } });
  });

  it("builds a panel per workspace with live sessions when there is no snapshot", () => {
    const out = withStartedWhileAway(
      {},
      [session("s1", 0, "/ws/a"), session("s2", 0, "/ws/b")],
      paths,
    );
    expect(Object.keys(out).sort()).toEqual(["/ws/a", "/ws/b"]);
    const panel = out["/ws/b"].layout.panels["away-panel:/ws/b"];
    expect(panel.tabs).toHaveLength(1);
    expect(panel.tabs[0].title).toBe(STARTED_WHILE_AWAY_TITLE);
  });

  it("is served by layout.getAll, and falls back to the bare snapshot when git fails", async () => {
    const snapshot = { "/ws/a": entryWith("known") };
    const deps = {
      layout: () => ({ workspaces: snapshot, lastActiveWorkspacePath: null }),
      backend: {
        pty: { listSessions: async () => [session("known", 1), session("new-1", 0)] },
      },
      projects: async () => [{ workspaces: [{ path: "/ws/a" }] }],
    } as unknown as HostServerDeps;
    const out = (await handler("layout.getAll")({
      deps,
      caller: device,
    })) as Record<string, LayoutEntry>;
    expect(out["/ws/a"].layout.panels.p1.tabs).toHaveLength(2);

    const broken = {
      ...deps,
      projects: async () => {
        throw new Error("git");
      },
    } as unknown as HostServerDeps;
    expect(
      await handler("layout.getAll")({ deps: broken, caller: device }),
    ).toBe(snapshot);
  });

  it("refuses every layout write from a device with the named state", () => {
    for (const key of [
      "layout.apply",
      "layout.save",
      "layout.setPaneTitle",
      "layout.setPendingCommand",
      "layout.reportViewport",
    ]) {
      expect(HOST_TABLE.handlers[key]).toBeUndefined();
    }
  });
});
