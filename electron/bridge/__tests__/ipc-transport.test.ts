/**
 * The desktop transport and the door in front of it (ADR-180 D2/D3).
 *
 * Two halves, one file, because they are two ends of the same four channels:
 * `IpcBridgeTransport` on the main side, and the `window.manorHost` the
 * preload exposes on the renderer side. Both run against a fake `electron`,
 * which is what a transport made of `ipcMain.handle` and `webContents.send`
 * can be tested against at all.
 *
 * The property this file exists for is the sender check. Everything else here
 * would show up as a broken feature the first time someone ran the app; a
 * `<webview>` guest that can reach `bridge:invoke` would show up as nothing
 * at all until it was used.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MockInstance } from "vitest";

import type { IpcDeps } from "../../ipc/types";
import { resetAttachments } from "../../pty-attachments";
import { BridgeServer } from "../server";
import {
  BRIDGE_EVENT,
  BRIDGE_INVOKE,
  BRIDGE_SUBSCRIBE,
  BRIDGE_UNSUBSCRIBE,
  IpcBridgeTransport,
  isRendererSender,
} from "../transports/ipc";

const electronMock = vi.hoisted(() => ({
  /** `ipcMain.handle` registrations, by channel. */
  handlers: new Map<string, (...args: never[]) => unknown>(),
  /** `ipcMain.on` registrations, by channel. */
  listeners: new Map<string, Set<(...args: never[]) => unknown>>(),
  /** What the preload exposed, by global name. */
  exposed: new Map<string, Record<string, unknown>>(),
  /** `ipcRenderer.on` registrations, by channel. */
  rendererListeners: new Map<string, ((...args: never[]) => unknown)[]>(),
  /** Every `ipcRenderer.send` the preload made: `[channel, payload]`. */
  sent: [] as Array<[string, unknown]>,
  /** Every `ipcRenderer.invoke` the preload made: `[channel, payload]`. */
  invoked: [] as Array<[string, unknown]>,
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: never[]) => unknown) => {
      electronMock.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      electronMock.handlers.delete(channel);
    },
    on: (channel: string, listener: (...args: never[]) => unknown) => {
      const set = electronMock.listeners.get(channel) ?? new Set();
      set.add(listener);
      electronMock.listeners.set(channel, set);
    },
    removeListener: (
      channel: string,
      listener: (...args: never[]) => unknown,
    ) => {
      electronMock.listeners.get(channel)?.delete(listener);
    },
  },
  contextBridge: {
    exposeInMainWorld: (key: string, value: Record<string, unknown>) => {
      electronMock.exposed.set(key, value);
    },
  },
  ipcRenderer: {
    on: (channel: string, listener: (...args: never[]) => unknown) => {
      const list = electronMock.rendererListeners.get(channel) ?? [];
      list.push(listener);
      electronMock.rendererListeners.set(channel, list);
    },
    removeListener: () => {},
    send: (channel: string, payload: unknown) => {
      electronMock.sent.push([channel, payload]);
    },
    invoke: (channel: string, payload: unknown) => {
      electronMock.invoked.push([channel, payload]);
      return Promise.resolve(undefined);
    },
    sendSync: () => 7,
  },
}));

/** A stand-in `webContents`, and the window that owns it. */
function makeWindow(id: number) {
  const sends: Array<[string, unknown]> = [];
  let destroyed = false;
  let onDestroyed: (() => void) | null = null;
  const webContents = {
    id,
    isDestroyed: () => destroyed,
    send: (channel: string, payload: unknown) => {
      sends.push([channel, payload]);
    },
    once: (event: string, cb: () => void) => {
      if (event === "destroyed") onDestroyed = cb;
    },
  };
  return {
    webContents,
    sends,
    /** What Electron does when the window closes. */
    destroy() {
      destroyed = true;
      onDestroyed?.();
    },
    /**
     * Gone, but nothing has been told yet — the gap between a window dying
     * and the transport hearing `destroyed`, which is the only reason
     * `send` checks `isDestroyed()` at all.
     */
    silentlyDestroy() {
      destroyed = true;
    },
  };
}

