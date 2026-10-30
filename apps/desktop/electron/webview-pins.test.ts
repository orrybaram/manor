import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("./server/pasted-images", () => ({
  writePastedImage: vi.fn(async () => "/home/me/.manor/pasted-images/shot.png"),
}));

import { attachPagePins, screenshotRect } from "./webview-pins";
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
  function setup() {
    const page = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      getZoomFactor: () => 1,
      capturePage: vi.fn(async () => ({ isEmpty: () => false, toPNG: () => Buffer.from("png") })),
      executeJavaScript: vi.fn(async () => undefined),
    });
    const host = { isDestroyed: () => false, send: vi.fn() };
    const registry = { get: vi.fn() };
    const detach = attachPagePins(
      "pane-1",
      page as unknown as WebContents,
      host as unknown as WebContents,
      registry as never,
    );
    const log = (message: string) => page.emit("console-message", { message });
    return { page, host, detach, log };
  }

  it("screenshots a pick before passing it on, then shows the pins again", async () => {
    const { page, host, log } = setup();
    log(
      PIN_PICK_PREFIX +
        JSON.stringify({
          pickId: "pin-1",
          selector: "div.card",
          outerHTML: "<div></div>",
          computedStyles: {},
          accessibility: {},
          boundingBox: { x: 10, y: 10, width: 100, height: 40 },
          viewport: { width: 800, height: 600 },
        }),
    );
    await vi.waitFor(() => expect(host.send).toHaveBeenCalled());

    expect(page.capturePage).toHaveBeenCalledWith({ x: 10, y: 10, width: 100, height: 40 });
    expect(writePastedImage).toHaveBeenCalledWith(expect.anything(), "local", Buffer.from("png"), "png");
    expect(page.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining("release()"));
    const [channel, paneId, pick] = host.send.mock.calls[0];
    expect([channel, paneId]).toEqual(["webview:pin-picked", "pane-1"]);
    expect(pick).toMatchObject({
      pickId: "pin-1",
      selector: "div.card",
      screenshot: { path: "/home/me/.manor/pasted-images/shot.png" },
    });
    expect(pick).not.toHaveProperty("viewport");
  });

  it("passes on stops, pin clicks and positions, and ignores the rest", () => {
    const { host, log, detach } = setup();
    log(PIN_STOP_MESSAGE);
    log(`${PIN_OPEN_PREFIX}pin-2`);
    log(`${PINS_PREFIX}{"pins":[],"viewport":{"width":1,"height":1}}`);
    log("hello from the page");
    log(`${PINS_PREFIX}not json`);
    expect(host.send.mock.calls).toEqual([
      ["webview:pins-stopped", "pane-1"],
      ["webview:pin-opened", "pane-1", "pin-2"],
      ["webview:pins-moved", "pane-1", { pins: [], viewport: { width: 1, height: 1 } }],
    ]);

    detach();
    log(PIN_STOP_MESSAGE);
    expect(host.send).toHaveBeenCalledTimes(3);
  });
});
