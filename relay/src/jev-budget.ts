/**
 * The global daily cap on hosted Jev calls (ADR-211 D3): one singleton
 * Durable Object (`idFromName("global")`) counting calls per UTC day.
 *
 * The input gate serialises `take` calls, so the read-check-write below is
 * race-free without a lock. Only today's key is kept; an earlier day's is
 * deleted on the first write after the day rolls.
 */
import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";

const COUNT_KEY_PREFIX = "count:";

/** `count:YYYY-MM-DD`, UTC. */
function countKey(now: number): string {
  return COUNT_KEY_PREFIX + new Date(now).toISOString().slice(0, 10);
}

export class JevBudget extends DurableObject<Env> {
  /** Spend one call from today's budget of `limit`; false once it is spent. */
  async take(limit: number): Promise<boolean> {
    const key = countKey(Date.now());
    const count = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (count >= limit) return false;

    const stored = await this.ctx.storage.list({ prefix: COUNT_KEY_PREFIX });
    const stale = [...stored.keys()].filter((k) => k !== key);
    if (stale.length > 0) await this.ctx.storage.delete(stale);
    await this.ctx.storage.put(key, count + 1);
    return true;
  }
}
