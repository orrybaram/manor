// Hero: the whole app window, in the torn frame.
import "./hero.css";
import { mountShell } from "../shell/shell";

const view = document.querySelector<HTMLElement>('[data-shell="hero"]');
if (view) {
  mountShell(view, {
    label:
      "An interactive mock of Manor: a sidebar of workspaces and agents, and four agent panes. Claude is working, Codex asks permission to run a test, opencode is thinking, and Claude reports passing tests.",
  });
}

// The headline's pink and cyan passes slip out of register at random: a
// small jitter every tick, now and then a bigger kick that jolts the line.
// Still under reduced motion, and paused while the hero is off screen.
const headline = document.querySelector<HTMLElement>(".hero .tagline .l1");
if (headline) misprint(headline);

function misprint(el: HTMLElement): void {
  // Resting offsets, as in hero.css.
  const PINK = { x: 0.019, y: 0.019 };
  const CYAN = { x: -0.014, y: -0.01 };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let timer = 0;
  let onScreen = true;

  const jitter = (spread: number) => (Math.random() * 2 - 1) * spread;
  const em = (n: number) => `${n.toFixed(4)}em`;

  const rest = () => {
    el.style.removeProperty("--pk");
    el.style.removeProperty("--cy");
    el.style.removeProperty("translate");
  };

  const tick = () => {
    const kick = Math.random() < 0.08;
    const spread = kick ? 0.016 : 0.004;
    el.style.setProperty("--pk", `${em(PINK.x + jitter(spread))} ${em(PINK.y + jitter(spread))}`);
    el.style.setProperty("--cy", `${em(CYAN.x + jitter(spread))} ${em(CYAN.y + jitter(spread))}`);
    el.style.translate = kick ? `${em(jitter(0.004))} 0` : "";
    // A kick snaps back fast; the jitter wanders at its own pace.
    timer = window.setTimeout(tick, kick ? 50 + Math.random() * 60 : 70 + Math.random() * 160);
  };

  const sync = () => {
    window.clearTimeout(timer);
    if (reducedMotion.matches || !onScreen || document.hidden) rest();
    else tick();
  };

  new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    sync();
  }).observe(el);
  reducedMotion.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
}