type FakeWindow = ReturnType<typeof makeWindow>;

function invoke(payload: unknown, sender: FakeWindow["webContents"]) {
  const handler = electronMock.handlers.get(BRIDGE_INVOKE) as unknown as (
    event: { sender: unknown },
    payload: unknown,
  ) => Promise<unknown>;
  return handler({ sender }, payload);
}

function fire(
  channel: string,
  payload: unknown,
  sender: FakeWindow["webContents"],
) {
  for (const listener of electronMock.listeners.get(channel) ?? []) {
    (
      listener as unknown as (
        event: { sender: unknown },
        payload: unknown,
      ) => void
    )({ sender }, payload);
  }
}

describe("isRendererSender", () => {
  it("accepts a window's own webContents, by identity and by id", () => {
    const win = makeWindow(3);
    expect(isRendererSender(win.webContents, [win])).toBe(true);
    // The same window, reached through a different wrapper object — what a
    // `BrowserWindow` getter would hand back on another process's tick.
    expect(isRendererSender({ id: 3 }, [win])).toBe(true);
  });

  it("rejects a sender that is not one of the renderer windows", () => {
    const win = makeWindow(3);
    // A `<webview>` guest: its own `webContents`, its own id, the same
    // `ipcMain`. This is the case the check exists for.
    expect(isRendererSender({ id: 99 }, [win])).toBe(false);
    expect(isRendererSender({ id: 99 }, [])).toBe(false);
  });
});

