/**
 * Per-source backoff for failed remote-control authentication (ADR-161,
 * ADR-207 D3).
 *
 * A 32-byte token is not guessable, so this is not really about brute force —
 * it is about making a knock loud and slow: the counter is what turns "someone
 * is probing the relay" from invisible into a log line, and the delay keeps a
 * misconfigured browser from spinning.
 *
 * Deliberately in-memory. Persisting it would let anyone who can reach the
 * relay grow a file on disk, and a restart clearing the backoff costs nothing
 * an attacker could not get by waiting 60s anyway.
 *
 * **The "source" is coarse on purpose.** The relay's hello gate keys every
 * viewer under one `relay` source: the relay hides who a viewer is, so there
 * is nothing finer to key on. That is why `relay-gate.ts` verifies a token
 * *before* consulting this class — a shared bucket that could reject an
 * authenticated hello would let a stranger lock the owner out. It only ever
 * delays hellos that already failed to authenticate.
 */

/** First penalty, doubled per consecutive failure. */
const BASE_DELAY_MS = 1_000;
/** Ceiling — beyond this the delay stops being a deterrent and starts being a bug. */
const MAX_DELAY_MS = 60_000;
/** A source idle this long is forgotten, so the map cannot grow unbounded. */
const ENTRY_TTL_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

interface Entry {
  failures: number;
  blockedUntil: number;
  lastFailureAt: number;
}

export class AuthRateLimiter {
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Milliseconds this source must wait, or 0 if it may try now. */
  retryAfterMs(source: string): number {
    const entry = this.entries.get(source);
    if (!entry) return 0;
    return Math.max(0, entry.blockedUntil - this.now());
  }

  /** Record a rejected token. Returns the delay now in force, for logging. */
  recordFailure(source: string): number {
    const now = this.now();
    const entry = this.entries.get(source) ?? {
      failures: 0,
      blockedUntil: 0,
      lastFailureAt: now,
    };
    entry.failures += 1;
    entry.lastFailureAt = now;
    const delay = Math.min(
      MAX_DELAY_MS,
      BASE_DELAY_MS * 2 ** (entry.failures - 1),
    );
    entry.blockedUntil = now + delay;
    this.entries.set(source, entry);
    return delay;
  }

  /** A device authenticated: drop its history so one typo is not sticky. */
  recordSuccess(source: string): void {
    this.entries.delete(source);
  }

  /** Consecutive failures seen from this source, for the log line. */
  failureCount(source: string): number {
    return this.entries.get(source)?.failures ?? 0;
  }

  /** Drop entries no longer blocking and idle past the TTL. */
  sweep(): void {
    const now = this.now();
    for (const [source, entry] of this.entries) {
      if (entry.blockedUntil <= now && now - entry.lastFailureAt > ENTRY_TTL_MS)
        this.entries.delete(source);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Begin sweeping. Unref'd — this must never hold the process open. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
