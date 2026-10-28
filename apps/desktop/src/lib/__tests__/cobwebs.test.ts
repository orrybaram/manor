// @vitest-environment happy-dom
import { afterEach, describe, it, expect } from "vitest";
import {
  cobwebLevel,
  createTabSightings,
  frontTabIds,
  HALLOWEEN_OVERRIDE_KEY,
  isHalloweenWeek,
} from "../cobwebs";
import { emptyViewport } from "../layout/viewport";

const MIN = 60_000;

describe("isHalloweenWeek", () => {
  afterEach(() => localStorage.removeItem(HALLOWEEN_OVERRIDE_KEY));

  it("runs from Oct 25 through Nov 1 in local time", () => {
    expect(isHalloweenWeek(new Date(2026, 9, 24, 23, 59))).toBe(false);
    expect(isHalloweenWeek(new Date(2026, 9, 25, 0, 0))).toBe(true);
    expect(isHalloweenWeek(new Date(2026, 9, 31, 12, 0))).toBe(true);
    expect(isHalloweenWeek(new Date(2026, 10, 1, 23, 59))).toBe(true);
    expect(isHalloweenWeek(new Date(2026, 10, 2, 0, 0))).toBe(false);
    expect(isHalloweenWeek(new Date(2026, 9, 20))).toBe(false);
  });

  it("holds on any day the override is set", () => {
    localStorage.setItem(HALLOWEEN_OVERRIDE_KEY, "1");
    expect(isHalloweenWeek(new Date(2026, 4, 1))).toBe(true);
  });
});

describe("cobwebLevel", () => {
  it("grows at 5, 20 and 60 minutes unseen", () => {
    expect(cobwebLevel(4.9 * MIN)).toBe(0);
    expect(cobwebLevel(5 * MIN)).toBe(1);
    expect(cobwebLevel(20 * MIN)).toBe(2);
    expect(cobwebLevel(60 * MIN)).toBe(3);
    expect(cobwebLevel(600 * MIN)).toBe(3);
  });
});

describe("frontTabIds", () => {
  it("is every panel's selected tab across workspaces", () => {
    const a = { ...emptyViewport(), selectedTabIds: { p1: "t1", p2: "t2" } };
    const b = { ...emptyViewport(), selectedTabIds: { p3: "t3" } };
    expect(frontTabIds({ "/a": a, "/b": b })).toEqual(new Set(["t1", "t2", "t3"]));
  });
});

describe("createTabSightings", () => {
  it("counts a tab never on show from when the window opened", () => {
    const sightings = createTabSightings(0);
    expect(sightings.unseenFor("t1", 30 * MIN)).toBe(30 * MIN);
  });

  it("is 0 while the tab is on show", () => {
    const sightings = createTabSightings(0);
    sightings.update(new Set(["t1"]), 10 * MIN);
    expect(sightings.unseenFor("t1", 90 * MIN)).toBe(0);
  });

  it("counts from when the tab left the front", () => {
    const sightings = createTabSightings(0);
    sightings.update(new Set(["t1"]), 0);
    sightings.update(new Set(["t2"]), 40 * MIN);
    expect(sightings.unseenFor("t1", 50 * MIN)).toBe(10 * MIN);
    expect(sightings.unseenFor("t2", 50 * MIN)).toBe(0);
  });
});
