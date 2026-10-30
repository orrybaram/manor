import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => ipcHandlers.set(channel, fn) },
}));
vi.mock("./server/pasted-images", () => ({
  writePastedImage: vi.fn(async () => "/home/me/.manor/pasted-images/shot.png"),
}));

import { attachPagePins, registerPagePinsIpc, screenshotRect } from "./webview-pins";
import { PINS_PREFIX, PIN_OPEN_PREFIX, PIN_PICK_PREFIX, PIN_STOP_MESSAGE } from "./page-pins-script";
import { writePastedImage } from "./server/pasted-images";

describe("screenshotRect", () => {
  const viewport = { width: 800, height: 600 };

  it("scales by the page's zoom", () => {
    expect(screenshotRect({ x: 10, y: 20, width: 100, height: 50 }, viewport, 2)).toEqual({
      x: 20,
      y: 40,
      width: 200,
      height: 100,
    });
  });

  it("crops to the viewport", () => {
    expect(screenshotRect({ x: -50, y: 550, width: 200, height: 200 }, viewport, 1)).toEqual({
      x: 0,
      y: 550,
      width: 150,
      height: 50,
    });
  });

  it("has nothing to take for an element off screen", () => {
    expect(screenshotRect({ x: 0, y: 700, width: 100, height: 100 }, viewport, 1)).toBeNull();
    expect(screenshotRect({ x: 0, y: 0, width: 0, height: 10 }, viewport, 1)).toBeNull();
  });
});

describe("attachPagePins", () => {
  const MAIN = { frameTreeNodeId: 1 };
  const SUBFRAME = { frameTreeNodeId: 2 };
  const PICK = {
    pickId: "pin-1",
    selector: "div.card",
    outerHTML: "<div></div>",
    computedStyles: {},
    accessibility: {},
    boundingBox: { x: 10, y: 10, width: 100, height: 40 },
    viewport: { width: 800, height: 600 },
  };

  let n = 0;
  function setup({ arm = true } = {}) {
    const paneId = `pane-${++n}`;
    const page = Object.assign(new EventEmitter(), {
      mainFrame: MAIN,
      isDestroyed: () => false,
      getZoomFactor: () => 1,
      capturePage: vi.fn(async () => ({ isEmpty: () => false, toPNG: () => Buffer.from("png") })),
      executeJavaScript: vi.fn(async () => undefined),
    });
    const host = { isDestroyed: () => false, send: vi.fn() };
    const registry = { get: vi.fn() };
    registerPagePinsIpc(() => page as unknown as WebContents, registry as never);
    const detach = attachPagePins(
      paneId,
      page as unknown as WebContents,
      host as unknown as WebContents,
      registry as never,
    );
    const ipc = (channel: string, ...args: unknown[]) => ipcHandlers.get(channel)!({}, paneId, ...args);
    const log = (message: string, frame: object = MAIN) => page.emit("console-message", { message, frame });
    const pickLine = (over: object = {}) => PIN_PICK_PREFIX + JSON.stringify({ ...PICK, ...over });
    return { paneId, page, host, detach, log, ipc, pickLine, armed: arm ? ipc("webview:start-pins", { accent: "", bg: "" }) : null };
  }

  it("screenshots a pick before passing it on, then shows the pins again", async () => {
    const { page, host, log, pickLine, armed, paneId } = setup();
    await armed;
    log(pickLine());
    await vi.waitFor(() => expect(host.send).toHaveBeenCalled());

    expect(page.capturePage).toHaveBeenCalledWith({ x: 10, y: 10, width: 100, height: 40 });
    expect(writePastedImage).toHaveBeenCalledWith(expect.anything(), "local", Buffer.from("png"), "png");
    expect(page.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('release("pin-1")'));
    const [channel, sentPane, pick] = host.send.mock.calls[0];
    expect([channel, sentPane]).toEqual(["webview:pin-picked", paneId]);
    expect(pick).toMatchObject({
      pickId: "pin-1",
      selector: "div.card",
      screenshot: { path: "/home/me/.manor/pasted-images/shot.png" },
    });
    expect(pick).not.toHaveProperty("viewport");
  });

  it("drops picks while not armed: before start, after stop, after Escape and after a new document", async () => {
    const { page, host, log, pickLine, ipc } = setup({ arm: false });
    log(pickLine());
    await ipc("webview:start-pins", {});
    await ipc("webview:stop-pins");
    log(pickLine());
    await ipc("webview:start-pins", {});
    log(PIN_STOP_MESSAGE);
    log(pickLine());
    await ipc("webview:start-pins", {});
    page.emit("did-navigate");
    log(pickLine());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.capturePage).not.toHaveBeenCalled();
    expect(host.send.mock.calls.map((c) => c[0])).toEqual(["webview:pins-stopped"]);
  });

  it("takes one screenshot at a time, and shows the pins again for one it drops", async () => {
    const { page, host, log, pickLine, armed } = setup();
    await armed;
    let finish!: () => void;
    page.capturePage.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve({ isEmpty: () => false, toPNG: () => Buffer.from("png") }))),
    );
    log(pickLine({ pickId: "pin-a" }));
    for (let i = 0; i < 50; i++) log(pickLine({ pickId: `pin-${i}x` }));
    expect(page.capturePage).toHaveBeenCalledTimes(1);
    expect(page.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('release("pin-0x")'));
    finish();
    await vi.waitFor(() => expect(host.send).toHaveBeenCalledTimes(1));
    log(pickLine({ pickId: "pin-b" }));
    await vi.waitFor(() => expect(host.send).toHaveBeenCalledTimes(2));
  });

  it("ignores a subframe, and reports that don't fit", async () => {
    const { page, host, log, pickLine, armed } = setup();
    await armed;
    log(pickLine(), SUBFRAME);
    log(`${PINS_PREFIX}{"pins":[],"viewport":{"width":1,"height":1}}`, SUBFRAME);
    log(pickLine({ selector: 42 }));
    log(pickLine({ boundingBox: { x: "1", y: 0, width: 1, height: 1 } }));
    log(`${PINS_PREFIX}{"pins":[{"id":"a","x":null,"y":0,"width":1,"height":1,"gone":false}],"viewport":{"width":1,"height":1}}`);
    log(`${PIN_OPEN_PREFIX}"); alert(1); ("`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(page.capturePage).not.toHaveBeenCalled();
    expect(host.send).not.toHaveBeenCalled();
  });

  it("passes on stops, pin clicks and positions, and ignores the rest", async () => {
    const { host, log, detach, paneId } = setup();
    log(PIN_STOP_MESSAGE);
    log(`${PIN_OPEN_PREFIX}pin-2`);
    log(`${PINS_PREFIX}{"pins":[],"viewport":{"width":1,"height":1}}`);
    log("hello from the page");
    log(`${PINS_PREFIX}not json`);
    expect(host.send.mock.calls).toEqual([
      ["webview:pins-stopped", paneId],
      ["webview:pin-opened", paneId, "pin-2"],
      ["webview:pins-moved", paneId, { pins: [], viewport: { width: 1, height: 1 } }],
    ]);

    detach();
    log(PIN_STOP_MESSAGE);
    expect(host.send).toHaveBeenCalledTimes(3);
  });
});
