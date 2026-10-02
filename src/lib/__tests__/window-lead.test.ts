import { describe, expect, it } from "vitest";
import {
  FRAME_GAP,
  LEAD_COMPACT_WIDTH,
  LIGHTS_WIDTH,
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

  it("holds only the traffic lights in rail mode", () => {
    expect(windowLeadWidth("rail", 240)).toBe(LIGHTS_WIDTH);
  });

  it("is compact in hidden mode", () => {
    expect(windowLeadWidth("hidden", 240)).toBe(LEAD_COMPACT_WIDTH);
  });
});

describe("windowLeadInset", () => {
  it("is zero in full mode when the sidebar fits the lead", () => {
    expect(windowLeadInset("full", 240)).toBe(0);
  });

  it("covers the lead's overhang past a narrow sidebar", () => {
    expect(windowLeadInset("full", 140)).toBe(LEAD_COMPACT_WIDTH - 140 - 2 * FRAME_GAP);
  });

  it("is zero in rail mode, where the lights fit over the rail", () => {
    expect(windowLeadInset("rail", 240)).toBe(0);
  });

  it("is the whole lead when the sidebar is hidden", () => {
    expect(windowLeadInset("hidden", 240)).toBe(166);
  });
});
