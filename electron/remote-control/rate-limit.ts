/**
 * Per-source backoff for failed remote-control authentication (ADR-161).
 *
 * A 32-byte token is not guessable, so this is not really about brute force —
 * it is about making a knock loud and slow: the counter is what turns "someone
 * is probing the tunnel" from invisible into a log line, and the delay keeps a
 * misconfigured client from spinning.
 *
 * Deliberately in-memory. Persisting it would let an attacker who can reach the
 * listener grow a file on disk, and a restart clearing the backoff costs
 * nothing an attacker could not get by waiting 60s anyway.
 *
 * **The "source" is coarser than it looks.** The listener binds loopback, so
 * every request that arrives through a tunnel has `127.0.0.1` as its peer:
 * behind cloudflared or `tailscale serve` this degenerates to a single bucket
 * shared by every remote caller. That is deliberate, and it is why `server.ts`
 * verifies a token *before* consulting this class — a shared bucket that could
 * reject an authenticated request would let a stranger lock the owner out. It
 * only ever delays requests that already failed to authenticate.
 *
 * `X-Forwarded-For` would give finer buckets and is not used. It is written by
 * the client and merely appended to by the tunnel, so trusting it means picking
 * the right entry from a list an attacker partly controls — real complexity for
 * an attacker who can mint a fresh bucket per request anyway. Granularity is
 * not what makes this safe; the ordering in `server.ts` is.
 */

/** First penalty, doubled per consecutive failure. */
const BASE_DELAY_MS = 1_000;
/** Ceiling — beyond this the delay stops being a deterrent and starts being a bug. */
const MAX_DELAY_MS = 60_000;
/** An address idle this long is forgotten, so the map cannot grow unbounded. */
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

  /**
   * Milliseconds this address must wait, or 0 if it may try now. Callers check
   * this *before* verifying a token so a blocked source costs no crypto.
   */
  retryAfterMs(address: string): number {
    const entry = this.entries.get(address);
    if (!entry) return 0;
    return Math.max(0, entry.blockedUntil - this.now());
  }

  /** Record a rejected token. Returns the delay now in force, for logging. */
  recordFailure(address: string): number {
    const now = this.now();
    const entry = this.entries.get(address) ?? {
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
    this.entries.set(address, entry);
    return delay;
  }

  /** A device authenticated: drop its history so one typo is not sticky. */
  recordSuccess(address: string): void {
    this.entries.delete(address);
  }

  /** Consecutive failures seen from this address, for the log line. */
  failureCount(address: string): number {
    return this.entries.get(address)?.failures ?? 0;
  }

  /** Drop entries no longer blocking and idle past the TTL. */
  sweep(): void {
    const now = this.now();
    for (const [address, entry] of this.entries) {
      if (entry.blockedUntil <= now && now - entry.lastFailureAt > ENTRY_TTL_MS)
        this.entries.delete(address);
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
