import { describe, expect, it } from "vitest";
import {
  buildCobwebs,
  cobwebsGone,
  stepCobwebs,
  type Brush,
  type CobwebSim,
} from "../cobweb-sim";

const W = 1040;
const H = 540;

function liveStrands(sim: CobwebSim): number {
  return sim.strands.filter((s) => !s.broken).length;
}

/** Drag a brush along a path, `px` per step, as a mouse would. */
function sweep(
  sim: CobwebSim,
  path: Array<[number, number]>,
  px: number,
  radius = 36,
  options = {},
): void {
  for (let i = 1; i < path.length; i++) {
    const [x1, y1] = path[i - 1]!;
    const [x2, y2] = path[i]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / px));
    let prev: [number, number] = [x1, y1];
    for (let k = 1; k <= steps; k++) {
      const at: [number, number] = [x1 + ((x2 - x1) * k) / steps, y1 + ((y2 - y1) * k) / steps];
      const brush: Brush = { x: at[0], y: at[1], prevX: prev[0], prevY: prev[1], radius };
      stepCobwebs(sim, brush, { random: () => 0, ...options });
      prev = at;
    }
  }
}

describe("buildCobwebs", () => {
  it("grows more web at each level, and a spider at the top", () => {
    const one = buildCobwebs(1, W, H, 1);
    const two = buildCobwebs(2, W, H, 1);
    const three = buildCobwebs(3, W, H, 1);
    expect(one.strands.length).toBeLessThan(two.strands.length);
    expect(two.strands.length).toBeLessThan(three.strands.length);
    expect(one.spider).toBeNull();
    expect(three.spider).not.toBeNull();
  });

  it("puts a level-1 web in the top-right corner", () => {
    const sim = buildCobwebs(1, W, H, 1);
    for (const p of sim.points) {
      expect(p.x).toBeGreaterThan(W / 2);
      expect(p.y).toBeLessThan(H / 2);
    }
  });

  it("hangs still when nobody touches it", () => {
    const sim = buildCobwebs(3, W, H, 5);
    const before = liveStrands(sim);
    for (let i = 0; i < 400; i++) stepCobwebs(sim, null);
    expect(liveStrands(sim)).toBe(before);
    expect(sim.points.some((p) => p.falling)).toBe(false);
  });
});

describe("stepCobwebs", () => {
  it("cuts the threads a quick stroke crosses", () => {
    const sim = buildCobwebs(1, W, H, 2);
    const before = liveStrands(sim);
    sweep(sim, [[W - 200, 30], [W - 20, 30]], 8);
    expect(liveStrands(sim)).toBeLessThan(before);
  });

  it("only pushes threads aside when the brush rests", () => {
    const sim = buildCobwebs(1, W, H, 2);
    const at = { x: W - 60, y: 40 };
    const brush: Brush = { ...at, prevX: at.x, prevY: at.y, radius: 36 };
    for (let i = 0; i < 20; i++) stepCobwebs(sim, brush, { random: () => 1 });
    for (const p of sim.points) {
      if (p.pinned || p.life <= 0) continue;
      expect(Math.hypot(p.x - at.x, p.y - at.y)).toBeGreaterThanOrEqual(35.9);
    }
  });

  it("lets a fully wiped web fall away until nothing is left", () => {
    const sim = buildCobwebs(1, W, H, 3);
    const path: Array<[number, number]> = [];
    for (let y = 4; y < 220; y += 30) path.push([W - 4, y], [W - 280, y + 15]);
    sweep(sim, path, 8);
    expect(sim.points.some((p) => p.falling)).toBe(true);
    for (let i = 0; i < 600; i++) stepCobwebs(sim, null);
    expect(cobwebsGone(sim)).toBe(true);
  });

  it("fades loose pieces in place under reduced motion", () => {
    const sim = buildCobwebs(1, W, H, 3);
    for (const p of sim.points) p.pinned = false;
    for (let i = 0; i < 8; i++) stepCobwebs(sim, null, { reducedMotion: true });
    const loose = sim.points.filter((p) => p.falling && p.life > 0);
    expect(loose.length).toBe(sim.points.length);
    const ys = loose.map((p) => p.y);
    const lives = loose.map((p) => p.life);
    for (let i = 0; i < 5; i++) stepCobwebs(sim, null, { reducedMotion: true });
    loose.forEach((p, i) => {
      expect(p.y).toBe(ys[i]);
      expect(p.life).toBeLessThan(lives[i]!);
    });
  });

  it("steps a level-3 panel well inside a frame", () => {
    const sim = buildCobwebs(3, W, H, 4);
    for (let i = 0; i < 20; i++) stepCobwebs(sim, null);
    const start = performance.now();
    for (let i = 0; i < 100; i++) stepCobwebs(sim, null);
    // Measured near 1ms; the bound only guards against an order-of-magnitude slip.
    expect((performance.now() - start) / 100).toBeLessThan(8);
  });
});
