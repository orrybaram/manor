import type { CobwebLevel } from "./cobwebs";

/**
 * Cobwebs as strands: points under gravity (verlet) joined by threads that
 * only pull. Corner webs hang off the panel's walls by pinned anchors; a
 * brush pushes threads aside, overstretched ones snap, a quick stroke cuts
 * every thread it crosses, and whatever is no longer tied to a wall falls
 * away and fades. Pure: no DOM, so it can be stepped in a test.
 */

type WebPoint = {
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

type Strand = {
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
    // How far round the corner the web reaches, and how far it leans off the diagonal.
    const sweep = 62 + r() * 22;
    const start = 4 + r() * (86 - sweep);
    const spokes: number[][] = [];
    for (let s = 0; s < count; s++) {
      const angle = ((start + (s + r() * 0.7) * (sweep / count)) * Math.PI) / 180;
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
    for (let i = 0, n = dy === 1 ? 2 + Math.floor(r() * 4) : 0; i < n; i++) {
      hang(spokes[1 + Math.floor(r() * (count - 2))]![6 + Math.floor(r() * 7)]!, 4 + Math.floor(r() * 14), 0.28);
    }
    if (withSpider) spider = spokes[Math.floor(count / 2)]![5]!;
  };
  // A round orb web strung out in the open below the top edge: spokes all
  // the way round, rings with gaps, held up by guy lines to the top edge and
  // to a side wall when one is near. Its lower half hangs off the rest.
  const orb = (ox: number, radius: number, withSpider = false) => {
    const oy = radius + 12 + r() * 30;
    const count = 12 + Math.floor(r() * 5);
    const rings = 11;
    const hub = point(ox, oy);
    const spokes: number[][] = [];
    const tilt = r() * Math.PI * 2;
    for (let s = 0; s < count; s++) {
      const angle = tilt + ((s + (r() - 0.5) * 0.4) / count) * Math.PI * 2;
      const length = radius * (0.8 + r() * 0.3);
      const ids = [hub];
      for (let k = 1; k <= rings; k++) {
        const t = k / rings;
        const id = point(ox + Math.cos(angle) * length * t, oy + Math.sin(angle) * length * t);
        strand(ids[ids.length - 1]!, id, 0.45);
        ids.push(id);
      }
      const tip = points[ids[rings]!]!;
      const up = Math.sin(angle) < -0.25;
      const toWall = Math.cos(angle) < 0 ? tip.x : width - tip.x;
      if (up) {
        // Out along the spoke until it meets the top edge.
        const x = tip.x + (Math.cos(angle) / -Math.sin(angle)) * tip.y;
        chain(ids[rings]!, point(Math.min(width, Math.max(0, x)), 0, true), 3, 0.38, 1.02);
      } else if (Math.abs(Math.cos(angle)) > 0.6 && toWall < radius * 1.2) {
        chain(ids[rings]!, point(Math.cos(angle) < 0 ? 0 : width, tip.y, true), 3, 0.38, 1.02);
      }
      spokes.push(ids);
    }
    // Rings start clear of the hub, the way an orb weaver leaves a free zone.
    for (let s = 0; s < count; s++) {
      const next = spokes[(s + 1) % count]!;
      for (let k = 3; k <= rings; k++) {
        if (r() < 0.18) continue;
        chain(spokes[s]![k]!, next[k]!, 1 + Math.floor(k / 4), 0.34, 1.01 + r() * 0.06);
      }
    }
    for (let i = 0; i < 2 + Math.floor(r() * 3); i++) {
      hang(spokes[Math.floor(r() * count)]![rings - Math.floor(r() * 3)]!, 3 + Math.floor(r() * 10), 0.26);
    }
    if (withSpider) spider = spokes[Math.floor(r() * count)]![2]!;
  };
  // An old, shapeless tangle wedged into a top corner: loose threads strung
  // every which way between the two walls, sagging into a dusty hammock.
  const tangle = (cx: number, dx: 1 | -1, size: number) => {
    const held: number[] = [];
    for (let i = 0; i < 7; i++) held.push(point(cx + dx * r() * size, 0, true));
    for (let i = 0; i < 6; i++) held.push(point(cx, r() * size * 0.8, true));
    for (let i = 0; i < 46; i++) {
      // Thickest in the corner, thinning out toward the room.
      const d = size * Math.pow(r(), 0.7) * 0.9;
      const a = (r() * Math.PI) / 2;
      const id = point(cx + dx * Math.cos(a) * d, Math.sin(a) * d);
      const P = points[id]!;
      const near = held
        .map((j) => ({ j, d: Math.hypot(points[j]!.x - P.x, points[j]!.y - P.y) }))
        .sort((p, q) => p.d - q.d);
      // Tied to whatever is already up, so nothing starts out loose.
      for (const { j } of near.slice(0, 2 + Math.floor(r() * 2))) {
        chain(j, id, 2 + Math.floor(r() * 2), 0.22 + r() * 0.12, 1.05 + r() * 0.3);
      }
      held.push(id);
    }
    for (let i = 0; i < 3 + Math.floor(r() * 4); i++) {
      hang(held[13 + Math.floor(r() * 46)]!, 3 + Math.floor(r() * 12), 0.24);
    }
  };
  // A loose thread strung along the top edge, left to sag under its own weight.
  const sheet = (from: number, to: number) => {
    chain(point(from * width, 0, true), point(to * width, 0, true), 18, 0.24, 1.08 + r() * 0.12);
  };
  // A long thread across a top corner, from the side wall to the top edge,
  // with strands drooping off it.
  const bridge = (dx: 1 | -1) => {
    const wall = dx === 1 ? 0 : width;
    const a = point(wall, height * (0.12 + r() * 0.3), true);
    const b = point(wall + dx * width * (0.12 + r() * 0.3), 0, true);
    const first = points.length;
    chain(a, b, 16, 0.26, 1.04 + r() * 0.08);
    const mids = points.length - first;
    for (let i = 0; i < 2 + Math.floor(r() * 3); i++) {
      hang(first + Math.floor(r() * mids), 3 + Math.floor(r() * 12), 0.24);
    }
  };
  // A single strand from the top edge; with a spider, it's the line she came down on.
  const dangle = (at: number, length: number, withSpider = false) => {
    const top = point(at * width, 0, true);
    hang(top, length, 0.3);
    if (withSpider) spider = points.length - 1;
  };
  /** A dangle's length in links: some way down the panel, never to the floor. */
  const drop = (reach: number) => Math.max(3, Math.min(70, Math.floor((height * reach) / 6)));

  // Each visit gets its own arrangement: which corners, which kinds of web,
  // how big, and where the loose threads fall.
  const base = Math.min(width, height);
  const big = ({ 1: 1, 2: 2, 3: 3 + Math.floor(r() * 2) } as const)[level];
  const small = ({ 1: Math.floor(r() * 2), 2: 2 + Math.floor(r() * 3), 3: 5 + Math.floor(r() * 4) } as const)[level];
  const grow = ({ 1: 0.38, 2: 0.5, 3: 0.64 } as const)[level];
  const slots = ["tl", "tr", "top", "bl", "br"] as const;
  type Slot = (typeof slots)[number];
  const free = new Set<Slot>(["tl", "tr", "top"]);
  // Bottom corners only gather web on a panel left a good while.
  if (level >= 2) free.add("br");
  if (level >= 3) free.add("bl");
  // The top-right corner is the favourite: it draws three tickets to every other spot's one.
  const pick = (items: readonly Slot[]): Slot => {
    const tickets = items.flatMap((s) => (s === "tr" ? [s, s, s] : [s]));
    return tickets[Math.floor(r() * tickets.length)]!;
  };
  // The biggest web, and the spider, go in the first slot filled.
  const wantSpider = level === 3 || (level === 2 && r() < 0.5);
  for (let i = 0; i < big && free.size; i++) {
    // The first web always takes a top spot, where the eye looks first.
    const open = slots.filter((s) => free.has(s) && (i > 0 || !s.startsWith("b")));
    const slot = pick(open);
    free.delete(slot);
    const size = base * grow * (i === 0 ? 1 : 0.5 + r() * 0.4);
    const withSpider = wantSpider && i === 0;
    if (slot === "top") {
      const radius = Math.min(size * 0.55, (width - 24) / 2, (height - 60) / 2.4);
      if (radius >= 24) orb(width * (0.3 + r() * 0.4), radius, withSpider);
      else dangle(0.3 + r() * 0.4, drop(0.3), withSpider);
      continue;
    }
    const dx = slot.endsWith("l") ? 1 : -1;
    const atTop = slot.startsWith("t");
    if (atTop && r() < 0.3) {
      tangle(dx === 1 ? 0 : width, dx, size * 0.8);
      if (withSpider) dangle(dx === 1 ? 0.04 + r() * 0.1 : 0.86 + r() * 0.1, drop(0.2 + r() * 0.2), true);
    } else {
      corner(dx === 1 ? 0 : width, atTop ? 0 : height, dx, atTop ? 1 : -1, atTop ? size : size * 0.55, withSpider);
    }
  }
  for (let i = 0; i < small; i++) {
    const kind = r();
    if (kind < 0.35) {
      const from = r() * 0.8;
      sheet(from, Math.min(1, from + 0.15 + r() * 0.3));
    } else if (kind < 0.55) {
      bridge(r() < 0.5 ? 1 : -1);
    } else {
      // Long strands: some just a wisp, some most of the way down.
      dangle(0.05 + r() * 0.9, drop(0.08 + Math.pow(r(), 1.5) * 0.55));
    }
  }
  if (wantSpider && spider === null) dangle(0.2 + r() * 0.6, drop(0.25 + r() * 0.3), true);

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
