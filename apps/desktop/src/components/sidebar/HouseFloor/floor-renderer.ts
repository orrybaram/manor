import {
  BRUSH_RADIUS,
  DROP_LIFE,
  POP_SECONDS,
  SETTLE_SECONDS,
  breath,
  brushHits,
  clamp,
  pop,
  ringWake,
  settleMode,
  settlePoint,
  settleStillness,
  wakeSwell,
} from "./floor-effects";
import {
  ARRIVE_SECONDS,
  dotAlpha,
  dotLooks,
  fillOrder,
  gridPoint,
  socketPosition,
  type DotLook,
  type FloorLayout,
  type FloorPhase,
} from "./floor-layout";

const TAU = Math.PI * 2;

export interface FloorColors {
  /** Dots and sockets: the theme's foreground. */
  dot: string;
  /** The house's reply: the theme's terminal yellow. */
  gold: string;
}

export interface FloorModel {
  dots: number;
  cols: number;
  rows: number;
  seed: number;
  /** Full: it wakes once every dot has faded in. */
  awake: boolean;
  /** Settle's mode cycles with it. */
  meals: number;
}

const FALLBACK_COLORS: FloorColors = { dot: "#e9e3d3", gold: "#ffe800" };

/**
 * The floor's colours from the app's CSS variables: dots in the theme's
 * foreground (`--fg`), the house's reply in its terminal yellow (`--yellow`).
 */
export function floorColors(style: Pick<CSSStyleDeclaration, "getPropertyValue">): FloorColors {
  return {
    dot: style.getPropertyValue("--fg").trim() || FALLBACK_COLORS.dot,
    gold: style.getPropertyValue("--yellow").trim() || FALLBACK_COLORS.gold,
  };
}


export interface FloorRendererOptions {
  /** The phase changed (for the canvas's label and test hooks). */
  onPhase?: (phase: FloorPhase) => void;
  /**
   * The floor is cleared: the house eats it now, as Settle starts (so a
   * fold or quit mid-Settle keeps the meal). Settle is only a picture.
   */
  onFed?: () => void;
}

/**
 * Draws the house floor on its canvas and runs its game: a full floor wakes
 * (once every dot has faded in), the brush feeds it, and a cleared floor
 * plays Settle. Imperative and React-free: the component feeds it the model,
 * size, colours and pointer, and calls `draw` from a frame only while `draw`
 * says something is still moving. A locked floor that isn't gaining dots
 * draws once and stops.
 *
 * Pretend only: feeding changes nothing here but what's drawn; the component
 * moves the floor's own progress through `onFed`.
 */
export class FloorRenderer {
  private readonly ctx: CanvasRenderingContext2D | null;
  private layout: FloorLayout = { cols: 1, rows: 1, width: 0, height: 0 };
  private dpr = 1;
  private colors: FloorColors = FALLBACK_COLORS;
  private reducedMotion = false;
  private model: FloorModel | null = null;
  private order: number[] = [];
  private looks: DotLook[] = [];
  /** When each dot (by fill index) arrived, for its fade-in; seconds. */
  private arrivals = new Map<number, number>();

