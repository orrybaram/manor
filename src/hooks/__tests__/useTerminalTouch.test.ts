// @vitest-environment jsdom
/**
 * ADR-181 D5/D6: a finger on a phone-mode terminal means one of three things
 * — a tap focuses xterm (inside the gesture, so iOS raises the keyboard), a
 * long-press opens the pane menu, a drag scrolls or pans.
 *
 * Nothing here can raise a soft keyboard; what can be pinned down is the
 * precondition iOS sets for one — `focus()` has *already happened* by the time
 * `dispatchEvent` returns, with no `await` in between — and the
 * classification that decides whether it happens at all.
 */
import { act, createElement, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as ContextMenu from "@radix-ui/react-context-menu";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LONG_PRESS_MS,
  TAP_SLOP_PX,
  classifyRelease,
  dragAxis,
  linesForPixels,
  useTerminalTouch,
} from "../useTerminalTouch";

// React only runs effects inside `act` when it is told it is in a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("dragAxis", () => {
  it("is none while the finger stays inside the slop", () => {
    expect(dragAxis(0, 0)).toBe("none");
    expect(dragAxis(3, -4)).toBe("none");
    expect(dragAxis(TAP_SLOP_PX, 0)).toBe("none");
  });

  it("picks the dominant axis once the finger leaves it", () => {
    expect(dragAxis(0, TAP_SLOP_PX + 1)).toBe("y");
    expect(dragAxis(-(TAP_SLOP_PX + 1), 2)).toBe("x");
    expect(dragAxis(8, -9)).toBe("y");
  });
});

describe("classifyRelease", () => {
  it("is a tap for a quick, still finger", () => {
    expect(classifyRelease({ axis: "none", heldMs: 120, menuOpened: false })).toBe("tap");
  });

  it("is a long-press once held for Radix's threshold, menu or not", () => {
    expect(
      classifyRelease({ axis: "none", heldMs: LONG_PRESS_MS, menuOpened: false }),
    ).toBe("long-press");
  });

  it("is a long-press whenever the menu opened under the finger", () => {
    // Android's native contextmenu can beat Radix's 700 ms timer.
    expect(classifyRelease({ axis: "none", heldMs: 450, menuOpened: true })).toBe(
      "long-press",
    );
  });

  it("is a drag once the finger left the slop, however it ended", () => {
    expect(classifyRelease({ axis: "y", heldMs: 50, menuOpened: false })).toBe("drag");
    expect(classifyRelease({ axis: "x", heldMs: 2_000, menuOpened: true })).toBe("drag");
  });
});

describe("linesForPixels", () => {
  it("scrolls whole lines and carries the rest", () => {
    expect(linesForPixels(35, 16)).toEqual({ lines: 2, remainder: 3 });
    expect(linesForPixels(-35, 16)).toEqual({ lines: -2, remainder: -3 });
    expect(linesForPixels(5, 16)).toEqual({ lines: 0, remainder: 5 });
  });

  it("scrolls nothing without a cell height to measure against", () => {
    expect(linesForPixels(100, 0)).toEqual({ lines: 0, remainder: 0 });
  });
});

/** The slice of `Terminal` the hook touches, with the calls spied on. */
interface FakeTerm {
  element: HTMLDivElement;
  screen: HTMLDivElement;
  textarea: HTMLTextAreaElement;
  rows: number;
  buffer: { active: { type: "normal" | "alternate" } };
  modes: { mouseTrackingMode: string };
  focus: ReturnType<typeof vi.fn>;
  scrollLines: ReturnType<typeof vi.fn>;
}

function fakeTerm(): FakeTerm {
  const element = document.createElement("div");
  element.className = "xterm";
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  // 20 rows at 16 px a row.
  Object.defineProperty(screen, "clientHeight", { value: 320 });
  const textarea = document.createElement("textarea");
  textarea.className = "xterm-helper-textarea";
  screen.appendChild(textarea);
  element.appendChild(screen);
  const term: FakeTerm = {
    element,
    screen,
    textarea,
    rows: 20,
    buffer: { active: { type: "normal" } },
    modes: { mouseTrackingMode: "none" },
    focus: vi.fn(() => textarea.focus()),
    scrollLines: vi.fn(),
  };
  return term;
}

type TouchPoint = { x: number; y: number };

/**
 * Dispatch a touch event carrying `touches` — jsdom has no `Touch`
 * constructor, so the list is attached by hand. Only `clientX`/`clientY` and
 * the list's length are read.
 */
function touch(target: EventTarget, type: string, touches: TouchPoint[]): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const list = touches.map((p) => ({ clientX: p.x, clientY: p.y }));
  Object.defineProperty(event, "touches", { value: list });
  Object.defineProperty(event, "changedTouches", { value: list });
  target.dispatchEvent(event);
}

let host: HTMLDivElement;
let root: Root;
let api: ReturnType<typeof useTerminalTouch>;

