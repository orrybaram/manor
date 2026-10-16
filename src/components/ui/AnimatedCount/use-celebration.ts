import { useCallback, useEffect, useRef, useState } from "react";
import type { CelebrationTier } from "./slot-reels";

/** How long the container stays gold after a jackpot. */
const GOLD_MS = 1800;

type Celebration = { tier: CelebrationTier; beat: number; gold: boolean };

/**
 * Lets the box around one or more celebrating `AnimatedCount`s react too:
 * pass `onCelebrate` to each count and spread `celebrationProps` on the
 * container, then style it by `data-celebrate` (the latest tier),
 * `data-beat` (flips each payout, so CSS can restart its animation by
 * alternating two identical keyframes) and `data-gold` (a recent jackpot).
 */
export function useCelebration() {
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const goldTimer = useRef<number | undefined>(undefined);

  const onCelebrate = useCallback((tier: CelebrationTier) => {
    setCelebration((prev) => ({
      tier,
      beat: (prev?.beat ?? 0) + 1,
      gold: tier === 3 || (prev?.gold ?? false),
    }));
    if (tier === 3) {
      window.clearTimeout(goldTimer.current);
      goldTimer.current = window.setTimeout(
        () => setCelebration((prev) => prev && { ...prev, gold: false }),
        GOLD_MS,
      );
    }
  }, []);

  useEffect(() => () => window.clearTimeout(goldTimer.current), []);

  const celebrationProps = celebration
    ? {
        "data-celebrate": celebration.tier,
        "data-beat": celebration.beat % 2,
        "data-gold": celebration.gold || undefined,
      }
    : {};

  return { onCelebrate, celebrationProps };
}