describe("IpcBridgeTransport", () => {
  let windows: FakeWindow[];
  let transport: IpcBridgeTransport;
  let server: BridgeServer;
  let ping: ReturnType<typeof vi.fn>;
  let warn: MockInstance;

  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.listeners.clear();
    windows = [];
    ping = vi.fn((_deps: unknown, value: unknown) => `pong:${String(value)}`);
    const deps = {
      getRendererWindows: () => windows,
    } as unknown as IpcDeps;
    server = new BridgeServer(deps, {
      handlers: { "demo.ping": ping as never },
    });
    transport = new IpcBridgeTransport(deps, { server });
    transport.start();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    transport.dispose();
    server.dispose();
    warn.mockRestore();
  });

  it("dispatches an invoke from a known window", async () => {
    const win = makeWindow(11);
    windows.push(win);

    const result = await invoke(
      { ns: "demo", method: "ping", args: ["hi"] },
      win.webContents,
    );

    expect(result).toBe("pong:hi");
    // One connection, made lazily by that first frame, named for the
    // webContents — which is what `rendererId` already is on the desktop.
    expect(transport.size).toBe(1);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("returns a serialisable envelope for a method the host does not have", async () => {
    const win = makeWindow(11);
    windows.push(win);

    const result = await invoke(
      { ns: "demo", method: "nope", args: [] },
      win.webContents,
    );

    expect(result).toEqual({
      __bridgeError: {
        code: "unavailable:web",
        message: expect.stringContaining("demo.nope"),
      },
    });
  });

  it("drops an invoke from a sender that is not a renderer window", async () => {
    const win = makeWindow(11);
    windows.push(win);
    const guest = makeWindow(99).webContents;

    const settled = Symbol("settled");
    const raced = await Promise.race([
      invoke({ ns: "demo", method: "ping", args: ["hi"] }, guest).then(
        () => settled,
      ),
      new Promise((resolve) => setTimeout(() => resolve("no reply"), 10)),
    ]);

    expect(raced).toBe("no reply");
    expect(ping).not.toHaveBeenCalled();
    expect(transport.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(BRIDGE_INVOKE);
  });

  it("drops subscribe and unsubscribe from an unknown sender too", () => {
    const guest = makeWindow(99).webContents;

    fire(BRIDGE_SUBSCRIBE, { ns: "pty", event: "output" }, guest);
    fire(BRIDGE_UNSUBSCRIBE, { ns: "pty", event: "output" }, guest);

    expect(transport.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("sends a subscribed window its pane's output, and stops on unsubscribe", () => {
    const win = makeWindow(11);
    windows.push(win);

    fire(
      BRIDGE_SUBSCRIBE,
      { ns: "pty", event: "output", key: "pane-a" },
      win.webContents,
    );
    server.handleStreamEvent({
      type: "data",
      sessionId: "pane-a",
      data: "hello",
    });
    // A pane this window never asked about: membership is the whole filter.
    server.handleStreamEvent({
      type: "data",
      sessionId: "pane-b",
      data: "not yours",
    });

    expect(win.sends).toEqual([
      [
        BRIDGE_EVENT,
        {
          kind: "event",
          ns: "pty",
          event: "output",
          args: ["hello", undefined],
          key: "pane-a",
        },
      ],
    ]);

    fire(
      BRIDGE_UNSUBSCRIBE,
      { ns: "pty", event: "output", key: "pane-a" },
      win.webContents,
    );
    server.handleStreamEvent({
      type: "data",
      sessionId: "pane-a",
      data: "after",
    });

    expect(win.sends).toHaveLength(1);
  });

  it("drops a window's connection when its webContents is destroyed", async () => {
    const win = makeWindow(11);
    windows.push(win);
    await invoke({ ns: "demo", method: "ping", args: [] }, win.webContents);
    expect(transport.size).toBe(1);
    expect(server.size).toBe(1);

    win.destroy();

    expect(transport.size).toBe(0);
    expect(server.size).toBe(0);
  });

  it("does not write to a window that died before the drop landed", () => {
    const win = makeWindow(11);
    windows.push(win);
    fire(
      BRIDGE_SUBSCRIBE,
      { ns: "pty", event: "output", key: "pane-a" },
      win.webContents,
    );

    win.silentlyDestroy();
    server.handleStreamEvent({
      type: "data",
      sessionId: "pane-a",
      data: "hello",
    });

    expect(win.sends).toHaveLength(0);
  });
});

/**
 * ADR-180 D6, through the real handler table rather than a stand-in one.
 *
 * The headline of ticket 5: two renderer windows holding one pane are two
 * connections now, so one of them owns the winsize and the other is *told*
 * it does not — where before both were "the desktop", both measured, and both
 * resized the session on every layout tick.
 */
describe("two windows on one pane (D6)", () => {
  const PANE = "pane-a";
  /** The session's grid, as the daemon would report it. */
  let sessionSize: { cols: number; rows: number };
  let createdAt: Array<[string, number, number]>;
  let windows: FakeWindow[];
  let transport: IpcBridgeTransport;
  let server: BridgeServer;

  /** Every `pty.winsizeOwner` frame a window has been sent. */
  function ownerFrames(win: FakeWindow): Record<string, unknown>[] {
    return win.sends
      .filter(([channel]) => channel === BRIDGE_EVENT)
      .map(([, frame]) => frame as Record<string, unknown>)
      .filter((frame) => frame.event === "winsizeOwner");
  }

  function create(win: FakeWindow, cols: number, rows: number) {
    return invoke(
      { ns: "pty", method: "create", args: [PANE, "/tmp", cols, rows] },
      win.webContents,
    ) as Promise<{ winsizeOwner?: boolean; cols?: number; rows?: number }>;
  }

  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.listeners.clear();
    resetAttachments();
    sessionSize = { cols: 80, rows: 24 };
    createdAt = [];
    windows = [];
    const deps = {
      getRendererWindows: () => windows,
      backend: {
        pty: {
          createOrAttach: async (
            sessionId: string,
            _cwd: string,
            cols: number,
            rows: number,
          ) => {
            createdAt.push([sessionId, cols, rows]);
            sessionSize = { cols, rows };
            return { session: {}, snapshot: null };
          },
          getSnapshot: async () => ({ ...sessionSize }),
          resize: async () => {},
        },
      },
    } as unknown as IpcDeps;
    // No `handlers` override: this is the table the app runs.
    server = new BridgeServer(deps);
    transport = new IpcBridgeTransport(deps, { server });
    transport.start();
  });

  afterEach(() => {
    transport.dispose();
    server.dispose();
    resetAttachments();
  });

  it("hands the winsize to the window that attached last and tells the first", async () => {
    const first = makeWindow(11);
    const second = makeWindow(22);
    windows.push(first, second);
    for (const win of [first, second]) {
      fire(
        BRIDGE_SUBSCRIBE,
        { ns: "pty", event: "winsizeOwner", key: PANE },
        win.webContents,
      );
    }

    const opened = await create(first, 80, 24);
    expect(opened).toMatchObject({ winsizeOwner: true, cols: 80, rows: 24 });
    expect(createdAt).toEqual([[PANE, 80, 24]]);
    await vi.waitFor(() => expect(ownerFrames(first)).toHaveLength(1));

    // The second window opens the same pane at its own size. It attached
    // most recently, so the session moves to *its* grid...
    const joined = await create(second, 120, 40);
    expect(joined).toMatchObject({ winsizeOwner: true, cols: 120, rows: 40 });
    expect(createdAt).toEqual([
      [PANE, 80, 24],
      [PANE, 120, 40],
    ]);

    // ...and the first window is told it is a follower, with the grid to
    // render. Before ADR-180 this frame did not exist on the desktop and the
    // two windows fought over the winsize instead.
    await vi.waitFor(() => expect(ownerFrames(first)).toHaveLength(2));
    expect(ownerFrames(first)[1]).toMatchObject({
      ns: "pty",
      event: "winsizeOwner",
      key: PANE,
      args: [{ paneId: PANE, cols: 120, rows: 40, owner: false }],
    });
    const secondFrames = ownerFrames(second);
    expect(secondFrames[secondFrames.length - 1]).toMatchObject({
      args: [{ paneId: PANE, owner: true }],
    });
  });

  it("does not carry a follower window's grid into a re-create", async () => {
    const first = makeWindow(11);
    const second = makeWindow(22);
    windows.push(first, second);

    await create(first, 80, 24);
    await create(second, 120, 40);
    createdAt.length = 0;

    // The first window remounts the pane it never let go of. It is a
    // follower now, so its own measurement must not reach the pty — it is
    // handed the owner's grid to render instead.
    const remounted = await create(first, 80, 24);
    expect(remounted).toMatchObject({
      winsizeOwner: false,
      cols: 120,
      rows: 40,
    });
    expect(createdAt).toEqual([[PANE, 120, 40]]);
  });

  it("gives the winsize back when the owning window closes", async () => {
    const first = makeWindow(11);
    const second = makeWindow(22);
    windows.push(first, second);
    fire(
      BRIDGE_SUBSCRIBE,
      { ns: "pty", event: "winsizeOwner", key: PANE },
      first.webContents,
    );

    await create(first, 80, 24);
    await create(second, 120, 40);
    await vi.waitFor(() => expect(ownerFrames(first)).toHaveLength(2));

    second.destroy();

    await vi.waitFor(() => expect(ownerFrames(first)).toHaveLength(3));
    expect(ownerFrames(first)[2]).toMatchObject({
      args: [{ paneId: PANE, owner: true }],
    });
  });
});

describe("window.manorHost", () => {
  let host: Record<string, unknown>;
  /** Deliver one `bridge:event` frame the way the main process would. */
  let deliver: (frame: unknown) => void;

  beforeEach(async () => {
    electronMock.sent.length = 0;
    electronMock.invoked.length = 0;
    await import("../../preload");
    host = electronMock.exposed.get("manorHost")!;
    const listeners = electronMock.rendererListeners.get(BRIDGE_EVENT) ?? [];
    deliver = (frame) => {
      for (const listener of listeners) {
        (listener as (event: unknown, frame: unknown) => void)({}, frame);
      }
    };
  });

  it("exposes the facts the renderer needs before it can ask anything", () => {
    expect(host.platform).toBe("electron");
    expect(host.rendererId).toBe("7");
    expect(host.isDetached).toBe(false);
    expect(host.detachedWindowId).toBe(null);
    expect(host.claim).toBe(null);
    expect(host.env).toEqual({ isPackaged: false });
  });

  it("puts one listener on bridge:event for the whole page", () => {
    expect(electronMock.rendererListeners.get(BRIDGE_EVENT)).toHaveLength(1);
  });

  it("invokes on the one channel, as one payload", async () => {
    await (host.invoke as (ns: string, m: string, a: unknown[]) => unknown)(
      "pty",
      "write",
      ["pane-a", "ls"],
    );
    expect(electronMock.invoked).toEqual([
      [BRIDGE_INVOKE, { ns: "pty", method: "write", args: ["pane-a", "ls"] }],
    ]);
  });

  it("subscribes once per pair and unsubscribes only on the last release", () => {
    const subscribe = host.subscribe as (
      ns: string,
      event: string,
      key: string | null,
      cb: (...args: unknown[]) => void,
    ) => () => void;
    const seen: unknown[][] = [];
    // The same callback twice — React StrictMode mounting a pane's effect
    // twice, which must be two subscriptions and not one.
    const callback = (...args: unknown[]) => seen.push(args);

    const first = subscribe("pty", "output", "pane-a", callback);
    const second = subscribe("pty", "output", "pane-a", callback);

    expect(electronMock.sent).toEqual([
      [BRIDGE_SUBSCRIBE, { ns: "pty", event: "output", key: "pane-a" }],
    ]);

    first();
    expect(electronMock.sent).toHaveLength(1);

    // Still live: the surviving subscription still hears the pane.
    deliver({ ns: "pty", event: "output", key: "pane-a", args: ["bytes"] });
    expect(seen).toEqual([["bytes"]]);

    second();
    expect(electronMock.sent).toEqual([
      [BRIDGE_SUBSCRIBE, { ns: "pty", event: "output", key: "pane-a" }],
      [BRIDGE_UNSUBSCRIBE, { ns: "pty", event: "output", key: "pane-a" }],
    ]);

    deliver({ ns: "pty", event: "output", key: "pane-a", args: ["ignored"] });
    expect(seen).toHaveLength(1);
  });

  it("releasing twice does not unsubscribe somebody else's listener", () => {
    const subscribe = host.subscribe as (
      ns: string,
      event: string,
      key: string | null,
      cb: (...args: unknown[]) => void,
    ) => () => void;
    const mine = vi.fn();
    const theirs = vi.fn();
    const release = subscribe("pty", "output", "pane-a", mine);
    const releaseTheirs = subscribe("pty", "output", "pane-a", theirs);

    release();
    release();

    deliver({ ns: "pty", event: "output", key: "pane-a", args: ["bytes"] });
    expect(theirs).toHaveBeenCalledTimes(1);
    expect(mine).not.toHaveBeenCalled();
    expect(
      electronMock.sent.filter(([channel]) => channel === BRIDGE_UNSUBSCRIBE),
    ).toHaveLength(0);

    releaseTheirs();
  });

  it("delivers a keyless event to every listener of that name", () => {
    const subscribe = host.subscribe as (
      ns: string,
      event: string,
      key: string | null,
      cb: (...args: unknown[]) => void,
    ) => () => void;
    const keyed = vi.fn();
    const keyless = vi.fn();
    subscribe("pty", "output", "pane-a", keyed);
    subscribe("pty", "output", null, keyless);

    // No key on the frame: everybody who listens for `pty.output` hears it.
    deliver({ ns: "pty", event: "output", args: ["all"] });
    expect(keyed).toHaveBeenCalledWith("all");
    expect(keyless).toHaveBeenCalledWith("all");

    // A keyed frame reaches that pane's listeners, plus the keyless one.
    deliver({ ns: "pty", event: "output", key: "pane-b", args: ["b"] });
    expect(keyed).toHaveBeenCalledTimes(1);
    expect(keyless).toHaveBeenCalledTimes(2);
  });

  it("subscribing without a key sends no key on the wire", () => {
    const subscribe = host.subscribe as (
      ns: string,
      event: string,
      key: string | null,
      cb: (...args: unknown[]) => void,
    ) => () => void;
    subscribe("projects", "changed", null, vi.fn());
    expect(electronMock.sent).toEqual([
      [BRIDGE_SUBSCRIBE, { ns: "projects", event: "changed", key: undefined }],
    ]);
  });
});
