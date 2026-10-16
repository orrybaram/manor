import styles from "./AnimatedCount.module.css";

/**
 * Effects that escape the number's box: a floating delta and a spark
 * burst. They draw over the whole window, outside React, because the
 * sidebar badge sits in a row that clips its overflow.
 */

export type FloatVariant = "gain" | "loss" | "jackpot";

/** Floats `text` up off `anchor` (or lets a loss drop away), then removes it. */
export function floatDelta(
  anchor: DOMRect,
  text: string,
  variant: FloatVariant,
  color: string,
) {
  const el = document.createElement("span");
  el.className = `${styles.floater} ${styles[variant]}`;
  el.textContent = text;
  el.style.left = `${anchor.left + anchor.width / 2}px`;
  el.style.top = `${variant === "loss" ? anchor.bottom : anchor.top - anchor.height * 0.4}px`;
  el.style.fontSize = `${anchor.height * (variant === "jackpot" ? 1.3 : 0.95)}px`;
  el.style.color = color;
  el.addEventListener("animationend", () => el.remove());
  document.body.append(el);
}

type Spark = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  decay: number;
  size: number;
  spin: number;
  color: string;
};

let canvas: HTMLCanvasElement | null = null;
let sparks: Spark[] = [];

/** Sprays `count` sparks up out of `anchor`; they fall away under gravity. */
export function burstSparks(anchor: DOMRect, count: number, colors: string[]) {
  // Scale to the text: the sidebar's 10px badge gets small sparks.
  const scale = Math.max(0.8, anchor.height / 12);
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.6;
    const speed = (1.5 + Math.random() * 3) * scale;
    sparks.push({
      x: anchor.left + anchor.width / 2 + (Math.random() - 0.5) * anchor.width * 0.6,
      y: anchor.top + anchor.height / 2,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1,
      decay: 0.016 + Math.random() * 0.02,
      size: (1 + Math.random() * 1.6) * scale,
      spin: Math.random() * 6,
      color: colors[i % colors.length],
    });
  }
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = styles.sparks;
    canvas.setAttribute("aria-hidden", "true");
    document.body.append(canvas);
    requestAnimationFrame(draw);
  }
}

function draw() {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  sparks = sparks.filter((s) => s.life > 0);
  for (const s of sparks) {
    s.x += s.vx;
    s.y += s.vy;
    s.vy += 0.12;
    s.vx *= 0.985;
    s.life -= s.decay;
    s.spin += 0.2;
    g.globalAlpha = Math.max(0, s.life);
    g.fillStyle = s.color;
    g.save();
    g.translate(s.x, s.y);
    g.rotate(s.spin);
    g.fillRect(-s.size / 2, -s.size / 4, s.size, s.size / 2);
    g.restore();
  }

  // Nothing left in flight: take the canvas down so idle costs nothing.
  if (sparks.length) requestAnimationFrame(draw);
  else {
    canvas.remove();
    canvas = null;
  }
}
