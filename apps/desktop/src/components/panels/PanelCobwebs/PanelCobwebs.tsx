import { useRef } from "react";
import type { PaneNode } from "../../../lib/layout/pane-tree";
import { allTabIds, cobwebLevel } from "../../../lib/cobwebs";
import {
  buildCobwebs,
  cobwebsGone,
  stepCobwebs,
  type CobwebSim,
} from "../../../lib/cobweb-sim";
import { tabLastReturn, useTabSightings } from "../../../store/tab-sightings";
import { useAppStore } from "../../../store/app-store";
import { useHalloweenEffects } from "../../../hooks/useHalloweenEffects";
import { useMountEffect } from "../../../hooks/useMountEffect";
import styles from "./PanelCobwebs.module.css";

/** The brush's reach around the pointer, in CSS px. */
const BRUSH_RADIUS = 36;
/** The dust film wipes off a little wider than the threads do. */
const DUST_BRUSH_RADIUS = BRUSH_RADIUS * 1.8;
/** Frames with nothing moving before the loop sleeps until the mouse returns. */
const SLEEP_AFTER_FRAMES = 90;

/**
 * What a tab's panel is wearing: webs, a dust film, and which return to the
 * front they grew for. Kept per tab, outside React, so a half-wiped panel
 * still has its leftovers when you come back before it gathers more, and a
 * wiped one stays wiped (both null) when its panel remounts, say on a split.
 */
type Remnant = {
  sim: CobwebSim | null;
  dust: HTMLCanvasElement | null;
  /** `TabReturn.at` of the visit these belong to. */
  stamp: number;
  width: number;
  height: number;
};

const remnants = new Map<string, Remnant>();

function hasBrowserPane(node: PaneNode): boolean {
  if (node.type === "leaf") return node.contentType === "browser";
  return hasBrowserPane(node.first) || hasBrowserPane(node.second);
}

