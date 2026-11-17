import { HOUSE_SETTLE_MS } from "../../../lib/house-floor";
import { P } from "./floor-layout";

/**
 * The awake floor's motion, ported from the design mock: the wake swell and
 * breath, the brush, the ring a fed dot leaves in the empty sockets, and
 * Settle, the Chladni sigil the house answers with. Pure, so it's testable.
 */

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const easeOut = (p: number): number => 1 - Math.pow(1 - p, 3);
export const easeIn = (p: number): number => p * p;
export const easeInOut = (p: number): number =>
  p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;

/** One slow swell of light across the whole floor as it wakes, seconds. */
export const WAKE_SECONDS = 1.6;
/** Then the floor breathes together on this cycle until it's fed. */
export const BREATH_SECONDS = 2.4;

/** The swell's level (0–1) `t` seconds after waking. */
export function wakeSwell(t: number): number {
  return t >= 0 && t < WAKE_SECONDS ? Math.sin((Math.PI * t) / WAKE_SECONDS) : 0;
}

/** The breath's level (0–1) `t` seconds after waking; 0 during the swell. */
export function breath(t: number): number {
  return t > WAKE_SECONDS ? 0.5 - 0.5 * Math.cos(((t - WAKE_SECONDS) / BREATH_SECONDS) * Math.PI * 2) : 0;
}

/** The Large brush's radius. */
export const BRUSH_RADIUS = P * 2.6;

/**
 * Indices of the `points` within the brush anywhere along the stroke from
 * (x0, y0) to (x1, y1), sampled every .3 pitch so a quick sweep skips none.
 */
export function brushHits(
  points: readonly { index: number; x: number; y: number }[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Set<number> {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (P * 0.3)));
  const hits = new Set<number>();
  for (let k = 0; k <= steps; k++) {
    const x = x0 + ((x1 - x0) * k) / steps;
    const y = y0 + ((y1 - y0) * k) / steps;
    for (const p of points) {
      if (!hits.has(p.index) && Math.hypot(p.x - x, p.y - y) < BRUSH_RADIUS) hits.add(p.index);
    }
  }
  return hits;
}

/** A fed dot pops: it swells and brightens for this long, seconds… */
export const POP_SWELL = 0.07;
/** …and is gone by this. */
export const POP_SECONDS = 0.3;

/**
 * The pop `u` seconds after feeding: radius and alpha multipliers on the
 * dot's own (alpha as a target: it brightens by .35 toward 1). `null` once
 * it's gone.
 */
export function pop(u: number, radius: number, alpha: number): { r: number; a: number } | null {
  if (u >= POP_SECONDS) return null;
  const top = Math.min(1, alpha + 0.35);
  if (u < POP_SWELL) {
    const g = easeOut(Math.max(0, u) / POP_SWELL);
    return { r: radius * (1 + 0.55 * g), a: alpha + (top - alpha) * g };
  }
  const g = 1 - easeIn(clamp((u - POP_SWELL) / (POP_SECONDS - POP_SWELL), 0, 1));
  return { r: radius * 1.55 * g, a: top * g };
}

/** The ring a fed dot leaves in the empty sockets. */
export const DROP_LIFE = 0.9;
const DROP_REACH = P * 2.6;

export interface Drop {
  x: number;
  y: number;
  /** Seconds since the dot was fed. */
  t: number;
}

/**
 * The wake at (x, y): brightness `b` (0–1) and a radial bend. Rings add up,
 * then saturate softly so a sweep reads as one wake.
 */
export function ringWake(x: number, y: number, drops: readonly Drop[]): [number, number, number] {
  let sum = 0;
  let px = 0;
  let py = 0;
  for (const f of drops) {
    const dx = x - f.x;
    const dy = y - f.y;
    const d = Math.hypot(dx, dy);
    if (d > DROP_REACH + P * 1.5 || d < 1) continue;
    const q = f.t / DROP_LIFE;
    const rr = P * 0.6 + DROP_REACH * easeOut(q);
    const w = P * (0.55 + q * 0.7);
    const off = d - rr;
    const g = Math.exp(-(off * off) / (w * w)) * Math.pow(1 - q, 1.6) * Math.min(1, f.t / 0.08);
    sum += g;
    const k = (g * Math.sin((off / w) * 2)) / d;
    px += dx * k;
    py += dy * k;
  }
  const b = 1 - Math.exp(-sum * 0.9); // soft cap
  const scale = sum > 0 ? b / sum : 0;
  return [b, px * scale, py * scale];
}

/** Settle's length, seconds. */
export const SETTLE_SECONDS = HOUSE_SETTLE_MS / 1000;

const SETTLE_MODES: readonly (readonly [number, number])[] = [
  [1, 2],
  [2, 3],
  [3, 5],
  [1, 4],
  [2, 5],
  [3, 4],
];

/** The plate mode Settle rings in: it cycles with the meal count. */
export function settleMode(meals: number): readonly [number, number] {
  return SETTLE_MODES[((meals % SETTLE_MODES.length) + SETTLE_MODES.length) % SETTLE_MODES.length];
}

/** The floor's grid box, for Settle's field. */
export interface GridBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * How close (x, y) lies to the plate's nearest quiet line: 1 on a line, 0 far
 * off. Measured in pixels, so every line is about one dot thick on this
 * coarse grid.
 */
export function settleStillness(mode: readonly [number, number], box: GridBox, x: number, y: number): number {
  const [n, m] = mode;
  const F = (px: number, py: number) => {
    const u = (px - box.x0) / (box.x1 - box.x0 || 1);
    const w = (py - box.y0) / (box.y1 - box.y0 || 1);
    return (
      Math.cos(n * Math.PI * u) * Math.cos(m * Math.PI * w) -
      Math.cos(m * Math.PI * u) * Math.cos(n * Math.PI * w)
    );
  };
  const f = F(x, y);
  const h = 0.5;
  const gx = (F(x + h, y) - F(x - h, y)) / (2 * h);
  const gy = (F(x, y + h) - F(x, y - h)) / (2 * h);
  const lineDist = Math.abs(f) / (Math.hypot(gx, gy) || 1e-6);
  return Math.exp(-((lineDist / (P * 0.62)) ** 2));
}

/**
 * One grid point of Settle `t` seconds in: nothing moves; points on the
 * quiet lines brighten to gold, hold, then everything fades. Reduced motion
 * shows the finished sigil still, and fades it the same way.
 */
export function settlePoint(
  still: number,
  t: number,
  reducedMotion: boolean,
): { a: number; r: number; gold: boolean } {
  const out = 1 - clamp((t - (SETTLE_SECONDS - 1.1)) / 1.1, 0, 1);
  const form = reducedMotion ? 1 : easeInOut(clamp((t - 0.2) / 1.5, 0, 1));
  const bg = reducedMotion ? 0 : 0.1 * Math.sin(Math.PI * clamp(t / 1.8, 0, 1));
  return {
    a: (bg * (1 - still) + still * form * 0.85) * out,
    r: 1 + still * form * 1.1,
    gold: still * form > 0.5,
  };
}
