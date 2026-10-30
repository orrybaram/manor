import { describe, expect, it } from "vitest";
import { PILL_CLEARANCE, placeNotePopover, toPaneRect } from "./note-placement";

const pane = { width: 800, height: 600 };
const popover = { width: 240, height: 100 };

describe("toPaneRect", () => {
  it("scales a zoomed page's rect into the pane", () => {
    // Page zoomed to 200%: its viewport is half the pane's width in CSS px.
    expect(toPaneRect({ x: 10, y: 20, width: 30, height: 40 }, 400, 800)).toEqual({
      x: 20,
      y: 40,
      width: 60,
      height: 80,
    });
  });

  it("leaves it alone before the page has a width", () => {
    expect(toPaneRect({ x: 1, y: 2, width: 3, height: 4 }, 0, 800)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});

describe("placeNotePopover", () => {
  it("goes under the element, lined up with its pin", () => {
    expect(placeNotePopover({ x: 100, y: 50, width: 200, height: 40 }, pane, popover)).toEqual({ left: 100, top: 98 });
  });

  it("goes above when there is no room below", () => {
    expect(placeNotePopover({ x: 100, y: 400, width: 200, height: 100 }, pane, popover)).toEqual({
      left: 100,
      top: 292,
    });
  });

  it("sits inside a tall element, clear of the pill", () => {
    const { top } = placeNotePopover({ x: 100, y: 20, width: 200, height: 580 }, pane, popover);
    expect(top).toBe(34);
    const low = placeNotePopover({ x: 100, y: 590, width: 10, height: 10 }, { width: 800, height: 120 }, popover);
    expect(low.top + popover.height).toBeLessThanOrEqual(120 - PILL_CLEARANCE + popover.height);
  });

  it("stays inside the pane's sides", () => {
    expect(placeNotePopover({ x: 700, y: 50, width: 50, height: 20 }, pane, popover).left).toBe(552);
    expect(placeNotePopover({ x: -30, y: 50, width: 50, height: 20 }, pane, popover).left).toBe(8);
  });
});
