import { describe, expect, it } from "vitest";
import {
  MAX_PULL_PX,
  TRIGGER_PULL_PX,
  dampPull,
  pullTriggers,
} from "../usePullToRefresh";

describe("dampPull", () => {
  it("halves the finger's travel", () => {
    expect(dampPull(40)).toBe(20);
  });

  it("caps at the maximum", () => {
    expect(dampPull(1000)).toBe(MAX_PULL_PX);
  });

  it("ignores an upward drag", () => {
    expect(dampPull(-30)).toBe(0);
  });
});

describe("pullTriggers", () => {
  it("needs the trigger distance", () => {
    expect(pullTriggers(TRIGGER_PULL_PX - 1)).toBe(false);
    expect(pullTriggers(TRIGGER_PULL_PX)).toBe(true);
  });

  it("is reachable through damping", () => {
    expect(pullTriggers(dampPull(128))).toBe(true);
    expect(pullTriggers(dampPull(100))).toBe(false);
  });
});
