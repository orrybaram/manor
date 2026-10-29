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

/** The box the web's points fill. */
function box(sim: CobwebSim) {
  const xs = sim.points.map((p) => p.x);
  const ys = sim.points.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Back and forth across the whole web, a row every 24px. */
function zigzag(sim: CobwebSim): Array<[number, number]> {
  const { x0, x1, y0, y1 } = box(sim);
  const path: Array<[number, number]> = [];
  for (let y = y0 + 2, i = 0; y <= y1 + 24; y += 24, i++) {
    path.push(i % 2 ? [x1 + 4, y] : [x0 - 4, y], i % 2 ? [x0 - 4, y + 12] : [x1 + 4, y + 12]);
  }
  return path;
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
    for (let seed = 1; seed <= 12; seed++) {
      const one = buildCobwebs(1, W, H, seed);
      const two = buildCobwebs(2, W, H, seed);
      const three = buildCobwebs(3, W, H, seed);
      expect(one.strands.length).toBeLessThan(two.strands.length);
      expect(two.strands.length).toBeLessThan(three.strands.length);
      expect(one.spider).toBeNull();
      expect(three.spider).not.toBeNull();
    }
  });

  it("hangs each visit's webs somewhere new", () => {
    const layouts = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const { x0, x1, y1 } = box(buildCobwebs(1, W, H, seed));
      layouts.add([x0, x1, y1].map((v) => Math.round(v / 40)).join());
    }
    expect(layouts.size).toBeGreaterThanOrEqual(6);
  });

  it.each([
    [120, 80],
    [200, 150],
    [1040, 540],
    [2500, 300],
    [300, 1400],
    [2500, 1400],
  ])("keeps every web inside a %ix%i panel", (w, h) => {
    for (const level of [1, 2, 3] as const) {
      const sim = buildCobwebs(level, w, h, 7);
      for (let i = 0; i < 200; i++) stepCobwebs(sim, null);
      for (const p of sim.points) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(w);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(h);
      }
    }
  });

  it.each([1, 2, 3])("is untouched by a brush that passes nowhere near it (seed %i)", (seed) => {
    for (const [w, h] of [[120, 80], [200, 150], [1040, 540]] as const) {
      const sim = buildCobwebs(3, w, h, seed);
      const before = liveStrands(sim);
      // Far outside the panel: the pointer is over it, but on nothing.
      for (let i = 0; i < 60; i++) {
        stepCobwebs(sim, { x: -1000 - i, y: -1000, prevX: -1000 - i + 1, prevY: -1000, radius: 36 });
      }
      for (let i = 0; i < 200; i++) stepCobwebs(sim, null);
      expect(liveStrands(sim)).toBe(before);
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
    const { x0, x1, y0, y1 } = box(sim);
    const y = (y0 + y1) / 2;
    sweep(sim, [[x0 - 10, y], [x1 + 10, y]], 8);
    expect(liveStrands(sim)).toBeLessThan(before);
  });

  it("only pushes threads aside when the brush rests", () => {
    const sim = buildCobwebs(1, W, H, 2);
    const { x0, x1, y0, y1 } = box(sim);
    const at = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    const brush: Brush = { ...at, prevX: at.x, prevY: at.y, radius: 36 };
    for (let i = 0; i < 20; i++) stepCobwebs(sim, brush, { random: () => 1 });
    for (const p of sim.points) {
      if (p.pinned || p.life <= 0) continue;
      expect(Math.hypot(p.x - at.x, p.y - at.y)).toBeGreaterThanOrEqual(35);
    }
  });

  it("lets a fully wiped web fall away until nothing is left", () => {
    const sim = buildCobwebs(1, W, H, 3);
    sweep(sim, zigzag(sim), 8);
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
