// @vitest-environment jsdom
/**
 * Ctrl+V in a terminal. On the web xterm must not
 * write \x16 and nothing reads the server's clipboard: the browser's own
 * paste fires the DOM `paste` event instead. On the desktop a remote pane
 * still pastes the native clipboard's image.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

const { isWebApp, isRemotePane, pasteClipboardImage } = vi.hoisted(() => ({
  isWebApp: vi.fn(),
  isRemotePane: vi.fn(),
  pasteClipboardImage: vi.fn(),
}));
vi.mock("../../lib/platform", () => ({ isWebApp }));
vi.mock("../../lib/remote-image-paste", () => ({ isRemotePane, pasteClipboardImage }));

import { useTerminalHotkeys } from "../useTerminalHotkeys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let handler: (e: KeyboardEvent) => boolean;
const ptyWrite = vi.fn();

function Harness() {
  const { attachHandler } = useTerminalHotkeys();
  const term = {
    attachCustomKeyEventHandler: (h: (e: KeyboardEvent) => boolean) => {
      handler = h;
    },
  } as unknown as Terminal;
  attachHandler(term, "p1", ptyWrite);
  return null;
}

const ctrlV = (type: "keydown" | "keyup") =>
  new KeyboardEvent(type, { key: "v", ctrlKey: true, cancelable: true });

beforeEach(() => {
  isRemotePane.mockReturnValue(true);
  pasteClipboardImage.mockResolvedValue(undefined);
  root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
  vi.clearAllMocks();
});

describe("Ctrl+V", () => {
  it("on the web, lets the browser paste: xterm skips it and nothing is read", () => {
    isWebApp.mockReturnValue(true);
    for (const type of ["keydown", "keyup"] as const) {
      const e = ctrlV(type);
      expect(handler(e)).toBe(false);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(pasteClipboardImage).not.toHaveBeenCalled();
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("on the desktop, pastes a remote pane's image from the native clipboard", () => {
    isWebApp.mockReturnValue(false);
    expect(handler(ctrlV("keydown"))).toBe(false);
    expect(handler(ctrlV("keyup"))).toBe(false);
    expect(pasteClipboardImage).toHaveBeenCalledTimes(1);
  });
});