/** The dust film as an alpha mask; it takes the theme's ink when drawn. */
function buildDust(level: number, width: number, height: number): HTMLCanvasElement {
  const dust = document.createElement("canvas");
  dust.width = Math.ceil(width);
  dust.height = Math.ceil(height);
  const ctx = dust.getContext("2d");
  if (!ctx) return dust;
  ctx.fillStyle = "#fff";
  ctx.globalAlpha = 0.018 * level;
  ctx.fillRect(0, 0, width, height);
  // Specks settle thicker toward the top of the panel.
  const specks = Math.round((width * height * level) / 800);
  for (let i = 0; i < specks; i++) {
    ctx.globalAlpha = 0.04 + Math.random() * 0.16;
    ctx.beginPath();
    ctx.arc(Math.random() * width, Math.pow(Math.random(), 1.6) * height, 0.3 + Math.random() * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
  return dust;
}

function wipeDust(
  dust: HTMLCanvasElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
): void {
  const ctx = dust.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 6));
  for (let i = 0; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, "rgba(0,0,0,.35)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function liveStrands(sim: CobwebSim): number {
  return sim.strands.filter((s) => !s.broken).length;
}

/** The remnant to show for this visit: leftovers, fresh webs, or nothing. */
function remnantFor(tabId: string, width: number, height: number): Remnant | null {
  // Closed tabs take their leftovers (and their dust canvases) with them.
  const open = allTabIds(useAppStore.getState().workspaceLayouts);
  for (const id of remnants.keys()) {
    if (!open.has(id)) remnants.delete(id);
  }
  const visit = tabLastReturn(tabId);
  const kept = remnants.get(tabId) ?? null;
  if (!visit || (kept && kept.stamp === visit.at)) return kept;
  const level = cobwebLevel(visit.unseenMs);
  if (level === 0) {
    if (kept) kept.stamp = visit.at;
    return kept;
  }
  if (width < 40 || height < 40) return null;
  const fresh: Remnant = {
    sim: buildCobwebs(level, width, height, visit.at | 0),
    dust: level >= 2 ? buildDust(level, width, height) : null,
    stamp: visit.at,
    width,
    height,
  };
  remnants.set(tabId, fresh);
  return fresh;
}

/** Draw, step and wipe one panel's webs until they're gone or the panel goes. */
function runCobwebs(tabId: string, canvas: HTMLCanvasElement, host: HTMLElement): (() => void) | undefined {
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  const remnant = remnantFor(tabId, host.clientWidth, host.clientHeight);
  if (!remnant || (!remnant.sim && !remnant.dust)) return undefined;
  const readInk = () => getComputedStyle(host).getPropertyValue("--text-selected").trim() || "#cdd6f4";
  let ink = readInk();
  canvas.dataset.cobwebs = remnant.sim ? "webs" : "dust";
  if (remnant.sim) canvas.dataset.strands = String(liveStrands(remnant.sim));

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let raf = 0;
  let quietFrames = 0;
  let brush: { x: number; y: number } | null = null;
  let lastBrush: { x: number; y: number } | null = null;
  /** The pointer moved since the last frame; a resting pointer lets the loop sleep. */
  let moved = false;

  /**
   * Panel CSS px per sim unit; the sim keeps the size it grew at. The
   * smaller axis, so the brush reaches its full radius both ways.
   */
  const scale = () =>
    Math.min(
      (host.clientWidth || remnant.width) / remnant.width,
      (host.clientHeight || remnant.height) / remnant.height,
    );

  const draw = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(canvas.width / remnant.width, 0, 0, canvas.height / remnant.height, 0, 0);
    if (remnant.dust) {
      // The film is a mask: draw it, then paint the theme's ink through it.
      ctx.globalAlpha = 1;
      ctx.drawImage(remnant.dust, 0, 0, remnant.width, remnant.height);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = ink;
      ctx.fillRect(0, 0, remnant.width, remnant.height);
      ctx.globalCompositeOperation = "source-over";
    }
    const sim = remnant.sim;
    if (!sim) return;
    // Threads bucketed by brightness, so a frame is ~20 strokes, not thousands.
    const buckets: Array<Array<{ x: number; y: number }>> = [];
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
    for (const [width, strength] of [[2.2, 0.14], [0.6, 1]] as const) {
      ctx.lineWidth = width * px;
      buckets.forEach((list, k) => {
        if (!list) return;
        ctx.globalAlpha = (k / 10) * strength;
        ctx.beginPath();
        for (let i = 0; i < list.length; i += 2) {
          ctx.moveTo(list[i]!.x, list[i]!.y);
          ctx.lineTo(list[i + 1]!.x, list[i + 1]!.y);
        }
        ctx.stroke();
      });
    }
    if (sim.spider !== null) {
      const s = sim.points[sim.spider]!;
      if (s.life > 0) {
        ctx.save();
        ctx.translate(s.x, s.y + 3 * px);
        ctx.scale(px, px);
        ctx.globalAlpha = 0.85 * s.life;
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
          for (const [y, bend, end] of [[-1.5, -4, -4], [0, -5, 0], [1.5, -4, 4], [3, -3, 7]]) {
            ctx.moveTo(side * 2, y! + 1);
            ctx.lineTo(side * 5, y! + bend! / 2 + 1);
            ctx.lineTo(side * 6.5, end!);
          }
        }
        ctx.stroke();
        ctx.restore();
      }
    }
  };

  const frame = () => {
    raf = 0;
    const sim = remnant.sim;
    if (!sim) return;
    // Hidden with its workspace or window: stay put until the mouse is back.
    if (!canvas.checkVisibility({ visibilityProperty: true })) return;
    const radius = BRUSH_RADIUS / scale();
    stepCobwebs(
      sim,
      brush && { x: brush.x, y: brush.y, prevX: (lastBrush ?? brush).x, prevY: (lastBrush ?? brush).y, radius },
      { reducedMotion: reducedMotion.matches },
    );
    lastBrush = brush;
    if (cobwebsGone(sim)) {
      remnant.sim = null;
      canvas.dataset.cobwebs = remnant.dust ? "dust" : "gone";
      canvas.dataset.strands = "0";
      draw();
      return;
    }
    draw();
    const settling = moved || sim.points.some((p) => p.falling && p.life > 0);
    moved = false;
    quietFrames = settling ? 0 : quietFrames + 1;
    if (quietFrames < SLEEP_AFTER_FRAMES) raf = requestAnimationFrame(frame);
    else canvas.dataset.strands = String(liveStrands(sim));
  };

  const wake = () => {
    quietFrames = 0;
    if (!raf && remnant.sim) raf = requestAnimationFrame(frame);
  };

  const toSim = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * remnant.width,
      y: ((e.clientY - rect.top) / rect.height) * remnant.height,
    };
  };

  // Wiping only watches the pointer: the canvas takes no input, so clicks,
  // selection, scrolling and typing reach the panes exactly as before.
  const onMove = (e: PointerEvent) => {
    const at = toSim(e);
    if (remnant.dust) {
      wipeDust(remnant.dust, brush ?? at, at, DUST_BRUSH_RADIUS / scale());
      if (!remnant.sim) draw();
    }
    brush = at;
    moved = true;
    wake();
  };
  const onLeave = () => {
    brush = null;
    lastBrush = null;
  };

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(host.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(host.clientHeight * dpr));
    draw();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  // A theme change rewrites the root's inline style: repaint in the new ink.
  const themeWatch = new MutationObserver(() => {
    ink = readInk();
    draw();
  });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  resize();
  host.addEventListener("pointermove", onMove, { capture: true, passive: true });
  host.addEventListener("pointerleave", onLeave);
  wake();

  return () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
    themeWatch.disconnect();
    host.removeEventListener("pointermove", onMove, { capture: true });
    host.removeEventListener("pointerleave", onLeave);
  };
}

function CobwebCanvas(props: { tabId: string }) {
  const { tabId } = props;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  useMountEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    return runCobwebs(tabId, canvas, host);
  });

  return <canvas ref={canvasRef} className={styles.canvas} data-testid="panel-cobwebs" aria-hidden="true" />;
}

type PanelCobwebsProps = {
  /** The panel's selected tab. */
  tabId: string | null | undefined;
  rootNode: PaneNode | undefined;
};

/**
 * During Halloween week, the cobwebs over a panel whose tab you've come
 * back to after a while, swept away by moving the mouse across them. Tabs
 * holding a browser pane get none: the page inside swallows the mouse.
 */
export function PanelCobwebs(props: PanelCobwebsProps) {
  const { tabId, rootNode } = props;

  const enabled = useHalloweenEffects();
  useTabSightings(enabled);
  if (!enabled || !tabId || !rootNode || hasBrowserPane(rootNode)) return null;
  // Keyed by tab: each visit to a tab is its own canvas and its own loop.
  return <CobwebCanvas key={tabId} tabId={tabId} />;
}