  private phase: FloorPhase = "filling";
  /** The meal count Settle's mode was picked from (the model moves on under it). */
  private settleMeals = 0;
  /** Seconds: last frame, the wake, Settle's start, sockets fading back. */
  private lastT = 0;
  private wakeAt = 0;
  private settleAt = 0;
  private socketsFrom = -Infinity;
  /** Per dot while awake: passes left, under the brush, pulse, when fed (NaN: still here). */
  private passesLeft: number[] = [];
  private hit: boolean[] = [];
  private pulse: number[] = [];
  private goneAt: number[] = [];
  private fed = 0;
  /** Where dots were fed, for the ring wake; `t0` in seconds. */
  private drops: { x: number; y: number; t0: number }[] = [];
  private pointer = { x: 0, y: 0, in: false };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: FloorRendererOptions = {},
  ) {
    this.ctx = canvas.getContext("2d");
  }

  setColors(colors: FloorColors): void {
    this.colors = colors;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  /** The canvas's CSS size; resizing the backing store clears it, so draw after. */
  setSize(width: number, height: number, dpr: number): void {
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    this.dpr = dpr;
    this.layout = { ...this.layout, width, height };
  }

  /**
   * The latest model. New dots on the same floor fade in from `now`; a new
   * floor (seed or grid changed), or the first model, shows its dots as they
   * are, with no fade. The floor after a meal starts empty, its sockets
   * fading back in.
   */
  setModel(model: FloorModel, nowMs: number): void {
    const now = nowMs / 1000;
    const prev = this.model;
    const size = model.cols * model.rows;
    const sameFloor =
      prev !== null &&
      prev.seed === model.seed &&
      prev.cols === model.cols &&
      prev.rows === model.rows;
    if (!sameFloor) {
      this.order = fillOrder(model.seed, size);
      this.looks = dotLooks(model.seed, size);
      this.arrivals.clear();
      // Mid-Settle, the next floor waits hidden under it.
      if (this.phase === "awake") {
        // The grid changed under an awake floor: it wakes again, unfed.
        this.setPhase("filling");
      }
    } else {
      for (let i = prev.dots; i < model.dots; i++) this.arrivals.set(i, now);
      for (const i of this.arrivals.keys()) if (i >= model.dots) this.arrivals.delete(i);
    }
    this.model = model;
    this.layout = { ...this.layout, cols: model.cols, rows: model.rows };
  }

  /**
   * The pointer moved to (x, y) on the canvas. `active` sweeps the brush
   * along the move (a mouse hovering, or touch and pen while down). Returns
   * whether to draw.
   */
  pointerMove(x: number, y: number, active: boolean): boolean {
    const { pointer } = this;
    const was = pointer.in;
    const px = pointer.x;
    const py = pointer.y;
    pointer.x = x;
    pointer.y = y;
    pointer.in = true;
    if (this.phase !== "awake") return false;
    if (was && active) this.sweep(px, py, x, y);
    else this.hit.fill(false);
    return true;
  }

  /** Touch and pen feed where they land. */
  pointerDown(x: number, y: number): boolean {
    this.pointer = { x, y, in: true };
    if (this.phase !== "awake") return false;
    this.sweep(x, y, x, y);
    return true;
  }

  /** A lifted pointer: the next stroke takes a fresh pass. */
  pointerUp(): void {
    this.hit.fill(false);
  }

  pointerLeave(): boolean {
    this.pointer.in = false;
    this.hit.fill(false);
    return this.phase === "awake";
  }

  private sweep(x0: number, y0: number, x1: number, y1: number): void {
    const here: { index: number; x: number; y: number }[] = [];
    const count = this.dotCount();
    for (let i = 0; i < count; i++) {
      if (!Number.isNaN(this.goneAt[i])) continue;
      const [x, y] = socketPosition(this.layout, this.order[i]);
      here.push({ index: i, x, y });
    }
    const touched = brushHits(here, x0, y0, x1, y1);
    const now = performance.now() / 1000;
    for (const { index: i, x, y } of here) {
      const under = touched.has(i);
      // A pass counts on first touch; staying under the brush is one pass.
      if (under && !this.hit[i]) {
        this.passesLeft[i]--;
        this.pulse[i] = 1;
        if (this.passesLeft[i] <= 0) {
          // It fades where it lies; its place stays empty.
          this.goneAt[i] = now;
          this.fed++;
          this.canvas.dataset.left = String(count - this.fed);
          if (!this.reducedMotion) this.drops.push({ x, y, t0: now });
        }
      }
      this.hit[i] = under;
    }
  }

  private dotCount(): number {
    const size = this.layout.cols * this.layout.rows;
    return Math.min(this.model?.dots ?? 0, size);
  }

  private setPhase(phase: FloorPhase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    if (phase !== "awake") delete this.canvas.dataset.left;
    this.options.onPhase?.(phase);
  }

  private wake(now: number): void {
    const count = this.dotCount();
    this.passesLeft = this.looks.slice(0, count).map((l) => l.passes);
    this.hit = new Array<boolean>(count).fill(false);
    this.pulse = new Array<number>(count).fill(0);
    this.goneAt = new Array<number>(count).fill(Number.NaN);
    this.fed = 0;
    this.drops = [];
    this.wakeAt = now;
    // Dots still on the awake floor, for tests (React doesn't own it).
    this.canvas.dataset.left = String(count);
    this.setPhase("awake");
  }

  /** Paint one frame. Returns whether anything is still moving. */
  draw(nowMs: number): boolean {
    const now = nowMs / 1000;
    const dt = clamp(now - this.lastT, 0, 0.05);
    this.lastT = now;
    const { ctx, model, layout } = this;
    if (!ctx || !model || layout.width <= 0 || layout.height <= 0) return false;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, layout.width, layout.height);

    const size = layout.cols * layout.rows;
    let count = this.dotCount();
    const reduced = this.reducedMotion;

    // Full, and every dot has faded in: the floor wakes.
    if (this.phase === "filling" && model.awake && count >= size && this.arrivals.size === 0) {
      this.wake(now);
    }
    // Every dot fed, and the last pop over: the house answers.
    if (this.phase === "awake" && this.fed > 0 && this.fed >= count) {
      const popping = !reduced && this.goneAt.some((g) => now - g < POP_SECONDS);
      if (!popping) {
        this.settleAt = now;
        this.settleMeals = model.meals;
        this.drops = [];
        this.setPhase("settle");
        this.options.onFed?.();
      }
    }
    if (this.phase === "settle") {
      if (now - this.settleAt < SETTLE_SECONDS) {
        this.drawSettle(now - this.settleAt);
        ctx.globalAlpha = 1;
        return true;
      }
      // Settle is over: the next floor shows, its sockets and any carried
      // dots fading in.
      this.setPhase("filling");
      this.socketsFrom = now;
      this.arrivals.clear();
      count = this.dotCount();
      for (let i = 0; i < count; i++) this.arrivals.set(i, now);
    }

    const awake = this.phase === "awake";
    let moving = false;

    // The ring a fed dot leaves, through the empty sockets.
    this.drops = reduced ? [] : this.drops.filter((d) => now - d.t0 < DROP_LIFE);
    if (awake && this.drops.length > 0) {
      moving = true;
      const drops = this.drops.map((d) => ({ x: d.x, y: d.y, t: now - d.t0 }));
      const taken = new Set<number>();
      for (let i = 0; i < count; i++) if (Number.isNaN(this.goneAt[i])) taken.add(this.order[i]);
      for (let k = 0; k < size; k++) {
        if (taken.has(k)) continue;
        const [x, y] = socketPosition(layout, k);
        const [b, px, py] = ringWake(x, y, drops);
        if (b < 0.03) continue;
        this.dot(x + px * 1.8, y + py * 1.8, 0.8 + b * 0.35, this.colors.dot, b * 0.2);
      }
    }

    if (!awake) {
      // Empty sockets, so the floor always reads as a whole rectangle; after
      // a meal they fade back in.
      const back = clamp((now - this.socketsFrom) / ARRIVE_SECONDS, 0, 1);
      if (back < 1) moving = true;
      const filled = new Set<number>();
      for (let i = 0; i < count; i++) filled.add(this.order[i]);
      for (let k = 0; k < size; k++) {
        if (filled.has(k)) continue;
        const [x, y] = socketPosition(layout, k);
        this.dot(x, y, 0.7, this.colors.dot, 0.04 * back);
      }
    }

    const sinceWake = now - this.wakeAt;
    const swell = awake && !reduced ? wakeSwell(sinceWake) : 0;
    const breathe = awake && !reduced ? breath(sinceWake) : 0;
    // A locked floor holds still: flickering dots keep the phase they have
    // at time 0. Awake, the frame loop gives them time.
    const time = awake && !reduced ? now : 0;
    let anyHere = false;
    for (let i = 0; i < count; i++) {
      const look = this.looks[i];
      const [x, y] = socketPosition(layout, this.order[i]);
      if (!awake) {
        // Locked: small and faint, a texture more than dots.
        const r = 0.9 + look.weight * 0.45;
        const alpha = Math.min(1, dotAlpha(look, time) * 0.26);
        const arrived = this.arrivals.get(i);
        if (arrived !== undefined) {
          const age = now - arrived;
          if (age < ARRIVE_SECONDS) {
            this.dot(x, y, r, this.colors.dot, (alpha * Math.max(0, age)) / ARRIVE_SECONDS);
            moving = true;
            continue;
          }
          this.arrivals.delete(i);
        }
        this.dot(x, y, r, this.colors.dot, alpha);
        continue;
      }
      const r = 1.25 + look.weight * 0.9 + swell * 0.5 + breathe * 0.35;
      const alpha = Math.min(
        1,
        dotAlpha(look, time, Math.max(0, this.passesLeft[i])) * (0.8 + breathe * 0.3) + swell * 0.35,
      );
      const gone = this.goneAt[i];
      if (!Number.isNaN(gone)) {
        // Pop: a quick swell and brighten, then it pinches out to nothing.
        if (reduced) continue;
        const p = pop(now - gone, r, alpha);
        if (p) {
          this.dot(x, y, p.r, this.colors.dot, p.a);
          moving = true;
        }
        continue;
      }
      anyHere = true;
      const pulse = (this.pulse[i] = Math.max(0, this.pulse[i] - dt * 4));
      if (pulse > 0 && !reduced) moving = true;
      const grow = reduced ? 0 : pulse * 0.8;
      this.dot(x, y, r + grow, this.colors.dot, Math.min(1, alpha + (reduced ? 0 : pulse * 0.3)));
    }

    // The brush: a faint circle while over a floor that has something on it.
    if (awake && anyHere && this.pointer.in) {
      ctx.globalAlpha = 0.1;
      ctx.strokeStyle = this.colors.dot;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(this.pointer.x, this.pointer.y, BRUSH_RADIUS, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Awake, the floor breathes (and flickers) until it's fed.
    if (awake && !reduced) moving = true;
    return moving;
  }

  /** Settle over the full grid: nothing moves; the quiet lines go gold, hold, fade. */
  private drawSettle(t: number): void {
    const { layout } = this;
    const mode = settleMode(this.settleMeals);
    const [x0, y0] = gridPoint(layout, 0, 0);
    const [x1, y1] = gridPoint(layout, layout.cols - 1, layout.rows - 1);
    const box = { x0, x1, y0, y1 };
    for (let j = 0; j < layout.rows; j++) {
      for (let i = 0; i < layout.cols; i++) {
        const [x, y] = gridPoint(layout, i, j);
        const p = settlePoint(settleStillness(mode, box, x, y), t, this.reducedMotion);
        if (p.a < 0.03) continue;
        this.dot(x, y, p.r, p.gold ? this.colors.gold : this.colors.dot, p.a);
      }
    }
  }

  private dot(x: number, y: number, r: number, color: string, alpha: number): void {
    const ctx = this.ctx;
    if (!ctx || alpha <= 0.01 || r <= 0.05) return;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
}

export interface FrameLoop {
  /** Paint on the next frame; frames keep coming while the floor moves. */
  request: () => void;
  stop: () => void;
}

/**
 * Frames for `renderer`, only while `draw` says something moves and
 * `onScreen()` holds. Idle, it schedules nothing.
 */
export function frameLoop(renderer: FloorRenderer, onScreen: () => boolean): FrameLoop {
  let frame: number | null = null;
  const tick = () => {
    frame = null;
    if (renderer.draw(performance.now()) && onScreen()) frame = requestAnimationFrame(tick);
  };
  return {
    request: () => {
      if (frame === null) frame = requestAnimationFrame(tick);
    },
    stop: () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
