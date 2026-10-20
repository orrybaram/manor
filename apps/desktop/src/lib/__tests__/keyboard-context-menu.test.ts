// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  isContextMenuKey,
  openContextMenuFromKeyboard,
} from "../keyboard-context-menu";

function key(overrides: Partial<Parameters<typeof isContextMenuKey>[0]>) {
  return {
    key: "",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("isContextMenuKey", () => {
  it("matches Shift+F10", () => {
    expect(isContextMenuKey(key({ key: "F10", shiftKey: true }))).toBe(true);
  });

  it("matches the ContextMenu key regardless of modifiers", () => {
    expect(isContextMenuKey(key({ key: "ContextMenu" }))).toBe(true);
  });

  it("matches ⌘.", () => {
    expect(isContextMenuKey(key({ key: ".", metaKey: true }))).toBe(true);
  });

  it("does not match ⌘⇧. (Copy Branch Name)", () => {
    expect(
      isContextMenuKey(key({ key: ".", metaKey: true, shiftKey: true })),
    ).toBe(false);
  });

  it("does not match F10 without Shift", () => {
    expect(isContextMenuKey(key({ key: "F10" }))).toBe(false);
  });

  it("does not match . without ⌘", () => {
    expect(isContextMenuKey(key({ key: "." }))).toBe(false);
  });

  it("does not match ⌘. with Ctrl or Alt held too", () => {
    expect(
      isContextMenuKey(key({ key: ".", metaKey: true, ctrlKey: true })),
    ).toBe(false);
    expect(
      isContextMenuKey(key({ key: ".", metaKey: true, altKey: true })),
    ).toBe(false);
  });
});

describe("openContextMenuFromKeyboard", () => {
  it("dispatches a contextmenu MouseEvent at the element's bottom-left corner", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.getBoundingClientRect = () =>
      ({
        left: 10,
        right: 110,
        top: 20,
        bottom: 40,
        width: 100,
        height: 20,
        x: 10,
        y: 20,
        toJSON: () => {},
      }) as DOMRect;

    let captured: MouseEvent | null = null;
    el.addEventListener("contextmenu", (e) => {
      captured = e as MouseEvent;
    });

    openContextMenuFromKeyboard(el);

    expect(captured).not.toBeNull();
    expect(captured!.type).toBe("contextmenu");
    expect(captured!.bubbles).toBe(true);
    expect(captured!.cancelable).toBe(true);
    expect(captured!.button).toBe(2);
    expect(captured!.clientX).toBe(10);
    expect(captured!.clientY).toBe(44);
  });

  it("bubbles, so a delegated listener on an ancestor still sees it", () => {
    const parent = document.createElement("div");
    const el = document.createElement("div");
    parent.appendChild(el);
    document.body.appendChild(parent);

    let seen = false;
    parent.addEventListener("contextmenu", () => {
      seen = true;
    });

    openContextMenuFromKeyboard(el);
    expect(seen).toBe(true);
  });
});
