import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCK_FRACTION,
  MIN_DOCK_PANE_PX,
  clampDockFraction,
  dockFractionAt,
  dockViewState,
  dockViewStateKey,
  isDockRect,
  overlaysCover,
  rectsOverlap,
  toViewBounds,
  type DockViewInputs,
} from "../devtools-dock";

describe("clampDockFraction", () => {
  it("keeps a share both sides have room for", () => {
    expect(clampDockFraction(0.4, 1000)).toBe(0.4);
  });

  it("leaves DevTools and the page at least the minimum each", () => {
    const pane = 1005;
    expect(clampDockFraction(0.01, pane) * (pane - 5)).toBeCloseTo(MIN_DOCK_PANE_PX);
    expect((1 - clampDockFraction(0.99, pane)) * (pane - 5)).toBeCloseTo(MIN_DOCK_PANE_PX);
  });

  it("splits evenly a pane too small for both minimums", () => {
    expect(clampDockFraction(0.1, 200)).toBe(0.5);
  });

  it("falls back to the default for a non-finite share", () => {
    expect(clampDockFraction(Number.NaN, 1000)).toBe(DEFAULT_DOCK_FRACTION);
  });
});

describe("dockFractionAt", () => {
  const pane = { x: 100, y: 50, width: 805, height: 1005 };

  it("measures from the bottom edge when docked at the bottom", () => {
    // Handle centred 400px above the bottom edge.
    const y = pane.y + pane.height - 400 - 2.5;
    expect(dockFractionAt("bottom", { x: 0, y }, pane)).toBeCloseTo(0.4);
  });

  it("measures from the right edge when docked right", () => {
    const x = pane.x + pane.width - 320 - 2.5;
    expect(dockFractionAt("right", { x, y: 0 }, pane)).toBeCloseTo(0.4);
  });

  it("clamps a drag past the pane", () => {
    const share = dockFractionAt("bottom", { x: 0, y: 5000 }, pane);
    expect(share * (pane.height - 5)).toBeCloseTo(MIN_DOCK_PANE_PX);
  });
});

describe("toViewBounds", () => {
  const content = { width: 1200, height: 800 };

  it("passes a whole-pixel slot through at zoom 1", () => {
    expect(toViewBounds({ x: 10, y: 20, width: 300, height: 200 }, 1, content)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
  });

  it("scales by the renderer's zoom and rounds edges, not sizes", () => {
    // 10.4*1.25=13 and 110.4*1.25=138: the far edge lands where the next
    // element's near edge would, so no hairline opens up.
    expect(toViewBounds({ x: 10.4, y: 0, width: 100, height: 10 }, 1.25, content)).toEqual({
      x: 13,
      y: 0,
      width: 125,
      height: 13,
    });
  });

  it("clips to the window's content area", () => {
    expect(toViewBounds({ x: 1000, y: 700, width: 400, height: 400 }, 1, content)).toEqual({
      x: 1000,
      y: 700,
      width: 200,
      height: 100,
    });
  });

  it("is null for a slot with nothing left on screen", () => {
    expect(toViewBounds({ x: 1300, y: 0, width: 100, height: 100 }, 1, content)).toBeNull();
    expect(toViewBounds({ x: 0, y: 0, width: 0, height: 100 }, 1, content)).toBeNull();
  });

  it("treats a bad zoom factor as 1", () => {
    expect(toViewBounds({ x: 1, y: 1, width: 2, height: 2 }, 0, content)).toEqual({
      x: 1,
      y: 1,
      width: 2,
      height: 2,
    });
  });
});

describe("isDockRect", () => {
  it("accepts finite numbers only", () => {
    expect(isDockRect({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(isDockRect({ x: 0, y: 0, width: Number.NaN, height: 1 })).toBe(false);
    expect(isDockRect({ x: 0, y: 0, width: "1", height: 1 })).toBe(false);
    expect(isDockRect(null)).toBe(false);
  });
});

describe("overlays", () => {
  const slot = { x: 0, y: 400, width: 600, height: 300 };

  it("overlap needs shared area, not a shared edge", () => {
    expect(rectsOverlap(slot, { x: 0, y: 700, width: 10, height: 10 })).toBe(false);
    expect(rectsOverlap(slot, { x: 590, y: 690, width: 20, height: 20 })).toBe(true);
  });

  it("a menu covers the slot only where it overlaps it", () => {
    const menu = { rect: { x: 10, y: 10, width: 100, height: 100 }, modal: false };
    expect(overlaysCover(slot, [menu])).toBe(false);
    expect(
      overlaysCover(slot, [{ ...menu, rect: { ...menu.rect, y: 350 } }]),
    ).toBe(true);
  });

  it("a modal dialog covers the slot wherever it sits", () => {
    expect(
      overlaysCover(slot, [{ rect: { x: 10, y: 10, width: 100, height: 100 }, modal: true }]),
    ).toBe(true);
  });
});

describe("dockViewState", () => {
  const base: DockViewInputs = {
    slot: { x: 10.4, y: 300.6, width: 500, height: 200 },
    rendered: true,
    viewport: { width: 1200, height: 800 },
    dragging: false,
    resizing: false,
    covered: false,
  };

  it("shows the view over the rounded slot", () => {
    expect(dockViewState(base)).toEqual({
      kind: "shown",
      rect: { x: 10, y: 301, width: 500, height: 200 },
    });
  });

  it("hides it for a slot not rendered, zero-size or off screen", () => {
    expect(dockViewState({ ...base, rendered: false }).kind).toBe("hidden");
    expect(dockViewState({ ...base, slot: { ...base.slot, height: 0 } }).kind).toBe("hidden");
    expect(dockViewState({ ...base, slot: { ...base.slot, x: -9999 } }).kind).toBe("hidden");
  });

  it("puts up the snapshot under an overlay, a drag or a resize", () => {
    expect(dockViewState({ ...base, covered: true }).kind).toBe("covered");
    expect(dockViewState({ ...base, dragging: true }).kind).toBe("covered");
    expect(dockViewState({ ...base, resizing: true }).kind).toBe("covered");
  });

  it("an off-screen slot is hidden even under an overlay", () => {
    expect(dockViewState({ ...base, rendered: false, covered: true }).kind).toBe("hidden");
  });

  it("keys a shown state by its rect and the device pixel ratio", () => {
    const shown = dockViewState(base);
    expect(dockViewStateKey(shown, 1)).not.toBe(dockViewStateKey(shown, 2));
    expect(dockViewStateKey({ kind: "covered" }, 1)).toBe("covered");
  });
});
