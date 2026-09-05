import { describe, it, expect } from "vitest";
import { BADGE_META } from "../badges";

/**
 * Literal copy of the ids in `electron/stats-badges.ts`, in order. The renderer
 * cannot import from `electron/`, so this hardcoded list is the seam that fails
 * loudly when the two catalogues drift.
 */
const ELECTRON_BADGE_IDS = [
  "first-blood",
  "executioner",
  "massacre",
  "delegator",
  "swarm",
  "quick-draw",
  "gardener",
  "reaper",
  "shipper",
  "centurion",
  "week-streak",
  "month-streak",
];

describe("BADGE_META", () => {
  it("has twelve badges", () => {
    expect(BADGE_META).toHaveLength(12);
  });

  it("has unique ids", () => {
    const ids = BADGE_META.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("matches the electron catalogue ids and order", () => {
    expect(BADGE_META.map((b) => b.id)).toEqual(ELECTRON_BADGE_IDS);
  });

  it("gives every badge a title and description", () => {
    for (const badge of BADGE_META) {
      expect(badge.title.length).toBeGreaterThan(0);
      expect(badge.description.length).toBeGreaterThan(0);
    }
  });
});
