/**
 * The footer's cobwebs: the desktop app's Halloween sim (@manor/cobwebs) and a
 * port of its PanelCobwebs renderer. The pointer sweeps the webs away; the dust
 * film under them stays put.
 */
import "./footer.css";
import { buildCobwebs, cobwebsGone, stepCobwebs, type CobwebSim } from "@manor/cobwebs";

/** The brush's reach around the pointer, in CSS px. */
const BRUSH_RADIUS = 36;
/** Threads are drawn a little see-through, so the ground shows through the silk. */
const STRAND_OPACITY = 0.7;
/** Frames with nothing moving before the loop sleeps until the pointer returns. */
const SLEEP_AFTER_FRAMES = 90;
/** Heavy webs: the footer is the house's oldest room. */
const LEVEL = 3;
const SEED = 31;
/** A width change bigger than this grows fresh webs at the new size. */
const REBUILD_AFTER_PX = 40;

type Point = { x: number; y: number };

/** The dust film as an alpha mask; it takes the ink when drawn. */
function buildDust(level: number, width: number, height: number): HTMLCanvasElement {
  const dust = document.createElement("canvas");
  dust.width = Math.ceil(width);
  dust.height = Math.ceil(height);
  const ctx = dust.getContext("2d");
  if (!ctx) return dust;
  ctx.fillStyle = "#fff";
  ctx.globalAlpha = 0.018 * level;
  ctx.fillRect(0, 0, width, height);
  // Specks settle thicker toward the top.
  const specks = Math.round((width * height * level) / 800);
  for (let i = 0; i < specks; i++) {
    ctx.globalAlpha = 0.04 + Math.random() * 0.16;
    ctx.beginPath();
    ctx.arc(Math.random() * width, Math.pow(Math.random(), 1.6) * height, 0.3 + Math.random() * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
  return dust;
}

function drawSpider(ctx: CanvasRenderingContext2D, at: Point, life: number, px: number, ink: string): void {
  ctx.save();
  ctx.translate(at.x, at.y + 3 * px);
  ctx.scale(px, px);
  ctx.globalAlpha = 0.85 * life;
  ctx.fillStyle = ink;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.ellipse(0, 3, 2.6, 3.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, -1.2, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  for (const side of [-1, 1]) {
    for (const [y, bend, end] of [[-1.5, -4, -4], [0, -5, 0], [1.5, -4, 4], [3, -3, 7]] as const) {
      ctx.moveTo(side * 2, y + 1);
      ctx.lineTo(side * 5, y + bend / 2 + 1);
      ctx.lineTo(side * 6.5, end);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function runCobwebs(host: HTMLElement, canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const ink = getComputedStyle(host).getPropertyValue("--bone").trim() || "#fffdf2";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let sim: CobwebSim | null = null;
  let dust: HTMLCanvasElement | null = null;
  /** The size the webs and dust grew at; the canvas stretches them to the footer. */
  let width = 0;
  let height = 0;
  let raf = 0;
  let quietFrames = 0;
  let brush: Point | null = null;
  let lastBrush: Point | null = null;
  /** The pointer moved since the last frame; a resting pointer lets the loop sleep. */
  let moved = false;

  const build = () => {
    width = host.clientWidth;
    height = host.clientHeight;
    sim = buildCobwebs(LEVEL, width, height, SEED);
    dust = buildDust(LEVEL, width, height);
    canvas.dataset.cobwebs = "webs";
  };

  /** Footer CSS px per sim unit, on the smaller axis so the brush reaches its full radius both ways. */
  const scale = () => Math.min((host.clientWidth || width) / width, (host.clientHeight || height) / height);

  const draw = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!width || !height) return;
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    if (dust) {
      // The film is a mask: draw it, then paint the ink through it.
      ctx.globalAlpha = 1;
      ctx.drawImage(dust, 0, 0, width, height);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = ink;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";
    }
    if (!sim) return;
    // Threads bucketed by brightness, so a frame is ~20 strokes, not thousands.
    const buckets: Point[][] = [];
    for (const s of sim.strands) {
      if (s.broken) continue;
      const A = sim.points[s.a]!;
      const B = sim.points[s.b]!;
      const alpha = s.alpha * Math.min(A.life, B.life);
      if (alpha <= 0) continue;
      const k = Math.min(10, Math.round(alpha * 10));
      (buckets[k] ??= []).push(A, B);
    }
    ctx.strokeStyle = ink;
    ctx.lineCap = "round";
    const px = 1 / scale();
    // A soft halo, then the hairline itself: silk catching the light.
    for (const [lineWidth, strength] of [[2.2, 0.14], [0.6, 1]] as const) {
      ctx.lineWidth = lineWidth * px;
      buckets.forEach((list, k) => {
        ctx.globalAlpha = (k / 10) * strength * STRAND_OPACITY;
        ctx.beginPath();
        for (let i = 0; i < list.length; i += 2) {
          ctx.moveTo(list[i]!.x, list[i]!.y);
          ctx.lineTo(list[i + 1]!.x, list[i + 1]!.y);
        }
        ctx.stroke();
      });
    }
    if (sim.spider !== null) {
      const spider = sim.points[sim.spider]!;
      if (spider.life > 0) drawSpider(ctx, spider, spider.life, px, ink);
    }
    ctx.globalAlpha = 1;
  };

  const frame = () => {
    raf = 0;
    if (!sim) return;
    const radius = BRUSH_RADIUS / scale();
    stepCobwebs(
      sim,
      brush && { x: brush.x, y: brush.y, prevX: (lastBrush ?? brush).x, prevY: (lastBrush ?? brush).y, radius },
      { reducedMotion: reducedMotion.matches },
    );
    lastBrush = brush;
    if (cobwebsGone(sim)) {
      sim = null;
      canvas.dataset.cobwebs = "dust";
      draw();
      return;
    }
    draw();
    const settling = moved || sim.points.some((p) => p.falling && p.life > 0);
    moved = false;
    quietFrames = settling ? 0 : quietFrames + 1;
    if (quietFrames < SLEEP_AFTER_FRAMES) raf = requestAnimationFrame(frame);
  };

  const wake = () => {
    quietFrames = 0;
    if (!raf && sim) raf = requestAnimationFrame(frame);
  };

  // Sweeping only watches the pointer: the canvas takes no input, so the
  // footer's links and button work exactly as before.
  host.addEventListener(
    "pointermove",
    (e) => {
      const rect = canvas.getBoundingClientRect();
      brush = { x: ((e.clientX - rect.left) / rect.width) * width, y: ((e.clientY - rect.top) / rect.height) * height };
      moved = true;
      wake();
    },
    { passive: true },
  );
  host.addEventListener("pointerleave", () => {
    brush = null;
    lastBrush = null;
  });

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(host.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(host.clientHeight * dpr));
    if (!dust || Math.abs(host.clientWidth - width) > REBUILD_AFTER_PX) build();
    draw();
  };
  new ResizeObserver(resize).observe(host);
  resize();
}

const host = document.querySelector<HTMLElement>(".foot");
const canvas = host?.querySelector<HTMLCanvasElement>(".webs");
if (host && canvas) runCobwebs(host, canvas);
