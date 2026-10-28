import type { CobwebLevel } from "./cobwebs";

/**
 * Cobwebs as strands: points under gravity (verlet) joined by threads that
 * only pull. Corner webs hang off the panel's walls by pinned anchors; a
 * brush pushes threads aside, overstretched ones snap, a quick stroke cuts
 * every thread it crosses, and whatever is no longer tied to a wall falls
 * away and fades. Pure: no DOM, so it can be stepped in a test.
 */

export type WebPoint = {
  x: number;
  y: number;
  /** Where the point was a step ago; the difference is its velocity. */
  px: number;
  py: number;
  /** Held to a wall. A brush can knock it loose. */
  pinned: boolean;
  /** 1 while whole; counts down to 0 once the point has come loose. */
  life: number;
  falling: boolean;
};

export type Strand = {
  a: number;
  b: number;
  rest: number;
  /** How visible the thread is, 0 to 1, before its points start to fade. */
  alpha: number;
  broken: boolean;
};

export type CobwebSim = {
  width: number;
  height: number;
  points: WebPoint[];
  strands: Strand[];
  /** The point the spider sits on, if this web has one. */
  spider: number | null;
  steps: number;
  /** The step the brush last moved through the web; stretch only snaps soon after. */
  brushedAt: number;
};

/** The mouse this step, and where it was the step before. */
export type Brush = {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  radius: number;
};

export type StepOptions = {
  /** Wiped pieces fade where they are instead of falling. */
  reducedMotion?: boolean;
  random?: () => number;
};

