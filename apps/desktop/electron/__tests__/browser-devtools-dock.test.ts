import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ WebContentsView: class {} }));

import {
  BrowserDevToolsDock,
  type DockTarget,
  type DockView,
  type DockWindow,
} from "../browser-devtools-dock";
import type { DockRect } from "../../src/lib/devtools-dock";

const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeFrontend extends EventEmitter {
  destroyed = false;
  capturePage = vi.fn(async () => ({
    isEmpty: () => false,
    toJPEG: () => Buffer.from("jpeg"),
  }));
  isDestroyed() {
    return this.destroyed;
  }
  // Like Electron, destruction lands after close() returns.
  close = vi.fn(() => {
    setImmediate(() => {
      this.destroyed = true;
      this.emit("destroyed");
    });
  });
}

class FakeView {
  frontend = new FakeFrontend();
  bounds: DockRect = { x: 0, y: 0, width: 0, height: 0 };
  visible = true;
  get webContents() {
    return this.frontend as unknown as Electron.WebContents;
  }
  setBounds(bounds: DockRect) {
    this.bounds = bounds;
  }
  getBounds() {
    return this.bounds;
  }
  setVisible(visible: boolean) {
    this.visible = visible;
  }
  getVisible() {
    return this.visible;
  }
}

function fakeWindow() {
  const emitter = new EventEmitter();
  const children = new Set<unknown>();
  let destroyed = false;
  const window = Object.assign(emitter, {
    children,
    isDestroyed: () => destroyed,
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    contentView: {
      addChildView: (view: unknown) => children.add(view),
      removeChildView: (view: unknown) => children.delete(view),
    },
    close() {
      destroyed = true;
      emitter.emit("closed");
    },
  });
  return window as unknown as typeof window & DockWindow;
}

function fakeGuest() {
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    destroyed: false,
    devToolsOpen: false,
    isDestroyed: () => guest.destroyed,
    isDevToolsOpened: () => guest.devToolsOpen,
    closeDevTools: vi.fn(),
    openDevTools: vi.fn(),
    setDevToolsWebContents: vi.fn((frontend: FakeFrontend) => {
      // Electron reports a destroyed custom host as DevTools closing.
      frontend.once("destroyed", () => guest.emit("devtools-closed"));
    }),
  });
  return guest;
}

function setup() {
  const views: FakeView[] = [];
  const onChange = vi.fn();
  const dock = new BrowserDevToolsDock({
    createView: () => {
      const view = new FakeView();
      views.push(view);
      return view as unknown as DockView;
    },
    onChange,
  });
  const guest = fakeGuest();
  const window = fakeWindow();
  const host = { id: 1, isDestroyed: () => false, getZoomFactor: () => 1 };
  const target = {
    guest: guest as unknown as Electron.WebContents,
    host: host as unknown as Electron.WebContents,
    window,
  } satisfies DockTarget;
  return { dock, views, onChange, guest, window, host, target };
}

