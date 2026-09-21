/**
 * Whose window a layout command came from (ADR-179 D3, ADR-180 ticket 6).
 *
 * Nothing about the origin is checked by a type. The server hands every
 * handler the *connection* it was called on as `ctx.caller`, and
 * `handlers/layout.ts` builds the `LayoutOrigin` from it. If that and the id
 * the page calls itself ever name different things, every split and every
 * new tab hands its selection hint to the wrong window — silently, in a
 * running app, with a green suite behind it.
 *
 * So the property under test is an equality: the origin a window's command
 * carries is `String(webContents.id)`, which is the same string the page is
 * told synchronously as its `rendererId`. The rest of the file is the other
 * half of D3 — that the *frame* cannot supply an origin of its own choosing,
 * and that a socket is named a `bridge` caller rather than a window.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { IpcDeps } from "../../ipc/types";
import { BridgeServer } from "../server";
import {
  BRIDGE_INVOKE,
  BRIDGE_RENDERER_ID,
  IpcBridgeTransport,
} from "../transports/ipc";
import type { BridgeConnection } from "../types";

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  listeners: new Map<string, Set<(...args: never[]) => unknown>>(),
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
  BrowserWindow: { getAllWindows: () => [] },
}));

/** The little of a window the transport looks at. */
function makeWindow(id: number) {
  return {
    webContents: {
      id,
      isDestroyed: () => false,
      send: () => {},
      once: () => {},
    },
  };
}

type FakeWindow = ReturnType<typeof makeWindow>;

const SPLIT = { type: "split-pane", paneId: "pane-1", direction: "row" };

describe("a layout command's origin", () => {
  let windows: FakeWindow[];
  let transport: IpcBridgeTransport;
  let server: BridgeServer;
  let apply: ReturnType<typeof vi.fn>;
  let reportViewport: ReturnType<typeof vi.fn>;

  /** Call the host as a renderer window would, over `bridge:invoke`. */
  function invoke(
    ns: string,
    method: string,
    args: unknown[],
    win: FakeWindow,
  ) {
    const handler = electronMock.handlers.get(BRIDGE_INVOKE) as unknown as (
      event: { sender: unknown },
      payload: unknown,
    ) => Promise<unknown>;
    return handler({ sender: win.webContents }, { ns, method, args });
  }

  /** What the preload's `sendSync` gets back on `bridge:rendererId`. */
  function askRendererId(win: FakeWindow): unknown {
    const event = {
      sender: win.webContents,
      returnValue: undefined as unknown,
    };
    for (const listener of electronMock.listeners.get(BRIDGE_RENDERER_ID) ??
      []) {
      (listener as unknown as (e: typeof event) => void)(event);
    }
    return event.returnValue;
  }

  beforeEach(() => {
    electronMock.handlers.clear();
    electronMock.listeners.clear();
    windows = [];
    apply = vi.fn(() => Promise.resolve({ version: 2 }));
    reportViewport = vi.fn();
    const deps = {
      getRendererWindows: () => windows,
      layoutStore: { apply, reportViewport },
    } as unknown as IpcDeps;
    // The real table: the point is what `HANDLERS["layout.apply"]` makes of
    // the caller the server hands it, not that a stub receives one.
    server = new BridgeServer(deps);
    transport = new IpcBridgeTransport(deps, { server });
    transport.start();
  });

  afterEach(() => {
    transport.dispose();
    server.dispose();
  });

  it("is the sending window's webContents id, as a window", async () => {
    const win = makeWindow(11);
    windows.push(win);

    await invoke("layout", "apply", ["/repo/main", SPLIT], win);

    expect(apply).toHaveBeenCalledWith("/repo/main", SPLIT, {
      kind: "window",
      id: "11",
    });
  });

  it("is the id the page is told synchronously as its rendererId", async () => {
    const win = makeWindow(11);
    windows.push(win);

    await invoke("layout", "apply", ["/repo/main", SPLIT], win);
    const origin = apply.mock.calls[0][2] as { id: string };

    // The equality the whole feature rests on: the id a command's origin
    // carries and the id the renderer calls itself are one string, so a
    // selection hint lands on the window that asked for the split.
    expect(askRendererId(win)).toBe(origin.id);
  });

  it("names a second window as itself, not as the first", async () => {
    const first = makeWindow(11);
    const second = makeWindow(12);
    windows.push(first, second);

    await invoke("layout", "apply", ["/repo/main", SPLIT], first);
    await invoke("layout", "apply", ["/repo/main", SPLIT], second);

    expect(apply.mock.calls.map((call) => call[2])).toEqual([
      { kind: "window", id: "11" },
      { kind: "window", id: "12" },
    ]);
  });

  it("cannot be claimed by the frame", async () => {
    const win = makeWindow(11);
    windows.push(win);

    // A page that puts an origin in the arguments is ignored, not believed:
    // who is calling is the transport's to say (D3).
    await invoke(
      "layout",
      "apply",
      ["/repo/main", SPLIT, { kind: "window", id: "12" }],
      win,
    );

    expect(apply).toHaveBeenCalledWith("/repo/main", SPLIT, {
      kind: "window",
      id: "11",
    });
  });

  it("names a viewport's reporter from the connection", async () => {
    const win = makeWindow(11);
    windows.push(win);
    const viewport = { activeTabId: "tab-1" };

    // A client cannot be trusted to say who it is, so it is not asked.
    await invoke("layout", "reportViewport", ["/repo/main", viewport], win);

    expect(reportViewport).toHaveBeenCalledWith(
      "/repo/main",
      { kind: "window", id: "11" },
      viewport,
    );
  });

  /**
   * The claim is what makes detach-to-window work (ADR-179 D4): a popout
   * reports one, and the primary stops showing the tab it took. The store
   * honours it only from a `window` origin, so a phone cannot make a tab
   * vanish off the desk (`layout-store.test.ts`) — which makes the origin
   * this entry reports under the whole of the rule.
   */
  it("reports a window's claim as a window's and a device's as a bridge's", async () => {
    const win = makeWindow(11);
    windows.push(win);
    const claimed = { activeTabId: "tab-1", claim: "tab-1" };

    await invoke("layout", "reportViewport", ["/repo/main", claimed], win);

    expect(reportViewport).toHaveBeenCalledWith(
      "/repo/main",
      { kind: "window", id: "11" },
      claimed,
    );

    const device: BridgeConnection = {
      id: "dev-1",
      callerClass: "device",
      deviceId: "dev-1",
      deviceLabel: "phone",
      send: () => {},
    };
    server.accept(device);
    await server.dispatch(device, {
      kind: "invoke",
      id: "v1",
      ns: "layout",
      method: "reportViewport",
      args: ["/repo/main", claimed],
    });

    expect(reportViewport).toHaveBeenLastCalledWith(
      "/repo/main",
      { kind: "bridge", id: "dev-1" },
      claimed,
    );
  });

  it("is a bridge caller when it came off a socket", async () => {
    const device: BridgeConnection = {
      id: "dev-1",
      callerClass: "device",
      deviceId: "dev-1",
      deviceLabel: "phone",
      send: () => {},
    };
    server.accept(device);

    await server.dispatch(device, {
      kind: "invoke",
      id: "l1",
      ns: "layout",
      method: "apply",
      args: ["/repo/main", SPLIT],
    });

    expect(apply).toHaveBeenCalledWith("/repo/main", SPLIT, {
      kind: "bridge",
      id: "dev-1",
    });
  });
});
