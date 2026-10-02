import fs from "fs";
import path from "path";
import AxeBuilder from "@axe-core/playwright";
import type { CDPSession, Page } from "@playwright/test";

/**
 * The phone audit's instruments (`mobile-audit.spec.ts`). Everything here
 * measures the page from the outside — a PerformanceObserver installed before
 * the app's first script, DOM geometry read after the fact, axe, and CDP —
 * so the app carries no instrumentation of its own for it.
 */

/** A mid-range phone on a mediocre connection: what the budgets assume. */
export const PHONE_PROFILE = {
  /** Chromium's CPU throttle: 4× is DevTools' "mid-tier mobile". */
  cpuSlowdown: 4,
  /**
   * DevTools' "Fast 4G" round trip. Applied by `latency-proxy.ts` in front of
   * the relay, not by Chromium: its emulation does not delay WebSocket
   * frames, which is where the phone's bridge calls all go.
   */
  rttMs: 150,
  network: {
    offline: false,
    // DevTools' "Fast 4G" bandwidth: ~9 Mbps down, ~1.5 Mbps up.
    latency: 0,
    downloadThroughput: (9 * 1024 * 1024) / 8,
    uploadThroughput: (1.5 * 1024 * 1024) / 8,
  },
};

export async function throttle(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", PHONE_PROFILE.network);
  await cdp.send("Emulation.setCPUThrottlingRate", {
    rate: PHONE_PROFILE.cpuSlowdown,
  });
  await cdp.send("Performance.enable");
  return cdp;
}

/** Turn the CPU throttle off/on around steps that only read geometry. */
export async function setCpuThrottle(cdp: CDPSession, on: boolean) {
  await cdp.send("Emulation.setCPUThrottlingRate", {
    rate: on ? PHONE_PROFILE.cpuSlowdown : 1,
  });
}

/**
 * Installed before any of the page's own scripts: long tasks, layout shifts,
 * paint and LCP timings, and event timing, into `window.__audit`.
 */
export const PERF_INIT_SCRIPT = `
(() => {
  const a = (window.__audit = {
    longTasks: [], shifts: [], paints: {}, lcp: 0, events: [], marks: {}, lastInput: null,
  });
  // When the finger (or key) actually landed, as the page saw it — the start
  // of every interaction timing, rather than when the test asked for it.
  for (const type of ["touchstart", "pointerdown", "keydown"]) {
    addEventListener(type, (e) => { if (a.lastInput === null) a.lastInput = e.timeStamp; }, { capture: true, passive: true });
  }
  const observe = (type, fn, extra) => {
    try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true, ...extra }); } catch {}
  };
  observe("longtask", (e) => a.longTasks.push({ start: e.startTime, duration: e.duration }));
  observe("layout-shift", (e) => { if (!e.hadRecentInput) a.shifts.push({ at: e.startTime, value: e.value }); });
  observe("paint", (e) => (a.paints[e.name] = e.startTime));
  observe("largest-contentful-paint", (e) => (a.lcp = e.startTime));
  observe("event", (e) => a.events.push({ name: e.name, start: e.startTime, duration: e.duration, processing: e.processingEnd - e.processingStart }), { durationThreshold: 16 });
  // First frame each milestone was on screen, to the frame rather than to
  // Playwright's polling interval.
  const milestones = {
    app: () => document.querySelector(".app"),
    topBar: () => document.querySelector('[data-testid="phone-top-bar"]'),
    terminal: () => document.querySelector('[data-testid="terminal-pane"] .xterm-screen'),
    prompt: () => Array.from(document.querySelectorAll(".xterm-rows")).some((r) => /\$\s*$/m.test(r.textContent || "")),
  };
  const tick = () => {
    for (const [k, test] of Object.entries(milestones)) {
      if (a.marks[k] === undefined && test()) a.marks[k] = performance.now();
    }
    if (Object.keys(a.marks).length < Object.keys(milestones).length) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
`;

/**
 * Wraps `window.electronAPI` the moment the bridge installs it, recording
 * when each call started and settled — the order of the startup waterfall,
 * which the encrypted WebSocket frames cannot show. Subscriptions (`on*`)
 * are left alone.
 */
