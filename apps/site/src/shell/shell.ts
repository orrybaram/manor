/**
 * The Manor app shell, mounted as many times as the page wants. Each mount
 * lays the app out at 1600×1000 and scales it into its box; a crop shows
 * just one region of that layout, zoomed to fill the box.
 */
import "./shell.css";
import { onShellClick, onShellKey, type ShellContext } from "./interactions";
import { renderLivePanes, renderShell } from "./render";
import { createState, type AgentId } from "./state";

const WIDTH = 1600;
const HEIGHT = 1000;
const TICK_MS = 250;

/** A region of the 1600×1000 layout, in its own px. */
export type ShellCrop = { x: number; y: number; width: number; height: number };

export type ShellOptions = {
  /** What a screen reader hears for this mount. */
  label: string;
  /** Show only this region; the whole window when left out. */
  crop?: ShellCrop;
  /** The pane focused at first; null for none. */
  focus?: AgentId | null;
};

export function mountShell(view: HTMLElement, options: ShellOptions): void {
  const crop = options.crop ?? { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const state = createState({ focus: options.focus });

  const root = document.createElement("div");
  root.className = "mapp";
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", options.label);
  view.style.aspectRatio = `${crop.width} / ${crop.height}`;
  view.appendChild(root);

  const render = () => renderShell(root, state);
  render();

  const fit = () => {
    const s = view.clientWidth / crop.width;
    root.style.setProperty("--s", String(s));
    root.style.setProperty("--x", String(-crop.x * s));
    root.style.setProperty("--y", String(-crop.y * s));
  };
  fit();
  new ResizeObserver(fit).observe(view);

  let visible = false;
  const ctx: ShellContext = {
    root,
    state,
    render,
    later: (ms, fn) =>
      void setTimeout(() => {
        fn();
        render();
      }, reduced.matches ? Math.min(ms, 300) : ms),
    onScreen: () => visible,
  };
  root.addEventListener("click", (e) => onShellClick(ctx, e));
  document.addEventListener("keydown", (e) => onShellKey(ctx, e));

  // Ambient ticks (Claude's timer, opencode's moon) run only while this
  // mount is on screen, the tab is showing, and motion is welcome.
  let timer = 0;
  const tick = () => {
    state.tick++;
    const hero = state.agents.hero;
    if (hero.status === "working" && state.tick % 4 === 0) hero.secs++;
    renderLivePanes(root, state);
  };
  const sync = () => {
    const run = visible && !document.hidden && !reduced.matches;
    if (run && !timer) timer = window.setInterval(tick, TICK_MS);
    else if (!run && timer) {
      clearInterval(timer);
      timer = 0;
    }
  };
  new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    sync();
  }).observe(view);
  document.addEventListener("visibilitychange", sync);
  reduced.addEventListener("change", sync);
}
