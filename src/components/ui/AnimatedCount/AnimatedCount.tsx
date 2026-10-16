import { useEffect, useRef, useState } from "react";
import { SlotCount } from "./SlotCount";
import type { CelebrationTier } from "./slot-reels";

const DURATION = 300;

type AnimatedCountProps = {
  value: number;
  prefix?: string;
  /** Renders each animated frame's value; defaults to the bare integer. Ignored with `celebrate`. */
  format?: (n: number) => string;
  className?: string;
  /**
   * Spin the digits like slot reels and pay out with a floating delta,
   * sparks and, for a big gain, a jackpot. For counts that reward work,
   * like the sidebar's diff badge.
   */
  celebrate?: boolean;
  /** With `celebrate`: called as each change pays out. See `useCelebration`. */
  onCelebrate?: (tier: CelebrationTier) => void;
};

export function AnimatedCount({ celebrate, onCelebrate, format, ...rest }: AnimatedCountProps) {
  return celebrate ? (
    <SlotCount {...rest} onCelebrate={onCelebrate} />
  ) : (
    <TickingCount {...rest} format={format} />
  );
}

function TickingCount({
  value,
  prefix,
  format,
  className,
}: Omit<AnimatedCountProps, "celebrate" | "onCelebrate">) {
  const [display, setDisplay] = useState(value);
  const prevValue = useRef(value);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const from = prevValue.current;
    const to = value;
    prevValue.current = value;

    if (from === to) return;

    const start = performance.now();
    const delta = to - from;

    const tick = (now: number) => {
      const t = Math.min((now - start) / DURATION, 1);
      // ease-out quad
      const eased = 1 - (1 - t) * (1 - t);
      setDisplay(Math.round(from + delta * eased));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value]);

  return (
    <span className={className}>
      {prefix}
      {format ? format(display) : display}
    </span>
  );
}