export const BRIDGE_TRACE_SCRIPT = `
(() => {
  const calls = (window.__bridgeCalls = []);
  const cache = new WeakMap();
  const trace = (target, path) => {
    if (cache.has(target)) return cache.get(target);
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        const v = Reflect.get(t, key, receiver);
        if (typeof key !== "string") return v;
        if (typeof v === "function") {
          if (/^on[A-Z]/.test(key)) return v;
          return function (...args) {
            const rec = { name: path + key, start: performance.now(), end: null };
            calls.push(rec);
            const r = v.apply(t, args);
            if (r && typeof r.then === "function") {
              r.then(() => (rec.end = performance.now()), () => (rec.end = performance.now()));
            } else rec.end = rec.start;
            return r;
          };
        }
        if (v && typeof v === "object" && path.split(".").length < 3) return trace(v, path + key + ".");
        return v;
      },
    });
    cache.set(target, proxy);
    return proxy;
  };
  let api;
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    get: () => api,
    set: (v) => { api = v && typeof v === "object" ? trace(v, "") : v; },
  });
})();
`;

export interface BridgeCall {
  name: string;
  start: number;
  end: number | null;
}

export async function bridgeCalls(page: Page): Promise<BridgeCall[]> {
  return page.evaluate(() =>
    JSON.parse(JSON.stringify((window as unknown as { __bridgeCalls: unknown }).__bridgeCalls ?? [])),
  );
}

export interface PerfSnapshot {
  longTasks: { start: number; duration: number }[];
  shifts: { at: number; value: number }[];
  paints: Record<string, number>;
  lcp: number;
  events: { name: string; start: number; duration: number; processing: number }[];
  marks: Record<string, number>;
}

export async function perfSnapshot(page: Page): Promise<PerfSnapshot> {
  return page.evaluate(
    () => JSON.parse(JSON.stringify((window as unknown as { __audit: unknown }).__audit)),
  );
}

export interface ResourceSummary {
  requests: number;
  transferKB: number;
  decodedKB: number;
  byType: Record<string, { count: number; transferKB: number; decodedKB: number }>;
  largest: { name: string; transferKB: number; decodedKB: number }[];
}

export async function resourceSummary(page: Page): Promise<ResourceSummary> {
  return page.evaluate(() => {
    const entries = performance.getEntriesByType(
      "resource",
    ) as PerformanceResourceTiming[];
    const kb = (n: number) => Math.round(n / 102.4) / 10;
    const byType: Record<string, { count: number; transferKB: number; decodedKB: number }> = {};
    let transfer = 0;
    let decoded = 0;
    for (const e of entries) {
      const ext = new URL(e.name).pathname.split(".").pop() ?? "?";
      const t = (byType[ext] ??= { count: 0, transferKB: 0, decodedKB: 0 });
      t.count++;
      t.transferKB += kb(e.transferSize);
      t.decodedKB += kb(e.decodedBodySize);
      transfer += e.transferSize;
      decoded += e.decodedBodySize;
    }
    const largest = [...entries]
      .sort((x, y) => y.decodedBodySize - x.decodedBodySize)
      .slice(0, 12)
      .map((e) => ({
        name: new URL(e.name).pathname.split("/").pop() ?? e.name,
        transferKB: kb(e.transferSize),
        decodedKB: kb(e.decodedBodySize),
      }));
    for (const t of Object.values(byType)) {
      t.transferKB = Math.round(t.transferKB);
      t.decodedKB = Math.round(t.decodedKB);
    }
    return {
      requests: entries.length,
      transferKB: Math.round(kb(transfer)),
      decodedKB: Math.round(kb(decoded)),
      byType,
      largest,
    };
  });
}

export interface LayoutIssue {
  kind:
    | "page-overflow-x"
    | "offscreen-x"
    | "small-target"
    | "tiny-target"
    | "input-zoom"
    | "tiny-text"
    | "clipped-text";
  selector: string;
  detail: string;
}

