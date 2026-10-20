/**
 * The maths behind `AnimatedCount`'s `celebrate` mode: how loud a change
 * is, and the digit strips each reel scrolls through to show it.
 */

export type CelebrationTier = 1 | 2 | 3;

/** Below this many lines a change only ticks. */
const SPIN_AT = 40;
/** At this many lines a gain hits the jackpot. */
const JACKPOT_AT = 400;

/**
 * Small changes tick, medium ones spin, a big gain hits the jackpot. A
 * shrinking count never pays out the jackpot: at most it spins.
 */
export function celebrationTier(from: number, to: number): CelebrationTier {
  const delta = Math.abs(to - from);
  if (delta < SPIN_AT) return 1;
  if (delta < JACKPOT_AT || to < from) return 2;
  return 3;
}

/**
 * One digit column. `cells` stack top to bottom, each one line tall; the
 * strip animates its offset from `from` to `to` lines (both ≤ 0). A reel
 * with `durationMs` 0 holds still on `cells[0]`.
 */
export type Reel = {
  cells: string[];
  from: number;
  to: number;
  durationMs: number;
};

type Timing = {
  /** Extra full turns reel `i` (left to right) makes before landing. */
  spins: (i: number) => number;
  /** Spin digits that don't change, too. */
  spinAll: boolean;
  durationMs: number;
  /** Each reel lands this much after the one to its left. */
  staggerMs: number;
};

const TIMING: Record<CelebrationTier, Timing> = {
  1: { spins: () => 0, spinAll: false, durationMs: 380, staggerMs: 0 },
  2: { spins: () => 1, spinAll: false, durationMs: 480, staggerMs: 60 },
  3: { spins: (i) => 2 + i, spinAll: true, durationMs: 700, staggerMs: 130 },
};

/** Holds a reel's place when the number gains or loses a digit. */
export const BLANK = " ";

const mod10 = (n: number) => ((n % 10) + 10) % 10;

export function buildReels(
  from: number,
  to: number,
  tier: CelebrationTier,
): { reels: Reel[]; totalMs: number } {
  const timing = TIMING[tier];
  const fs = String(from);
  const ts = String(to);
  const len = Math.max(fs.length, ts.length);
  const fp = fs.padStart(len, " ");
  const tp = ts.padStart(len, " ");
  const down = to < from;

  const reels: Reel[] = [];
  let totalMs = 0;
  for (let i = 0; i < len; i++) {
    const fd = fp[i];
    const td = tp[i];
    const a = fd === " " ? 0 : Number(fd);
    const b = td === " " ? 0 : Number(td);
    const turns = fd !== td || timing.spinAll ? timing.spins(i) : 0;
    const steps = mod10(down ? a - b : b - a) + 10 * turns;
    if (steps === 0) {
      reels.push({ cells: [td === " " ? BLANK : td], from: 0, to: 0, durationMs: 0 });
      continue;
    }

    const digits = Array.from({ length: steps + 1 }, (_, s) =>
      String(mod10(down ? a - s : a + s)),
    );
    if (fd === " ") digits[0] = BLANK;
    if (td === " ") digits[steps] = BLANK;

    // A spare cell past the target, so the landing overshoot never shows
    // an empty gap.
    const durationMs = timing.durationMs + i * timing.staggerMs;
    totalMs = Math.max(totalMs, durationMs);
    reels.push(
      down
        ? {
            cells: [String(mod10(b - 1)), ...digits.reverse()],
            from: -(steps + 1),
            to: -1,
            durationMs,
          }
        : {
            cells: [...digits, String(mod10(b + 1))],
            from: 0,
            to: -steps,
            durationMs,
          },
    );
  }
  return { reels, totalMs };
}
