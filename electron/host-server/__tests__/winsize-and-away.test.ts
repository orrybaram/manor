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
import type { SessionInfo } from "../../terminal-host/types";
import { BridgeUnavailableRefusal, UNAVAILABLE_HOST_CODE } from "../../bridge/types";
import { HOST_TABLE, type HostServerDeps } from "../handlers";
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
  let createOrAttachWith: ReturnType<typeof vi.fn>;
  let watched: Array<[string, number | undefined]>;
  let deps: HostServerDeps;
  let winsize: ReturnType<typeof createHostWinsize>;

  beforeEach(() => {
    resetAttachments();
    sessions = [];
    watched = [];
    winsize = createHostWinsize({ listSessions: async () => sessions });
    // The shared `pty.create` spawns through `createOrAttachWith` (ADR-227
    // D6); a session the daemon already runs answers with its snapshot.
    createOrAttachWith = vi.fn(async (id: string) => ({
      snapshot: sessions.some((s) => s.sessionId === id && s.alive)
        ? { screenAnsi: "$ ", seq: 7 }
        : null,
      hostId: "local",
    }));
    deps = {
      backend: {
        pty: {
          listSessions: async () => sessions,
          createOrAttachWith,
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
    expect(createOrAttachWith).toHaveBeenCalledWith(
      "pane-1",
      expect.anything(),
      120,
      40,
      expect.anything(),
    );
  });

  it("is a follower when another client is attached, and does not resize", async () => {
    sessions = [session("pane-1", 1)];
    expect(await create(device)).toMatchObject({
      ok: true,
      winsizeOwner: false,
      cols: 90,
      rows: 20,
    });
    expect(createOrAttachWith).toHaveBeenCalledWith(
      "pane-1",
      expect.anything(),
      90,
      20,
      expect.anything(),
    );
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
    expect(createOrAttachWith).toHaveBeenCalledTimes(2);
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

describe("layout writes on the host (ADR-227 D6)", () => {
  const writes = [
    "layout.apply",
    "layout.setPaneTitle",
    "layout.setPendingCommand",
    "layout.reportViewport",
  ];

  it("lists every layout write but `save`, which no server has", () => {
    for (const key of writes) expect(HOST_TABLE.handlers[key]).toBeDefined();
    expect(HOST_TABLE.handlers["layout.save"]).toBeUndefined();
  });

  it("refuses each with the named state until the host is adopted, then runs it", async () => {
    let ownership: "pending" | "host" = "pending";
    const apply = vi.fn(async () => ({ version: 1 }));
    const deps = {
      ownership: { current: () => ownership },
      layoutStore: {
        apply,
        setPaneTitle: vi.fn(),
        reportViewport: vi.fn(),
        pendingCommands: { set: vi.fn() },
      },
    } as unknown as HostServerDeps;
    const args: Record<string, unknown[]> = {
      "layout.apply": ["/ws/a", { type: "new-tab", tab: {} }],
      "layout.setPaneTitle": ["pane-1", "title"],
      "layout.setPendingCommand": ["pane-1", "claude", "agent-startup"],
      "layout.reportViewport": ["/ws/a", {}],
    };
    for (const key of writes) {
      let refusal: unknown;
      try {
        await handler(key)({ deps, caller: device }, ...args[key]);
      } catch (err) {
        refusal = err;
      }
      expect(refusal, key).toBeInstanceOf(BridgeUnavailableRefusal);
      expect(refusal).toMatchObject({
        code: UNAVAILABLE_HOST_CODE,
        message: "This host is being set up",
      });
    }
    expect(apply).not.toHaveBeenCalled();

    ownership = "host";
    await handler("layout.apply")({ deps, caller: device }, ...args["layout.apply"]);
    expect(apply).toHaveBeenCalledWith(
      "/ws/a",
      { type: "new-tab", tab: {} },
      expect.objectContaining({ id: "phone-1" }),
    );
  });
});