/**
 * Geometry checks over what is actually visible: horizontal overflow, tap
 * targets (WCAG 2.5.8 minimum 24px is "tiny"; Apple's 44pt is "small"),
 * inputs under 16px (iOS zooms the page on focus), text under 11px, and
 * single-line text clipped by its box without an ellipsis.
 */
export async function layoutAudit(page: Page): Promise<LayoutIssue[]> {
  return page.evaluate(() => {
    const issues: {
      kind: string;
      selector: string;
      detail: string;
    }[] = [];
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const describe = (el: Element): string => {
      const parts: string[] = [];
      let node: Element | null = el;
      for (let i = 0; node && i < 3; i++, node = node.parentElement) {
        const id = node.getAttribute("data-testid");
        const label = node.getAttribute("aria-label");
        let s = node.tagName.toLowerCase();
        if (id) s += `[data-testid=${id}]`;
        else if (label) s += `[aria-label="${label}"]`;
        else if (typeof node.className === "string" && node.className)
          s += "." + node.className.split(/\s+/)[0];
        parts.unshift(s);
        if (id) break;
      }
      return parts.join(" > ");
    };
    const visible = (el: Element): boolean => {
      const he = el as HTMLElement;
      if (
        !he.checkVisibility?.({
          visibilityProperty: true,
          opacityProperty: true,
        })
      )
        return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      // Entirely outside the visual viewport vertically: scrolled content,
      // not a defect of this screen.
      if (r.bottom <= 0 || r.top >= vh) return false;
      // Inert / aria-hidden subtrees (behind a modal) are not reachable.
      if (el.closest("[inert],[aria-hidden=true]")) return false;
      return true;
    };

    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollWidth > vw + 1) {
      issues.push({
        kind: "page-overflow-x",
        selector: "document",
        detail: `scrollWidth ${root.scrollWidth} > viewport ${vw}`,
      });
    }

    const seenOff = new Set<Element>();
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      // Inside a horizontally scrolling container is fine (tab strip).
      let clipped = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox !== "visible") {
          const pr = p.getBoundingClientRect();
          if (pr.right <= vw + 1 && pr.left >= -1) clipped = true;
          break;
        }
      }
      if (!clipped && (r.right > vw + 1 || r.left < -1)) {
        // Report only the outermost offender.
        if (![...seenOff].some((o) => o.contains(el))) {
          seenOff.add(el);
          issues.push({
            kind: "offscreen-x",
            selector: describe(el),
            detail: `x ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`,
          });
        }
      }
    }

    const interactive = document.querySelectorAll(
      'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=radio], [role=switch], [role=checkbox], [role=menuitem], [role=option], [cmdk-item]',
    );
    for (const el of Array.from(interactive)) {
      if (!visible(el)) continue;
      // xterm's hidden helper textarea is positioned under the cursor on
      // purpose; it is not a target anyone taps.
      if (el.classList.contains("xterm-helper-textarea")) continue;
      const r = el.getBoundingClientRect();
      const min = Math.min(r.width, r.height);
      const size = `${Math.round(r.width)}×${Math.round(r.height)}`;
      if (min < 24) {
        issues.push({ kind: "tiny-target", selector: describe(el), detail: size });
      } else if (min < 44) {
        issues.push({ kind: "small-target", selector: describe(el), detail: size });
      }
    }

    for (const el of Array.from(
      document.querySelectorAll(
        "input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true]",
      ),
    )) {
      if (!visible(el) && !el.classList.contains("xterm-helper-textarea"))
        continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 16) {
        issues.push({
          kind: "input-zoom",
          selector: describe(el),
          detail: `font-size ${fs}px (iOS zooms on focus under 16px)`,
        });
      }
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const textEls = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const p = n.parentElement;
      if (p && !p.closest(".xterm")) textEls.add(p);
    }
    for (const el of textEls) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize);
      if (fs < 11) {
        issues.push({
          kind: "tiny-text",
          selector: describe(el),
          detail: `${fs}px "${el.textContent!.trim().slice(0, 30)}"`,
        });
      }
      const he = el as HTMLElement;
      if (
        he.scrollWidth > he.clientWidth + 1 &&
        cs.overflowX === "hidden" &&
        cs.textOverflow !== "ellipsis" &&
        cs.whiteSpace === "nowrap"
      ) {
        issues.push({
          kind: "clipped-text",
          selector: describe(el),
          detail: `"${el.textContent!.trim().slice(0, 40)}" ${he.scrollWidth}>${he.clientWidth}`,
        });
      }
    }
    return issues as LayoutIssue[];
  });
}

