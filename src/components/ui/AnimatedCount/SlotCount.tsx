import { useEffect, useRef, useState, type CSSProperties } from "react";
import styles from "./AnimatedCount.module.css";
import { burstSparks, floatDelta } from "./celebration-layer";
import {
  buildReels,
  celebrationTier,
  type CelebrationTier,
  type Reel,
} from "./slot-reels";

type Spin = {
  id: number;
  from: number;
  to: number;
  tier: CelebrationTier;
  reels: Reel[];
  totalMs: number;
};

/** Only reward a change someone can see, and never against reduced motion. */
function shouldCelebrate() {
  return (
    !document.hidden &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function rootColor(name: string, fallback: string) {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

/** The floating delta and sparks, fired as the reels land. */
function payOut(el: HTMLElement, { from, to, tier }: Spin, prefix: string) {
  const rect = el.getBoundingClientRect();
  const offscreen =
    !rect.width || rect.bottom < 0 || rect.top > window.innerHeight;
  if (offscreen) return;

  const color = getComputedStyle(el).color;
  const delta = to - from;
  if (delta < 0) {
    floatDelta(rect, `−${-delta}`, "loss", "var(--text-dim)");
  } else {
    const sign = prefix === "-" ? "-" : "+";
    floatDelta(
      rect,
      `${sign}${delta}`,
      tier === 3 ? "jackpot" : "gain",
      tier === 3 ? "var(--yellow)" : color,
    );
  }

  if (tier === 2) burstSparks(rect, 12, [color]);
  if (tier === 3) {
    burstSparks(rect, 46, [rootColor("--yellow", "#f9e2af"), color, "#ffffff"]);
  }
}

/**
 * `AnimatedCount`'s `celebrate` mode: each digit is a slot reel, and the
 * payout scales with the change (see `celebrationTier`).
 */
export function SlotCount({
  value,
  prefix = "",
  className,
  onCelebrate,
}: {
  value: number;
  prefix?: string;
  className?: string;
  onCelebrate?: (tier: CelebrationTier) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(value);
  const [spin, setSpin] = useState<Spin | null>(null);

  if (value !== shown) {
    setShown(value);
    const tier = celebrationTier(shown, value);
    setSpin(
      shouldCelebrate()
        ? {
            id: (spin?.id ?? 0) + 1,
            from: shown,
            to: value,
            tier,
            ...buildReels(shown, value, tier),
          }
        : null,
    );
  }

  const onCelebrateRef = useRef(onCelebrate);
  useEffect(() => {
    onCelebrateRef.current = onCelebrate;
  });

  useEffect(() => {
    if (!spin) return;
    const land = () => {
      if (ref.current) payOut(ref.current, spin, prefix);
      onCelebrateRef.current?.(spin.tier);
    };
    // A tick pays out at once; a spin pays out as the last reel lands.
    let landTimer: number | undefined;
    if (spin.tier === 1) land();
    else landTimer = window.setTimeout(land, spin.totalMs);
    // Back to plain text once the reels stop, so the DOM is small at rest.
    const settleTimer = window.setTimeout(() => setSpin(null), spin.totalMs + 80);
    return () => {
      window.clearTimeout(landTimer);
      window.clearTimeout(settleTimer);
    };
  }, [spin, prefix]);

  return (
    <span ref={ref} className={className}>
      {prefix}
      {spin ? (
        <>
          <span
            key={spin.id}
            className={`${styles.reels} ${spin.tier > 1 ? styles.slot : ""}`}
            aria-hidden="true"
          >
            {spin.reels.map((reel, i) => (
              <span key={i} className={styles.reel}>
                {reel.durationMs === 0 ? (
                  reel.cells[0]
                ) : (
                  <span
                    className={styles.strip}
                    style={
                      {
                        "--reel-from": reel.from,
                        "--reel-to": reel.to,
                        "--reel-ms": `${reel.durationMs}ms`,
                      } as CSSProperties
                    }
                  >
                    {reel.cells.map((cell, j) => (
                      <span key={j}>{cell}</span>
                    ))}
                  </span>
                )}
              </span>
            ))}
          </span>
          <span className={styles.srOnly}>{shown}</span>
        </>
      ) : (
        shown
      )}
    </span>
  );
}
