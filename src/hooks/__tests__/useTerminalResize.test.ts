// @vitest-environment jsdom
/**
 * `shouldSendFit`'s contract: a measurement is judged against the last size
 * *sent*, and the grid is never consulted.
 *
 * That is the whole of the renderer's half of ADR-165. After ADR-164 the grid
 * is driven by the daemon, so it cannot also be the evidence for what the
 * daemon knows — and when the two have drifted apart, a request for the size
 * the pty should already have is the only thing that puts them back. Deciding
 * from the grid suppresses exactly that request, at exactly the moment it is
 * needed, and the pane then wraps at a different width than the program does
 * for the rest of the session.
 *
 * `useFollowerFit`'s own describe block below is regression 6's guard: a
 * follower that becomes the owner must render at its configured size again.
 */

import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  FONT_FLOOR,
  followerFontSize,
  measureCellWidth,
  shouldSendFit,
  useFollowerFit,
} from "../useTerminalResize";

// React only runs effects inside `act` when it is told it is in a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("shouldSendFit", () => {
  it("sends when nothing has been sent yet", () => {
    expect(shouldSendFit({ cols: 100, rows: 30 }, null)).toBe(true);
  });

  it("does not send the size it last sent", () => {
    expect(shouldSendFit({ cols: 100, rows: 30 }, { cols: 100, rows: 30 })).toBe(
      false,
    );
  });

  it.each([
    ["a new width", { cols: 120, rows: 30 }],
    ["a new height", { cols: 100, rows: 40 }],
    ["both", { cols: 120, rows: 40 }],
  ])("sends on %s", (_label, proposed) => {
    expect(shouldSendFit(proposed, { cols: 100, rows: 30 })).toBe(true);
  });

  /**
   * The one that matters. A grid sitting at a size the pty does not have must
   * not change the answer either way — it is not evidence, and treating it as
   * evidence is what made the disagreement permanent.
   */
  it("ignores the grid entirely", () => {
    const lastSent = { cols: 100, rows: 30 };
    // The pane still measures what was already sent: nothing to do, however
    // far the grid has drifted.
    expect(shouldSendFit({ cols: 100, rows: 30 }, lastSent)).toBe(false);
    // The pane measures something new: send it, even though a drifted grid
    // would once have matched and swallowed it.
    expect(shouldSendFit({ cols: 80, rows: 24 }, lastSent)).toBe(true);
  });

  it("drops a measurement that is not a usable size", () => {
    expect(shouldSendFit(undefined, null)).toBe(false);
    expect(shouldSendFit({ cols: 0, rows: 30 }, null)).toBe(false);
    expect(shouldSendFit({ cols: 100, rows: 0 }, null)).toBe(false);
  });
});

/**
 * Follower mode's geometry (ADR-178 D5, ADR-177's rule).
 *
 * The hook around this is DOM and effects; the decision it makes is these five
 * numbers, so they are what is pinned here. The properties that matter are the
 * two ends: at full width a follower must render *exactly* as the winsize owner
 * does — the configured size, not "something close" — and at the narrow end it
 * must stop shrinking rather than become unreadable, leaving the pane to pan.
 */
describe("followerFontSize", () => {
  /** A 13px font whose columns are 8px wide — the desktop's actual shape. */
  const SIZE = 13;
  const CELL = 8;

  it("keeps the configured size when the grid already fits", () => {
    // 160 columns at 8px is 1280px, and the pane is wider than that.
    expect(followerFontSize(SIZE, 1400, 160, CELL, SIZE)).toBe(SIZE);
  });

  it("never scales past the configured size, however wide the pane", () => {
    expect(followerFontSize(SIZE, 4000, 80, CELL, SIZE)).toBe(SIZE);
  });

  it("shrinks to fit a pane narrower than the owner's grid", () => {
    // Half the width the grid wants, so half the font — floored.
    expect(followerFontSize(SIZE, 640, 160, CELL, SIZE)).toBe(6);
    expect(followerFontSize(SIZE, 960, 160, CELL, SIZE)).toBe(9);
  });

  it("stops at the floor and lets the pane scroll", () => {
    expect(followerFontSize(SIZE, 200, 160, CELL, SIZE)).toBe(FONT_FLOOR);
    expect(followerFontSize(SIZE, 1, 160, CELL, SIZE)).toBe(FONT_FLOOR);
  });

  it("floors rather than rounds", () => {
    // 13 * 1200 / (160 * 8) is 12.19: a size that rounds up lands the last
    // column a pixel outside the pane, which is a reflow the follower exists
    // to avoid.
    expect(followerFontSize(SIZE, 1200, 160, CELL, SIZE)).toBe(12);
    expect(Number.isInteger(followerFontSize(SIZE, 1111, 160, CELL, SIZE))).toBe(
      true,
    );
  });

  it("is a fixed point: measuring again at the size it chose keeps it", () => {
    const first = followerFontSize(SIZE, 960, 160, CELL, SIZE);
    const scaledCell = (CELL / SIZE) * first;
    expect(followerFontSize(first, 960, 160, scaledCell, SIZE)).toBe(first);
  });

  it("falls back to the ceiling rather than guessing from nonsense", () => {
    expect(followerFontSize(SIZE, 0, 160, CELL, SIZE)).toBe(SIZE);
    expect(followerFontSize(SIZE, 960, 0, CELL, SIZE)).toBe(SIZE);
    expect(followerFontSize(SIZE, 960, 160, 0, SIZE)).toBe(SIZE);
    expect(followerFontSize(0, 960, 160, CELL, SIZE)).toBe(SIZE);
    expect(followerFontSize(SIZE, NaN, 160, CELL, SIZE)).toBe(SIZE);
  });

  /**
   * A pane configured smaller than the floor is still the owner's rendering at
   * full width, so the ceiling wins over the floor — the alternative is a
   * follower drawing bigger text than the machine it is following.
   */
  it("prefers the configured size to the floor when they disagree", () => {
    expect(followerFontSize(5, 4000, 80, 3, 5)).toBe(5);
  });
});