export interface AxeIssue {
  id: string;
  impact: string | null;
  help: string;
  nodes: string[];
}

export async function axeAudit(page: Page): Promise<AxeIssue[]> {
  const result = await new AxeBuilder({ page })
    // xterm's accessibility tree is its own concern; the canvas is not text.
    .exclude(".xterm-screen")
    .analyze();
  return result.violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    nodes: v.nodes.slice(0, 6).map((n) => n.target.join(" ")),
  }));
}

/**
 * Milliseconds from the input `action` produces landing in the page to the
 * first animation frame on which `done(arg)` holds — both read off the
 * page's own clock, so neither the test's own round trips nor Playwright's
 * backing-off `expect` polling are in the number. `done` runs in the page.
 */
export async function timed<A>(
  page: Page,
  action: () => Promise<void>,
  done: (arg: A) => boolean,
  arg?: A,
): Promise<number> {
  await page.evaluate(() => {
    (window as unknown as { __audit: { lastInput: number | null } }).__audit.lastInput = null;
  });
  await action();
  await page.waitForFunction(done, arg as A, { polling: "raf", timeout: 15_000 });
  // Read straight after: a CDP round trip of slack, a few milliseconds. (A
  // string predicate could stamp the frame itself, but Playwright `eval`s
  // strings in the page, which the app's CSP rightly refuses.)
  const doneAt = await page.evaluate(() => performance.now());
  const start = await page.evaluate(
    () => (window as unknown as { __audit: { lastInput: number | null } }).__audit.lastInput,
  );
  return doneAt - (start ?? doneAt);
}

export interface ScreenAudit {
  name: string;
  terminal: TerminalGeometry[];
  viewport: { width: number; height: number };
  screenshot: string;
  layout: LayoutIssue[];
  axe: AxeIssue[];
}

export class AuditReport {
  readonly dir: string;
  readonly screens: ScreenAudit[] = [];
  readonly timings: Record<string, number | number[]> = {};
  readonly notes: string[] = [];
  data: Record<string, unknown> = {};