describe("BrowserDevToolsDock", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("opens DevTools into a hidden view added to the pane's window", async () => {
    expect(await s.dock.open("pane-1", s.target)).toBe(true);
    expect(s.views).toHaveLength(1);
    const [view] = s.views;
    expect(s.window.children.has(view)).toBe(true);
    expect(view.visible).toBe(false);
    expect(s.guest.setDevToolsWebContents).toHaveBeenCalledWith(view.frontend);
    expect(s.guest.openDevTools).toHaveBeenCalledWith({ mode: "detach", activate: false });
    expect(s.onChange).toHaveBeenCalledWith("pane-1", s.host, true);
  });

  it("closes Electron's own DevTools window first", async () => {
    s.guest.devToolsOpen = true;
    await s.dock.open("pane-1", s.target);
    expect(s.guest.closeDevTools).toHaveBeenCalled();
  });

  it("opening twice keeps the one view", async () => {
    await s.dock.open("pane-1", s.target);
    await s.dock.open("pane-1", s.target);
    expect(s.views).toHaveLength(1);
  });

  it("closes by destroying the host, and reopens only once Electron let go", async () => {
    await s.dock.open("pane-1", s.target);
    const [first] = s.views;
    const closed = s.dock.close("pane-1");
    expect(s.window.children.has(first)).toBe(false);
    expect(first.frontend.close).toHaveBeenCalled();
    expect(s.onChange).toHaveBeenLastCalledWith("pane-1", s.host, false);

    const reopened = s.dock.open("pane-1", s.target);
    // Still waiting on the old frontend: nothing attached yet.
    expect(s.views).toHaveLength(1);
    await closed;
    expect(await reopened).toBe(true);
    expect(s.views).toHaveLength(2);
    expect(s.dock.isOpen("pane-1")).toBe(true);
  });

  it("a close during a pending reopen wins", async () => {
    await s.dock.open("pane-1", s.target);
    void s.dock.close("pane-1");
    const reopened = s.dock.open("pane-1", s.target);
    void s.dock.close("pane-1");
    expect(await reopened).toBe(false);
    expect(s.views).toHaveLength(1);
    expect(s.dock.isOpen("pane-1")).toBe(false);
  });

  it("closes when the page is destroyed", async () => {
    await s.dock.open("pane-1", s.target);
    s.guest.destroyed = true;
    s.guest.emit("destroyed");
    await flush();
    expect(s.dock.isOpen("pane-1")).toBe(false);
    expect(s.views[0].frontend.close).toHaveBeenCalled();
  });

  it("closes when the window closes", async () => {
    await s.dock.open("pane-1", s.target);
    s.window.close();
    await flush();
    expect(s.dock.isOpen("pane-1")).toBe(false);
    expect(s.views[0].frontend.close).toHaveBeenCalled();
  });

  it("closes when DevTools close themselves", async () => {
    await s.dock.open("pane-1", s.target);
    s.guest.emit("devtools-closed");
    await flush();
    expect(s.dock.isOpen("pane-1")).toBe(false);
  });

  it("reconnects a fresh frontend in the same place once a crashed page is back", async () => {
    await s.dock.open("pane-1", s.target);
    await s.dock.setBounds("pane-1", s.window, { x: 0, y: 400, width: 600, height: 300 }, false);
    s.guest.emit("render-process-gone");
    s.guest.emit("dom-ready");
    await flush();
    // The fresh frontend attaches a turn after the old one lets go.
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.views).toHaveLength(2);
    expect(s.dock.isOpen("pane-1")).toBe(true);
    const [stale, fresh] = s.views;
    expect(s.window.children.has(stale)).toBe(false);
    expect(fresh.bounds).toEqual({ x: 0, y: 400, width: 600, height: 300 });
    expect(fresh.visible).toBe(true);
  });

  it("places the view by the renderer's zoom and clips it to the window", async () => {
    await s.dock.open("pane-1", s.target);
    s.host.getZoomFactor = () => 2;
    await s.dock.setBounds("pane-1", s.window, { x: 100, y: 300, width: 600, height: 300 }, false);
    expect(s.views[0].bounds).toEqual({ x: 200, y: 600, width: 800, height: 200 });
    expect(s.views[0].visible).toBe(true);
  });

  it("hides behind a snapshot when asked", async () => {
    await s.dock.open("pane-1", s.target);
    await s.dock.setBounds("pane-1", s.window, { x: 0, y: 0, width: 10, height: 10 }, false);
    const url = await s.dock.setBounds("pane-1", s.window, null, true);
    expect(url).toBe(`data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}`);
    expect(s.views[0].visible).toBe(false);
  });

  it("a show that lands while a snapshot is capturing stays shown", async () => {
    await s.dock.open("pane-1", s.target);
    await s.dock.setBounds("pane-1", s.window, { x: 0, y: 0, width: 10, height: 10 }, false);
    const hiding = s.dock.setBounds("pane-1", s.window, null, true);
    await s.dock.setBounds("pane-1", s.window, { x: 0, y: 0, width: 20, height: 20 }, false);
    await hiding;
    expect(s.views[0].visible).toBe(true);
  });

  it("bounds arriving after close do nothing", async () => {
    await s.dock.open("pane-1", s.target);
    await s.dock.close("pane-1");
    expect(
      await s.dock.setBounds("pane-1", s.window, { x: 0, y: 0, width: 10, height: 10 }, false),
    ).toBeNull();
    expect(s.views[0].visible).toBe(false);
  });

  it("takes the view along when the pane reports from another window", async () => {
    await s.dock.open("pane-1", s.target);
    const other = fakeWindow();
    await s.dock.setBounds("pane-1", other, { x: 0, y: 0, width: 10, height: 10 }, false);
    expect(s.window.children.size).toBe(0);
    expect(other.children.has(s.views[0])).toBe(true);
    other.close();
    await flush();
    expect(s.dock.isOpen("pane-1")).toBe(false);
  });

  it("forgets the old window once the view has moved", async () => {
    await s.dock.open("pane-1", s.target);
    const other = fakeWindow();
    await s.dock.setBounds("pane-1", other, { x: 0, y: 0, width: 10, height: 10 }, false);
    s.window.close();
    await flush();
    expect(s.dock.isOpen("pane-1")).toBe(true);
  });
});