describe("measureCellWidth", () => {
  /** A `getBoundingClientRect` stub that only carries a width. */
  function probe(text: string, width: number, parentClass?: string) {
    return {
      textContent: text,
      parentElement: parentClass
        ? { classList: { contains: (c: string) => c === parentClass } }
        : null,
      getBoundingClientRect: () => ({ width }),
    };
  }

  function terminal(
    probes: ReturnType<typeof probe>[] | null,
    cssCellWidth?: number,
  ) {
    return {
      element: probes && { querySelectorAll: () => probes },
      _core: {
        _renderService: {
          dimensions: { css: { cell: { width: cssCellWidth } } },
        },
      },
    } as unknown as Parameters<typeof measureCellWidth>[0];
  }

  it("divides the measure element's width by its character count", () => {
    expect(measureCellWidth(terminal([probe("W".repeat(32), 256)]))).toBe(8);
  });

  it("skips the width-cache spans that share the class", () => {
    const cache = probe("abc", 300, "xterm-width-cache-measure-container");
    expect(measureCellWidth(terminal([cache, probe("WW", 16)]))).toBe(8);
  });

  it("falls back to the render service when there is no measure element", () => {
    expect(measureCellWidth(terminal([], 7.5))).toBe(7.5);
    expect(measureCellWidth(terminal(null, 7.5))).toBe(7.5);
  });

  it("answers null rather than zero when nothing has been measured yet", () => {
    expect(measureCellWidth(terminal([probe("", 0)], 0))).toBe(null);
    expect(measureCellWidth(terminal(null))).toBe(null);
  });
});

/**
 * `useFollowerFit`'s font restore (regression 6, ADR-182 ticket 1).
 *
 * jsdom has no `ResizeObserver`; a no-op stub is enough here since nothing in
 * this test resizes the container after mount.
 */
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

/** The slice of `Terminal` the hook touches. */
interface FakeTerm {
  options: { fontSize: number };
  cols: number;
  rows: number;
  element: null;
  resize: (cols: number, rows: number) => void;
  onResize: (cb: () => void) => { dispose: () => void };
  _core: { _renderService: { dimensions: { css: { cell: { width: number } } } } };
}

/** A 13px font whose columns are 8px wide, same as `followerFontSize`'s tests. */
function fakeTerm(fontSize = 13, cellWidth = 8): FakeTerm {
  const term: Partial<FakeTerm> = {
    options: { fontSize },
    cols: 160,
    rows: 40,
    element: null,
    onResize: () => ({ dispose: () => {} }),
    _core: { _renderService: { dimensions: { css: { cell: { width: cellWidth } } } } },
  };
  term.resize = (cols, rows) => {
    term.cols = cols;
    term.rows = rows;
  };
  return term as FakeTerm;
}

function Harness(props: {
  term: FakeTerm;
  target: { cols: number; rows: number } | null;
  enabled: boolean;
  width: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // A callback ref, so the fake dimensions land on the real DOM node before
  // `useFollowerFit`'s own `useLayoutEffect` reads `clientWidth` in the same
  // commit — jsdom's elements otherwise measure 0×0.
  const setRef = (el: HTMLDivElement | null) => {
    ref.current = el;
    if (el) {
      Object.defineProperty(el, "clientWidth", {
        value: props.width,
        configurable: true,
      });
      Object.defineProperty(el, "clientHeight", {
        value: 400,
        configurable: true,
      });
    }
  };
  useFollowerFit(ref, props.term as unknown as Terminal, props.target, props.enabled);
  return createElement("div", { ref: setRef, "data-testid": "container" });
}

describe("useFollowerFit", () => {
  let host: HTMLDivElement;
  let root: Root;

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
  });

  it("restores the configured font size when a follower becomes the owner", () => {
    const term = fakeTerm(13, 8);
    // 640px at 8px/col fits 80 of the owner's 160 columns, so the follower
    // must shrink — see `followerFontSize`'s own tests for this exact case.
    act(() => {
      root.render(
        createElement(Harness, {
          term,
          target: { cols: 160, rows: 40 },
          enabled: true,
          width: 640,
        }),
      );
    });
    expect(term.options.fontSize).toBe(6);
    expect(term.cols).toBe(160);

    // The winsize owner now — regression 6 was this shrink surviving.
    act(() => {
      root.render(
        createElement(Harness, {
          term,
          target: null,
          enabled: false,
          width: 640,
        }),
      );
    });
    expect(term.options.fontSize).toBe(13);
  });

  it("captures the ceiling fresh for each follower session", () => {
    const term = fakeTerm(13, 8);
    act(() => {
      root.render(
        createElement(Harness, {
          term,
          target: { cols: 160, rows: 40 },
          enabled: true,
          width: 640,
        }),
      );
    });
    expect(term.options.fontSize).toBe(6);

    act(() => {
      root.render(
        createElement(Harness, { term, target: null, enabled: false, width: 640 }),
      );
    });
    expect(term.options.fontSize).toBe(13);

    // A second span as a follower shrinks from the restored size, not from
    // whatever the first span left behind.
    act(() => {
      root.render(
        createElement(Harness, {
          term,
          target: { cols: 160, rows: 40 },
          enabled: true,
          width: 640,
        }),
      );
    });
    expect(term.options.fontSize).toBe(6);
  });
});