  constructor(dir: string) {
    this.dir = dir;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  async screen(page: Page, name: string, { axe = true } = {}) {
    const file = `${String(this.screens.length + 1).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path: path.join(this.dir, file) });
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const entry: ScreenAudit = {
      name,
      viewport,
      screenshot: file,
      terminal: await terminalGeometry(page),
      layout: await layoutAudit(page),
      axe: axe ? await axeAudit(page) : [],
    };
    this.screens.push(entry);
    return entry;
  }

  time(name: string, ms: number) {
    const existing = this.timings[name];
    const rounded = Math.round(ms);
    if (existing === undefined) this.timings[name] = rounded;
    else if (Array.isArray(existing)) existing.push(rounded);
    else this.timings[name] = [existing, rounded];
  }

  write(): string {
    const json = {
      profile: PHONE_PROFILE,
      timings: this.timings,
      data: this.data,
      notes: this.notes,
      screens: this.screens,
    };
    fs.writeFileSync(
      path.join(this.dir, "report.json"),
      JSON.stringify(json, null, 2),
    );
    const md = this.markdown();
    fs.writeFileSync(path.join(this.dir, "report.md"), md);
    return md;
  }

  markdown(): string {
    const lines: string[] = ["# Phone audit", ""];
    lines.push(
      `Profile: ${PHONE_PROFILE.cpuSlowdown}× CPU, ${PHONE_PROFILE.rttMs} ms RTT (HTTP and WebSocket).`,
      "",
      "## Timings (ms)",
      "",
    );
    for (const [k, v] of Object.entries(this.timings)) {
      const s = Array.isArray(v)
        ? `p50 ${pct(v, 50)} · p95 ${pct(v, 95)} · max ${Math.max(...v)} (n=${v.length})`
        : String(v);
      lines.push(`- **${k}**: ${s}`);
    }
    lines.push("", "## Data", "", "```json", JSON.stringify(this.data, null, 2), "```", "");
    if (this.notes.length) lines.push("## Notes", "", ...this.notes.map((n) => `- ${n}`), "");
    lines.push("## Screens", "");
    for (const s of this.screens) {
      lines.push(
        `### ${s.name} (${s.viewport.width}×${s.viewport.height}) — ${s.screenshot}`,
        "",
      );
      const byKind = new Map<string, LayoutIssue[]>();
      for (const i of s.layout) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i]);
      for (const [kind, list] of byKind) {
        lines.push(`- ${kind} ×${list.length}`);
        for (const i of list.slice(0, 8)) lines.push(`  - \`${i.selector}\` ${i.detail}`);
      }
      for (const a of s.axe) {
        lines.push(`- axe **${a.id}** (${a.impact}): ${a.help}`);
        for (const n of a.nodes.slice(0, 4)) lines.push(`  - \`${n}\``);
      }
      for (const t of s.terminal) {
        lines.push(
          `- terminal ${t.cols}×${t.rows} @ ${t.fontSize}px: screen ${t.screen?.w}×${t.screen?.h} in ${t.container.w}×${t.container.h} (scrollW ${t.container.scrollW}); viewportY ${t.viewportY}/${t.baseY}`,
        );
      }
      if (!s.layout.length && !s.axe.length) lines.push("- clean");
      lines.push("");
    }
    return lines.join("\n");
  }
}

export function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

export interface TerminalGeometry {
  paneId: string;
  cols: number;
  rows: number;
  fontSize: number | undefined;
  container: { w: number; h: number; scrollW: number; scrollLeft: number };
  screen: { w: number; h: number } | null;
  canvas: { cls: string; cssW: number; cssH: number; w: number; h: number; gl?: [number, number] }[];
  dpr: number;
  viewportY: number;
  baseY: number;
}

/** The visible terminal's grid, font and boxes: does the grid fit the phone? */
export async function terminalGeometry(page: Page): Promise<TerminalGeometry[]> {
  return page.evaluate(() => {
    const out: TerminalGeometry[] = [];
    for (const [paneId, h] of window.__manorTerminals ?? []) {
      const el = h.term.element;
      if (!el || !(el as HTMLElement).checkVisibility?.({ visibilityProperty: true })) continue;
      const container = el.closest('[data-testid="terminal-pane"]') as HTMLElement | null;
      const screen = el.querySelector(".xterm-screen") as HTMLElement | null;
      const sr = screen?.getBoundingClientRect();
      out.push({
        paneId,
        cols: h.term.cols,
        rows: h.term.rows,
        fontSize: h.term.options.fontSize,
        container: {
          w: container?.clientWidth ?? 0,
          h: container?.clientHeight ?? 0,
          scrollW: container?.scrollWidth ?? 0,
          scrollLeft: container?.scrollLeft ?? 0,
        },
        screen: sr ? { w: Math.round(sr.width), h: Math.round(sr.height) } : null,
        canvas: Array.from(el.querySelectorAll("canvas")).map((c) => {
          const gl = c.getContext("webgl2") as WebGL2RenderingContext | null;
          return {
          cls: c.className,
          gl: gl ? ([gl.drawingBufferWidth, gl.drawingBufferHeight] as [number, number]) : undefined,
          cssW: Math.round(c.getBoundingClientRect().width),
          cssH: Math.round(c.getBoundingClientRect().height),
          w: c.width,
          h: c.height,
          };
        }),
        dpr: window.devicePixelRatio,
        viewportY: h.term.buffer.active.viewportY,
        baseY: h.term.buffer.active.baseY,
      });
    }
    return out;
  });
}
