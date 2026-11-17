import {
  ARRIVE_SECONDS,
  dotAlpha,
  dotLooks,
  fillOrder,
  socketPosition,
  type DotLook,
  type FloorLayout,
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
  awake: boolean;
}

/**
 * Draws the house floor on its canvas. Imperative and React-free: the
 * component feeds it the model, size and colours, and calls `draw` from a
 * frame only while `draw` says something is still moving. A locked floor
 * that isn't gaining dots draws once and stops.
 */
export class FloorRenderer {
  private readonly ctx: CanvasRenderingContext2D | null;
  private layout: FloorLayout = { cols: 1, rows: 1, width: 0, height: 0 };
  private dpr = 1;
  private colors: FloorColors = { dot: "#e9e3d3", gold: "#ffe800" };
  private model: FloorModel | null = null;
  private order: number[] = [];
  private looks: DotLook[] = [];
  /** When each dot (by fill index) arrived, for its fade-in; ms. */
  private arrivals = new Map<number, number>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d");
  }

  setColors(colors: FloorColors): void {
    this.colors = colors;
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
   * are, with no fade.
   */
  setModel(model: FloorModel, now: number): void {
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
    } else {
      for (let i = prev.dots; i < model.dots; i++) this.arrivals.set(i, now);
      for (const i of this.arrivals.keys()) if (i >= model.dots) this.arrivals.delete(i);
    }
    this.model = model;
    this.layout = { ...this.layout, cols: model.cols, rows: model.rows };
  }

  /** Paint one frame. Returns whether anything is still moving. */
  draw(now: number): boolean {
    const { ctx, model, layout } = this;
    if (!ctx || !model || layout.width <= 0 || layout.height <= 0) return false;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, layout.width, layout.height);

    const size = layout.cols * layout.rows;
    const count = Math.min(model.dots, size);
    let animating = false;

    if (!model.awake) {
      // Empty sockets, so the floor always reads as a whole rectangle.
      const filled = new Set<number>();
      for (let i = 0; i < count; i++) filled.add(this.order[i]);
      for (let k = 0; k < size; k++) {
        if (filled.has(k)) continue;
        const [x, y] = socketPosition(layout, k);
        this.dot(x, y, 0.7, this.colors.dot, 0.04);
      }
    }

    // A locked floor holds still: flickering dots keep the phase they have
    // at time 0. The awake floor's frame loop gives them time.
    const time = model.awake ? now / 1000 : 0;
    for (let i = 0; i < count; i++) {
      const look = this.looks[i];
      const [x, y] = socketPosition(layout, this.order[i]);
      // Locked: small and faint, a texture more than dots.
      const r = model.awake ? 1.25 + look.weight * 0.9 : 0.9 + look.weight * 0.45;
      const alpha = Math.min(1, dotAlpha(look, time) * (model.awake ? 0.8 : 0.26));
      const arrived = this.arrivals.get(i);
      if (arrived !== undefined) {
        const age = (now - arrived) / 1000;
        if (age < ARRIVE_SECONDS) {
          this.dot(x, y, r, this.colors.dot, (alpha * Math.max(0, age)) / ARRIVE_SECONDS);
          animating = true;
          continue;
        }
        this.arrivals.delete(i);
      }
      this.dot(x, y, r, this.colors.dot, alpha);
    }
    ctx.globalAlpha = 1;
    return animating;
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
