// @vitest-environment jsdom
/**
 * A right swipe from the left half of the screen opens the drawer — unless a
 * dialog, sheet or menu is on screen, whose gesture it is.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSwipeToOpenDrawer } from "../useDrawerSwipe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(props: { onOpen: () => void }) {
  useSwipeToOpenDrawer(props.onOpen);
  return null;
}

let container: HTMLDivElement;
let root: Root;
const onOpen = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(Harness, { onOpen })));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  onOpen.mockReset();
});

function touch(type: string, x: number, y = 100): void {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y };
  Object.defineProperty(e, "touches", { value: type === "touchend" ? [] : [point] });
  Object.defineProperty(e, "changedTouches", { value: [point] });
  document.body.dispatchEvent(e);
}

function swipeRight(): void {
  touch("touchstart", 50);
  touch("touchmove", 70);
  touch("touchmove", 120);
  touch("touchend", 120);
}

function mountOverlay(role: string, state?: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", role);
  if (state) el.setAttribute("data-state", state);
  document.body.appendChild(el);
  return el;
}

describe("useSwipeToOpenDrawer", () => {
  it("opens the drawer on a right swipe from the left half", () => {
    swipeRight();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("leaves a vertical drag alone", () => {
    touch("touchstart", 50, 100);
    touch("touchmove", 52, 140);
    touch("touchmove", 120, 150);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each(["dialog", "alertdialog", "menu"])("does nothing while a %s is open", (role) => {
    mountOverlay(role, "open");
    swipeRight();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("ignores an overlay on its way out", () => {
    mountOverlay("dialog", "closed");
    swipeRight();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("does not open when an overlay opens mid-swipe", () => {
    touch("touchstart", 50);
    touch("touchmove", 70);
    mountOverlay("menu");
    touch("touchmove", 120);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
