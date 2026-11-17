import { describe, expect, it } from "vitest";
import {
  BRUSH_RADIUS,
  POP_SECONDS,
  SETTLE_SECONDS,
  breath,
  brushHits,
  pop,
  ringWake,
  settleMode,
  settlePoint,
  settleStillness,
  wakeSwell,
} from "./floor-effects";
import { P } from "./floor-layout";

describe("wake and breath", () => {
  it("swells once over 1.6s, then breathes on a 2.4s cycle", () => {
    expect(wakeSwell(0)).toBe(0);
    expect(wakeSwell(0.8)).toBeCloseTo(1);
    expect(wakeSwell(1.7)).toBe(0);
    expect(breath(1)).toBe(0);
    expect(breath(1.6 + 1.2)).toBeCloseTo(1);
    expect(breath(1.6 + 2.4)).toBeCloseTo(0);
  });
});

describe("brushHits", () => {
  const points = [
    { index: 0, x: 0, y: 0 },
    { index: 1, x: 100, y: 0 },
    { index: 2, x: 50, y: 200 },
  ];

  it("hits what the Large brush passes along the stroke", () => {
    expect(BRUSH_RADIUS).toBeCloseTo(2.6 * 13);
    expect([...brushHits(points, 0, 0, 100, 0)].sort()).toEqual([0, 1]);
    expect([...brushHits(points, 50, 200, 50, 200)]).toEqual([2]);
    expect(brushHits(points, 50, 100, 50, 100).size).toBe(0);
  });
});

describe("pop", () => {
  it("swells to 1.55× and brightens by .35, then is gone by .3s", () => {
    expect(pop(0, 2, 0.5)).toEqual({ r: 2, a: 0.5 });
    const top = pop(0.07, 2, 0.5)!;
    expect(top.r).toBeCloseTo(3.1);
    expect(top.a).toBeCloseTo(0.85);
    expect(pop(0.2, 2, 0.5)!.r).toBeLessThan(3.1);
    expect(pop(POP_SECONDS, 2, 0.5)).toBeNull();
  });
});

describe("ringWake", () => {
  it("lights a ring that spreads and fades, soft-capped below 1", () => {
    const at = (t: number, d: number) => ringWake(d, 0, [{ x: 0, y: 0, t }])[0];
    // Early on, near; later, farther out.
    expect(at(0.15, P)).toBeGreaterThan(at(0.15, P * 3));
    expect(at(0.6, P * 3)).toBeGreaterThan(at(0.6, P));
    expect(at(0.89, P * 3)).toBeLessThan(at(0.4, P * 2.5));
    const many = ringWake(P, 0, Array.from({ length: 30 }, () => ({ x: 0, y: 0, t: 0.15 })))[0];
    expect(many).toBeLessThan(1);
    expect(ringWake(P * 20, 0, [{ x: 0, y: 0, t: 0.3 }])[0]).toBe(0);
  });
});

describe("Settle", () => {
  const box = { x0: 0, x1: 13 * 16, y0: 0, y1: 13 * 11 };

  it("cycles its mode with the meal count", () => {
    expect(settleMode(0)).toEqual([1, 2]);
    expect(settleMode(5)).toEqual([3, 4]);
    expect(settleMode(6)).toEqual([1, 2]);
  });

  it("is still on the plate's quiet lines", () => {
    // The diagonal u = w is a nodal line of every mode.
    expect(settleStillness([1, 2], { ...box, y1: box.x1 }, 40, 40)).toBeCloseTo(1);
    const values = [];
    for (let x = 0; x <= box.x1; x += 13) values.push(settleStillness([2, 3], box, x, 52));
    expect(Math.min(...values)).toBeLessThan(0.2);
  });

  it("brightens the lines to gold, holds, then fades out", () => {
    expect(settlePoint(1, 0, false).a).toBe(0);
    const formed = settlePoint(1, 2, false);
    expect(formed.gold).toBe(true);
    expect(formed.a).toBeCloseTo(0.85);
    expect(settlePoint(1, SETTLE_SECONDS, false).a).toBe(0);
    expect(settlePoint(0, 2, false).gold).toBe(false);
  });

  it("shows the sigil still under reduced motion, then fades", () => {
    const first = settlePoint(1, 0, true);
    expect(first.gold).toBe(true);
    expect(first.a).toBeCloseTo(0.85);
    expect(settlePoint(0, 1, true).a).toBe(0);
    expect(settlePoint(1, SETTLE_SECONDS, true).a).toBe(0);
  });
});
