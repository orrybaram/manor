import type { BrowserContext, CDPSession, Page } from "@playwright/test";

/**
 * What a drag felt like, measured from inside the renderer.
 *
 * Wall-clock totals say almost nothing about snappiness — a drag that paints
 * every 16ms for a second feels instant, and one that paints twice in 300ms
 * feels broken. So the numbers that matter here are all about *gaps*: the
 * longest stretch the main thread went without giving the compositor a frame,
 * and how long the first feedback took to arrive.
 */
export type DragPerf = {
  /** mousedown → the first `selectionchange` the document reported. */
  firstSelectionMs: number | null;
  /** mouseup → the comment chip existing in the DOM. The chip is the payoff,
   *  and it is deliberately not offered until the button is released. */
  chipAfterReleaseMs: number | null;
  /** How long the drag itself took, mousedown to mouseup. */
  dragMs: number;
  /** Frames the renderer produced between mousedown and mouseup. */
  frames: number;
  /** The worst gap between consecutive frames, in ms. This is the number. */
  worstFrameGapMs: number;
  /** Every gap over 50ms, so a report can show the shape of the jank. */
  frameGapsMs: number[];
  /** Long tasks (>50ms of blocked main thread) overlapping the drag. */
  longTasks: { startMs: number; durationMs: number }[];
  /** Total ms the main thread was blocked while the drag was in flight. */
  blockedMs: number;
  /** Rows the pane had in the DOM when the drag started. */
  domRows: number;
  /** Elements in the pane's subtree when the drag started. */
  domNodes: number;
  /**
   * Where the drag's time actually went, from the renderer's own counters.
   *
   * This is the half a frame clock cannot tell you. A gap with no script in it
   * is the browser doing style, layout and paint — which is a DOM-size
   * problem, and no amount of debouncing JS will touch it.
   */
  cost: RendererCost;
  /**
   * The same counters sampled over an equally long span with no drag at all.
   *
   * Without this a loaded window makes every drag look expensive, because the
   * bill includes everything else on the main thread. The difference is the
   * only honest answer to "what does dragging cost".
   */
  idleCost?: RendererCost;
};

/** Renderer seconds spent in each phase, sampled across one drag. */
export type RendererCost = {
  scriptMs: number;
  recalcStyleMs: number;
  layoutMs: number;
};

/**
 * A CDP handle on the renderer's cumulative timers, so a drag can be charged
 * against them. `Performance.getMetrics` reports totals since the page loaded;
 * the difference across a drag is that drag's bill.
 */
export class RendererCostMeter {
  private constructor(private readonly session: CDPSession) {}

  static async attach(
    context: BrowserContext,
    page: Page,
  ): Promise<RendererCostMeter> {
    const session = await context.newCDPSession(page);
    await session.send("Performance.enable");
    return new RendererCostMeter(session);
  }

  async sample(): Promise<Record<string, number>> {
    const { metrics } = await this.session.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  }

  static difference(
    before: Record<string, number>,
    after: Record<string, number>,
  ): RendererCost {
    const delta = (name: string) =>
      Math.round(((after[name] ?? 0) - (before[name] ?? 0)) * 1000);
    return {
      scriptMs: delta("ScriptDuration"),
      recalcStyleMs: delta("RecalcStyleDuration"),
      layoutMs: delta("LayoutDuration"),
    };
  }

  async detach(): Promise<void> {
    await this.session.detach().catch(() => {});
  }

  /** Begin sampling the renderer's stack. 100µs, so a 2s drag is ~20k samples. */
  async startProfile(): Promise<void> {
    await this.session.send("Profiler.enable");
    await this.session.send("Profiler.setSamplingInterval", { interval: 100 });
    await this.session.send("Profiler.start");
  }

  /**
   * Stop sampling and return the hottest frames by self time.
   *
   * Self time, not total: the question is which function is *doing* the work,
   * not which one is on the stack above it.
   */
  async stopProfile(top = 18): Promise<string[]> {
    const { profile } = await this.session.send("Profiler.stop");
    await this.session.send("Profiler.disable");

    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const selfTicks = new Map<number, number>();
    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];
    for (let i = 0; i < samples.length; i++) {
      const id = samples[i];
      selfTicks.set(id, (selfTicks.get(id) ?? 0) + (deltas[i] ?? 0));
    }

    const total = [...selfTicks.values()].reduce((a, b) => a + b, 0) || 1;
    return [...selfTicks.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([id, micros]) => {
        const frame = byId.get(id)?.callFrame;
        const name = frame?.functionName || "(anonymous)";
        const where = frame?.url
          ? `${frame.url.split("/").slice(-1)[0]}:${(frame.lineNumber ?? 0) + 1}`
          : "";
        const ms = (micros / 1000).toFixed(1);
        const pct = ((micros / total) * 100).toFixed(1);
        return `  ${ms.padStart(8)}ms  ${pct.padStart(5)}%  ${name} ${where}`;
      });
  }
}

declare global {
  interface Window {
    __dragPerf?: {
      t0: number;
      frames: number[];
      longTasks: { startMs: number; durationMs: number }[];
      firstSelection: number | null;
      chip: number | null;
      release: number | null;
      observer: PerformanceObserver;
      rafId: number;
      stop: () => void;
    };
  }
}

/**
 * Arm the probe. Call immediately before the mousedown — `t0` is set here, and
 * every timestamp in the report is relative to it.
 *
 * The rAF loop is the frame clock: the browser only runs it once per produced
 * frame, so the gaps between its ticks are exactly the stretches where the
 * user saw nothing change.
 */