const GRAVITY = 0.05;
const DAMPING = 0.97;
/** A thread pulled past this multiple of its rest length snaps. */
const SNAP_STRETCH = 1.7;
/** A brush moving faster than this many px a step cuts what it crosses. */
const CUT_SPEED = 2.5;
const RELAX_PASSES = 5;
/** Loose pieces are looked for every few steps, not every one. */
const LOOSE_CHECK_EVERY = 8;
/** How long after the brush leaves that stretched threads can still snap. */
const SNAP_WINDOW = 120;
/** No thread is shorter at rest than this, in px. */
const MIN_REST = 1;

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The webs a panel of this size grows at this level. */
export function buildCobwebs(
  level: Exclude<CobwebLevel, 0>,
  width: number,
  height: number,
  seed: number,
): CobwebSim {
  const r = seeded(seed);
  const points: WebPoint[] = [];
  const strands: Strand[] = [];

  const point = (x: number, y: number, pinned = false): number => {
    points.push({ x, y, px: x, py: y, pinned, life: 1, falling: false });
    return points.length - 1;
  };
  const strand = (a: number, b: number, alpha: number, slack = 1) => {
    const A = points[a]!;
    const B = points[b]!;
    strands.push({ a, b, rest: Math.hypot(A.x - B.x, A.y - B.y) * slack, alpha, broken: false });
  };
  const chain = (a: number, b: number, segments: number, alpha: number, slack: number) => {
    const A = points[a]!;
    const B = points[b]!;
    let prev = a;
    for (let i = 1; i < segments; i++) {
      const t = i / segments;
      const id = point(A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t);
      strand(prev, id, alpha, slack);
      prev = id;
    }
    strand(prev, b, alpha, slack);
  };
  const hang = (from: number, length: number, alpha: number) => {
    let prev = from;
    for (let j = 0; j < length; j++) {
      const id = point(points[prev]!.x + (r() - 0.5) * 3, points[prev]!.y + 6);
      strand(prev, id, alpha);
      prev = id;
    }
  };

  let spider: number | null = null;
  // A cobweb in the corner at (cx, cy), opening toward (dx, dy): uneven
  // spokes held to the walls by guy lines, sagging cross threads with gaps,
  // a dusty tangle near the corner and a few drooping strands.
  const corner = (cx: number, cy: number, dx: 1 | -1, dy: 1 | -1, size: number, withSpider = false) => {
    const hub = point(cx, cy, true);
    const count = 9 + Math.floor(r() * 4);
    const rings = 14;
    const spokes: number[][] = [];
    for (let s = 0; s < count; s++) {
      const angle = ((7 + (s + r() * 0.7) * (76 / count)) * Math.PI) / 180;
      const length = size * (0.65 + r() * 0.45);
      const ex = cx + dx * Math.cos(angle) * length;
      const ey = cy + dy * Math.sin(angle) * length;
      const ids = [hub];
      for (let k = 1; k <= rings; k++) {
        // Threads crowd toward the corner, the way silk and dust pile up there.
        const t = Math.pow(k / rings, 1.25);
        const id = point(cx + (ex - cx) * t + (r() - 0.5) * 3, cy + (ey - cy) * t + (r() - 0.5) * 3);
        strand(ids[ids.length - 1]!, id, 0.5);
        ids.push(id);
      }
      const tip = ids[rings]!;
      const anchor =
        angle < Math.PI / 4
          ? point(points[tip]!.x + dx * (8 + r() * 30), cy, true)
          : point(cx, points[tip]!.y + dy * (8 + r() * 30), true);
      chain(tip, anchor, 3, 0.4, 1.02);
      spokes.push(ids);
    }
    for (let s = 0; s < count - 1; s++) {
      for (let k = 1; k <= rings; k++) {
        if (r() < 0.3) continue;
        // Cross threads sometimes skip a ring, so the web reads as old and torn.
        const k2 = Math.min(rings, k + (r() < 0.15 ? 1 : 0));
        chain(spokes[s]![k]!, spokes[s + 1]![k2]!, 2 + Math.floor(k / 5), 0.32, 1.02 + r() * 0.1);
      }
    }
    for (let i = 0; i < 34; i++) {
      const a = spokes[Math.floor(r() * count)]![1 + Math.floor(r() * 4)]!;
      const b = spokes[Math.floor(r() * count)]![1 + Math.floor(r() * 4)]!;
      if (a !== b) chain(a, b, 2, 0.2, 1.05 + r() * 0.25);
    }
    // Droopers hang from the top webs only; from a bottom corner they would trail off the panel.
    for (let i = 0; i < (dy === 1 ? 3 : 0); i++) {
      hang(spokes[1 + Math.floor(r() * (count - 2))]![6 + Math.floor(r() * 7)]!, 3 + Math.floor(r() * 7), 0.28);
    }
    if (withSpider) spider = spokes[Math.floor(count / 2)]![5]!;
  };
  // A loose thread strung along the top edge, left to sag under its own weight.
  const sheet = (from: number, to: number) => {
    chain(point(from * width, 0, true), point(to * width, 0, true), 18, 0.24, 1.08 + r() * 0.12);
  };
  const dangle = (at: number, length: number) => hang(point(at * width, 0, true), length, 0.3);

  const base = Math.min(width, height);
  if (level === 1) {
    corner(width, 0, -1, 1, base * 0.28);
  } else if (level === 2) {
    corner(width, 0, -1, 1, base * 0.41);
    corner(0, 0, 1, 1, base * 0.26);
    sheet(0.13, 0.45);
    sheet(0.32, 0.69);
    dangle(0.54, 7);
  } else {
    corner(width, 0, -1, 1, base * 0.56, true);
    corner(0, 0, 1, 1, base * 0.43);
    corner(width, height, -1, -1, base * 0.31);
    corner(0, height, 1, -1, base * 0.2);
    sheet(0.12, 0.41);
    sheet(0.25, 0.62);
    sheet(0.48, 0.83);
    sheet(0.06, 0.29);
    sheet(0.62, 0.94);
    dangle(0.37, 10);
    dangle(0.67, 14);
    dangle(0.22, 6);
  }

  const sim: CobwebSim = { width, height, points, strands, spider, steps: 0, brushedAt: -Infinity };
  // Let it hang: sag and settle before anyone sees it. Then take the way it
  // hangs as its rest, so no thread starts out already near snapping (the
  // short ones crowded at a hub would otherwise go at the first touch).
  for (let i = 0; i < 160; i++) stepCobwebs(sim, null);
  for (const s of strands) {
    const A = points[s.a]!;
    const B = points[s.b]!;
    s.rest = Math.max(s.rest, Math.hypot(A.x - B.x, A.y - B.y), MIN_REST);
  }
  return sim;
}

