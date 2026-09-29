import { describe, expect, it } from "vitest";
import {
  FRAME_GAP,
  LEAD_COMPACT_WIDTH,
  RAIL_WIDTH,
  windowLeadInset,
  windowLeadWidth,
} from "../window-lead";

describe("windowLeadWidth", () => {
  it("matches the sidebar width in full mode", () => {
    expect(windowLeadWidth("full", 240)).toBe(240);
  });

  it("never shrinks below compact in full mode", () => {
    expect(windowLeadWidth("full", 160)).toBe(LEAD_COMPACT_WIDTH);
  });

  it("is compact in rail and hidden modes", () => {
    expect(windowLeadWidth("rail", 240)).toBe(LEAD_COMPACT_WIDTH);
    expect(windowLeadWidth("hidden", 240)).toBe(LEAD_COMPACT_WIDTH);
  });
});

describe("windowLeadInset", () => {
  it("is zero in full mode when the sidebar fits the lead", () => {
    expect(windowLeadInset("full", 240)).toBe(0);
  });

  it("covers the lead's overhang past a narrow sidebar", () => {
    expect(windowLeadInset("full", 160)).toBe(LEAD_COMPACT_WIDTH - 160 - 2 * FRAME_GAP);
  });

  it("covers the lead's overhang past the rail", () => {
    expect(windowLeadInset("rail", 240)).toBe(LEAD_COMPACT_WIDTH - RAIL_WIDTH - FRAME_GAP);
    expect(windowLeadInset("rail", 240)).toBe(116);
  });

  it("is the whole lead when the sidebar is hidden", () => {
    expect(windowLeadInset("hidden", 240)).toBe(194);
  });
});