export async function startDragProbe(window: Page): Promise<void> {
  await window.evaluate(() => {
    const t0 = performance.now();
    const frames: number[] = [];
    const longTasks: { startMs: number; durationMs: number }[] = [];

    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({
          startMs: entry.startTime - t0,
          durationMs: entry.duration,
        });
      }
    });
    observer.observe({ entryTypes: ["longtask"] });

    const state: NonNullable<Window["__dragPerf"]> = {
      t0,
      frames,
      longTasks,
      firstSelection: null,
      chip: null,
      release: null,
      observer,
      rafId: 0,
      stop: () => {},
    };

    const tick = () => {
      frames.push(performance.now() - t0);
      state.rafId = requestAnimationFrame(tick);
    };
    state.rafId = requestAnimationFrame(tick);

    const onSelection = () => {
      if (state.firstSelection !== null) return;
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed)
        state.firstSelection = performance.now() - t0;
    };
    document.addEventListener("selectionchange", onSelection);

    // Recorded in the capture phase so it lands before the app's own mouseup
    // handlers, making the chip's latency the app's cost and not the probe's.
    const onRelease = () => {
      if (state.release === null) state.release = performance.now() - t0;
    };
    document.addEventListener("mouseup", onRelease, true);

    // The chip is portalled to the body, so watching the body's child list is
    // enough to catch it, and cheaper than a subtree observer during a drag.
    const mutations = new MutationObserver(() => {
      if (state.chip !== null) return;
      if (document.querySelector('[data-testid="selection-comment-chip"]'))
        state.chip = performance.now() - t0;
    });
    mutations.observe(document.body, { childList: true, subtree: true });

    state.stop = () => {
      cancelAnimationFrame(state.rafId);
      observer.disconnect();
      mutations.disconnect();
      document.removeEventListener("selectionchange", onSelection);
      document.removeEventListener("mouseup", onRelease, true);
    };

    window.__dragPerf = state;
  });
}

/** Disarm the probe and read the numbers back. */
export async function readDragProbe(
  window: Page,
  extras: {
    domRows: number;
    domNodes: number;
    cost: RendererCost;
    idleCost?: RendererCost;
  },
): Promise<DragPerf> {
  const raw = await window.evaluate(() => {
    const state = window.__dragPerf;
    if (!state) throw new Error("drag probe was never started");
    state.stop();
    const end = performance.now() - state.t0;
    delete window.__dragPerf;
    return {
      frames: state.frames,
      longTasks: state.longTasks,
      firstSelection: state.firstSelection,
      chip: state.chip,
      release: state.release,
      end,
    };
  });

  const gaps: number[] = [];
  for (let i = 1; i < raw.frames.length; i++) {
    gaps.push(raw.frames[i] - raw.frames[i - 1]);
  }
  // A gap before the first frame counts too: a drag whose very first paint is
  // 300ms late is the worst case, not an unmeasured one.
  if (raw.frames.length > 0) gaps.unshift(raw.frames[0]);

  return {
    firstSelectionMs: raw.firstSelection,
    chipAfterReleaseMs:
      raw.chip !== null && raw.release !== null ? raw.chip - raw.release : null,
    dragMs: Math.round(raw.release ?? raw.end),
    frames: raw.frames.length,
    worstFrameGapMs: gaps.length > 0 ? Math.max(...gaps) : raw.end,
    frameGapsMs: gaps.filter((g) => g > 50).map((g) => Math.round(g)),
    longTasks: raw.longTasks.map((t) => ({
      startMs: Math.round(t.startMs),
      durationMs: Math.round(t.durationMs),
    })),
    blockedMs: Math.round(
      raw.longTasks.reduce((sum, t) => sum + Math.max(0, t.durationMs - 50), 0),
    ),
    ...extras,
  };
}

/** A human-readable block for the test log. */
export function formatDragPerf(label: string, perf: DragPerf): string {
  const lines = [
    `── ${label} ──`,
    `  DOM               ${perf.domRows} rows, ${perf.domNodes} elements in the pane`,
    `  first selection   ${fmt(perf.firstSelectionMs)} after mousedown`,
    `  comment chip      ${fmt(perf.chipAfterReleaseMs)} after mouseup`,
    `  drag length       ${perf.dragMs}ms`,
    `  frames produced   ${perf.frames}`,
    `  worst frame gap   ${Math.round(perf.worstFrameGapMs)}ms`,
    `  gaps over 50ms    ${perf.frameGapsMs.length > 0 ? perf.frameGapsMs.join(", ") + "ms" : "none"}`,
    `  long tasks        ${perf.longTasks.length} (${perf.blockedMs}ms blocking)`,
    `  renderer spent    ${perf.cost.scriptMs}ms script, ${perf.cost.recalcStyleMs}ms style, ${perf.cost.layoutMs}ms layout`,
  ];
  if (perf.idleCost) {
    const share = perf.cost.scriptMs - perf.idleCost.scriptMs;
    lines.push(
      `  window's own bill ${perf.idleCost.scriptMs}ms script over the same span with no drag`,
      `  → the drag itself ${share > 0 ? share : 0}ms script`,
    );
  }
  for (const task of perf.longTasks) {
    lines.push(`      +${task.startMs}ms for ${task.durationMs}ms`);
  }
  return lines.join("\n");
}

function fmt(value: number | null): string {
  return value === null ? "never" : `${Math.round(value)}ms`;
}