function Harness(props: {
  term: FakeTerm;
  enabled: boolean;
  onApi: (value: ReturnType<typeof useTerminalTouch>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const value = useTerminalTouch(ref, props.term as unknown as Terminal, props.enabled);
  const { onApi } = props;
  useEffect(() => onApi(value));
  return createElement("div", { ref, "data-testid": "container" });
}

/** Mount the hook over `term`, with xterm's element inside the container. */
function mount(term: FakeTerm, enabled = true): HTMLElement {
  act(() => {
    root.render(
      createElement(Harness, {
        term,
        enabled,
        onApi: (value) => {
          api = value;
        },
      }),
    );
  });
  const rendered = host.querySelector<HTMLElement>('[data-testid="container"]');
  if (!rendered) throw new Error("harness did not render");
  rendered.appendChild(term.element);
  return rendered;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.useRealTimers();
});

describe("useTerminalTouch — tap", () => {
  it("focuses xterm synchronously inside the touchend, before dispatch returns", () => {
    const term = fakeTerm();
    mount(term);

    touch(term.screen, "touchstart", [{ x: 50, y: 50 }]);
    expect(term.focus).not.toHaveBeenCalled();
    touch(term.screen, "touchend", []);
    // No await, no timer, no frame: iOS only raises the keyboard for a focus
    // made inside the gesture's own task.
    expect(term.focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(term.textarea);
  });

  it("re-focuses a textarea the desk already focused, so iOS sees a focus change", () => {
    const term = fakeTerm();
    mount(term);
    // What the mount's t.focus() leaves behind: focused, but with no keyboard.
    term.textarea.focus();
    const blur = vi.spyOn(term.textarea, "blur");

    touch(term.screen, "touchstart", [{ x: 50, y: 50 }]);
    touch(term.screen, "touchend", []);

    expect(blur).toHaveBeenCalledTimes(1);
    expect(term.focus).toHaveBeenCalledTimes(1);
    expect(blur.mock.invocationCallOrder[0]).toBeLessThan(
      term.focus.mock.invocationCallOrder[0],
    );
    expect(document.activeElement).toBe(term.textarea);
  });

  it("still taps through a wobble inside the slop", () => {
    const term = fakeTerm();
    mount(term);

    touch(term.screen, "touchstart", [{ x: 50, y: 50 }]);
    touch(term.screen, "touchmove", [{ x: 53, y: 46 }]);
    touch(term.screen, "touchend", []);

    expect(term.focus).toHaveBeenCalledTimes(1);
    expect(term.scrollLines).not.toHaveBeenCalled();
  });

  it("does not steal focus from a control laid over the terminal", () => {
    const term = fakeTerm();
    const container = mount(term);
    // The search bar sits inside the container but outside xterm.
    const search = document.createElement("input");
    container.appendChild(search);

    touch(search, "touchstart", [{ x: 5, y: 5 }]);
    touch(search, "touchend", []);

    expect(term.focus).not.toHaveBeenCalled();
  });

  it("does nothing on the desk", () => {
    const term = fakeTerm();
    mount(term, false);

    touch(term.screen, "touchstart", [{ x: 50, y: 50 }]);
    touch(term.screen, "touchend", []);

    expect(term.focus).not.toHaveBeenCalled();
    expect(api.triggerProps).toEqual({});
  });
});

describe("useTerminalTouch — long-press", () => {
  it("does not focus when the menu opened under the finger", () => {
    const term = fakeTerm();
    mount(term);

    touch(term.screen, "touchstart", [{ x: 50, y: 50 }]);
    api.onMenuOpenChange(true);
    touch(term.screen, "touchend", []);

    expect(term.focus).not.toHaveBeenCalled();
  });

  it("does not focus after a hold past Radix's threshold", () => {
    vi.useFakeTimers();
    const term = fakeTerm();
    mount(term);

    touch(term.screen, "touchstart", [{ x: 50, y: 50 }]);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    touch(term.screen, "touchend", []);

    expect(term.focus).not.toHaveBeenCalled();
  });

  it("keeps Radix's timer alive through a wobble, and lets a drag cancel it", () => {
    const term = fakeTerm();
    mount(term);
    const { onPointerDown, onPointerMove } = api.triggerProps;
    const pointer = (x: number, y: number) => {
      const preventDefault = vi.fn();
      return {
        event: {
          pointerType: "touch",
          clientX: x,
          clientY: y,
          target: term.screen,
          preventDefault,
        } as unknown as React.PointerEvent,
        preventDefault,
      };
    };

    onPointerDown!(pointer(50, 50).event);
    const wobble = pointer(54, 47);
    onPointerMove!(wobble.event);
    expect(wobble.preventDefault).toHaveBeenCalled();

    const drag = pointer(50, 50 + TAP_SLOP_PX + 5);
    onPointerMove!(drag.event);
    expect(drag.preventDefault).not.toHaveBeenCalled();

    // Back inside the slop: the drag already cancelled the press for good.
    const back = pointer(51, 51);
    onPointerMove!(back.event);
    expect(back.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves a mouse's moves to Radix", () => {
    const term = fakeTerm();
    mount(term);
    const preventDefault = vi.fn();
    const mouse = {
      pointerType: "mouse",
      clientX: 50,
      clientY: 50,
      target: term.screen,
      preventDefault,
    } as unknown as React.PointerEvent;
    api.triggerProps.onPointerDown!(mouse);
    api.triggerProps.onPointerMove!(mouse);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("opens a real Radix context menu despite a finger's wobble", () => {
    vi.useFakeTimers();
    const term = fakeTerm();
    const onOpenChange = vi.fn();

    function MenuHarness() {
      const ref = useRef<HTMLDivElement>(null);
      const t = useTerminalTouch(ref, term as unknown as Terminal, true);
      return createElement(
        ContextMenu.Root,
        {
          onOpenChange: (open: boolean) => {
            t.onMenuOpenChange(open);
            onOpenChange(open);
          },
        },
        createElement(
          ContextMenu.Trigger,
          { asChild: true, ...t.triggerProps },
          createElement("div", { ref, "data-testid": "trigger" }),
        ),
      );
    }

    act(() => {
      root.render(createElement(MenuHarness));
    });
    const trigger = host.querySelector<HTMLElement>('[data-testid="trigger"]')!;
    trigger.appendChild(term.element);

    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: "touch",
        clientX: x,
        clientY: y,
      });

    act(() => {
      term.screen.dispatchEvent(pointer("pointerdown", 50, 50));
      touch(term.screen, "touchstart", [{ x: 50, y: 50 }]);
      term.screen.dispatchEvent(pointer("pointermove", 53, 52));
      touch(term.screen, "touchmove", [{ x: 53, y: 52 }]);
    });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(onOpenChange).toHaveBeenCalledWith(true);

    act(() => {
      term.screen.dispatchEvent(pointer("pointerup", 53, 52));
      touch(term.screen, "touchend", []);
    });
    // A long-press is never also a tap: no keyboard under the menu.
    expect(term.focus).not.toHaveBeenCalled();
  });
});

describe("useTerminalTouch — drag", () => {
  it("scrolls the scrollback by the finger's travel, not a tap", () => {
    const term = fakeTerm();
    mount(term);

    touch(term.screen, "touchstart", [{ x: 50, y: 300 }]);
    // Leaves the slop upward; scrolling counts from here.
    touch(term.screen, "touchmove", [{ x: 50, y: 280 }]);
    expect(term.scrollLines).not.toHaveBeenCalled();
    // 40 px up at 16 px a row: two lines, 8 px carried.
    touch(term.screen, "touchmove", [{ x: 50, y: 240 }]);
    expect(term.scrollLines).toHaveBeenLastCalledWith(2);
    // The carried 8 plus 8 more make a third line.
    touch(term.screen, "touchmove", [{ x: 50, y: 232 }]);
    expect(term.scrollLines).toHaveBeenLastCalledWith(1);
    // Finger back down: back up the scrollback.
    touch(term.screen, "touchmove", [{ x: 50, y: 264 }]);
    expect(term.scrollLines).toHaveBeenLastCalledWith(-2);

    touch(term.screen, "touchend", []);
    expect(term.focus).not.toHaveBeenCalled();
  });

  it("leaves a horizontal drag to the browser's pan", () => {
    const term = fakeTerm();
    mount(term);

    touch(term.screen, "touchstart", [{ x: 200, y: 100 }]);
    touch(term.screen, "touchmove", [{ x: 170, y: 104 }]);
    touch(term.screen, "touchmove", [{ x: 120, y: 140 }]);
    touch(term.screen, "touchend", []);

    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(term.focus).not.toHaveBeenCalled();
  });

  it("hands a TUI in the alternate screen a wheel event at the finger", () => {
    const term = fakeTerm();
    term.buffer.active.type = "alternate";
    mount(term);
    const wheels: WheelEvent[] = [];
    term.element.addEventListener("wheel", (e) => wheels.push(e as WheelEvent));

    touch(term.screen, "touchstart", [{ x: 50, y: 300 }]);
    touch(term.screen, "touchmove", [{ x: 50, y: 280 }]);
    touch(term.screen, "touchmove", [{ x: 50, y: 250 }]);

    expect(term.scrollLines).not.toHaveBeenCalled();
    expect(wheels).toHaveLength(1);
    expect(wheels[0].deltaY).toBe(30);
    expect(wheels[0].clientY).toBe(250);
  });

  it("ignores a second finger", () => {
    const term = fakeTerm();
    mount(term);

    touch(term.screen, "touchstart", [
      { x: 50, y: 50 },
      { x: 150, y: 150 },
    ]);
    touch(term.screen, "touchend", []);

    expect(term.focus).not.toHaveBeenCalled();
  });

  it("forgets a gesture the browser cancelled", () => {
    const term = fakeTerm();
    mount(term);

    touch(term.screen, "touchstart", [{ x: 50, y: 50 }]);
    touch(term.screen, "touchcancel", []);
    touch(term.screen, "touchend", []);

    expect(term.focus).not.toHaveBeenCalled();
  });
});
