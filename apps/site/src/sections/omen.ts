// The omen: the headline below the fold. Its pink and cyan passes slip out of
// register at random: a small jitter every tick, now and then a bigger kick
// that jolts a line. The first line prints clean and is left out. Still under reduced motion, paused while off screen.
import "./omen.css";

const headline = document.querySelector<HTMLElement>(".omen-h");
if (headline) misprint(headline, [...headline.querySelectorAll<HTMLElement>(".ln:not(:first-child)")]);

function misprint(headline: HTMLElement, els: HTMLElement[]): void {
  // Resting offsets, as in omen.css.
  const PINK = { x: 0.016, y: 0.016 };
  const CYAN = { x: -0.012, y: -0.008 };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let timer = 0;
  let onScreen = false;

  const jitter = (spread: number) => (Math.random() * 2 - 1) * spread;
  const em = (n: number) => `${n.toFixed(4)}em`;

  const rest = () => {
    for (const el of els) {
      el.style.removeProperty("--pk");
      el.style.removeProperty("--cy");
      el.style.removeProperty("translate");
    }
  };

  const tick = () => {
    const kick = Math.random() < 0.08;
    const kicked = kick ? els[Math.floor(Math.random() * els.length)] : null;
    for (const el of els) {
      const spread = el === kicked ? 0.02 : 0.004;
      el.style.setProperty("--pk", `${em(PINK.x + jitter(spread))} ${em(PINK.y + jitter(spread))}`);
      el.style.setProperty("--cy", `${em(CYAN.x + jitter(spread))} ${em(CYAN.y + jitter(spread))}`);
      el.style.translate = el === kicked ? `${em(jitter(0.006))} 0` : "";
    }
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
  }).observe(headline);
  reducedMotion.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
}