function crosses(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (!den) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Anything no longer tied to a wall through unbroken threads comes loose. */
function dropLoose(sim: CobwebSim): void {
  const { points, strands } = sim;
  const neighbours: number[][] = points.map(() => []);
  for (const s of strands) {
    if (s.broken) continue;
    neighbours[s.a]!.push(s.b);
    neighbours[s.b]!.push(s.a);
  }
  const held = new Array<boolean>(points.length).fill(false);
  const queue: number[] = [];
  points.forEach((p, i) => {
    if (p.pinned && p.life > 0) {
      held[i] = true;
      queue.push(i);
    }
  });
  while (queue.length) {
    const i = queue.pop()!;
    for (const j of neighbours[i]!) {
      if (held[j]) continue;
      held[j] = true;
      queue.push(j);
    }
  }
  points.forEach((p, i) => {
    if (!held[i] && p.life > 0) p.falling = true;
    if (p.falling && p.y > sim.height + 40) p.life = 0;
  });
}

/** Advance the webs one frame, with the mouse where `brush` says, or away. */
export function stepCobwebs(sim: CobwebSim, brush: Brush | null, options: StepOptions = {}): void {
  const { reducedMotion = false, random = Math.random } = options;
  const { points, strands } = sim;

  for (const p of points) {
    if (p.pinned || p.life <= 0) continue;
    if (p.falling) p.life -= reducedMotion ? 0.04 : 0.018;
    if (p.falling && reducedMotion) {
      p.px = p.x;
      p.py = p.y;
      continue;
    }
    const vx = (p.x - p.px) * DAMPING;
    const vy = (p.y - p.py) * DAMPING;
    p.px = p.x;
    p.py = p.y;
    p.x += vx;
    p.y += vy + GRAVITY * (p.falling ? 4 : 1);
    // What's still attached rests on the panel's floor and walls; only loose
    // pieces drop out of it.
    if (!p.falling) {
      p.x = Math.min(sim.width, Math.max(0, p.x));
      p.y = Math.min(sim.height, Math.max(0, p.y));
    }
  }

  if (brush) {
    const R = brush.radius;
    for (const p of points) {
      if (p.life <= 0 || (reducedMotion && p.falling)) continue;
      const dx = p.x - brush.x;
      const dy = p.y - brush.y;
      const d = Math.hypot(dx, dy);
      if (d >= R) continue;
      // Only a brush that reaches the web lets its threads snap.
      sim.brushedAt = sim.steps;
      if (p.pinned) {
        if (random() < 0.3) p.pinned = false;
        continue;
      }
      if (d > 0) {
        p.x = brush.x + (dx / d) * R;
        p.y = brush.y + (dy / d) * R;
      }
    }
    // A quick stroke cuts every thread it crosses; a slow one only drags them.
    if (Math.hypot(brush.x - brush.prevX, brush.y - brush.prevY) > CUT_SPEED) {
      for (const s of strands) {
        if (s.broken) continue;
        const A = points[s.a]!;
        const B = points[s.b]!;
        if (crosses(brush.prevX, brush.prevY, brush.x, brush.y, A.x, A.y, B.x, B.y) && random() < 0.85) {
          s.broken = true;
          sim.brushedAt = sim.steps;
        }
      }
    }
  }

  // Left alone, a web only sags: the longest hanging chains would otherwise
  // creep past the snap length under their own weight.
  const canSnap = sim.steps - sim.brushedAt < SNAP_WINDOW;
  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    for (const s of strands) {
      if (s.broken) continue;
      const A = points[s.a]!;
      const B = points[s.b]!;
      if (A.life <= 0 || B.life <= 0) {
        s.broken = true;
        continue;
      }
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      if (canSnap && d > s.rest * SNAP_STRETCH) {
        s.broken = true;
        continue;
      }
      // Threads pull; they never push.
      if (d <= s.rest) continue;
      const f = (d - s.rest) / d;
      // Under reduced motion a loose piece stays exactly where it came loose.
      const heldA = A.pinned || (reducedMotion && A.falling);
      const heldB = B.pinned || (reducedMotion && B.falling);
      const wa = heldA ? 0 : heldB ? 1 : 0.5;
      const wb = heldB ? 0 : heldA ? 1 : 0.5;
      A.x += dx * f * wa;
      A.y += dy * f * wa;
      B.x -= dx * f * wb;
      B.y -= dy * f * wb;
    }
  }

  sim.steps++;
  if (sim.steps % LOOSE_CHECK_EVERY === 0) dropLoose(sim);
}

/** Nothing left to draw. */
export function cobwebsGone(sim: CobwebSim): boolean {
  return sim.strands.every(
    (s) => s.broken || sim.points[s.a]!.life <= 0 || sim.points[s.b]!.life <= 0,
  );
}
