import type { JevBudget } from "./jev-budget";
import type { Room } from "./room";

/** Bindings from `wrangler.toml`. */
export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  JOIN_LIMITER: RateLimit;
  /** Per-version web app builds, keyed `app/<version>/<path>` (D4). */
  WEB: R2Bucket;
  /** Per-room byte budget per UTC day; decimal string. */
  RELAY_DAILY_BYTES?: string;
  /**
   * Test seam: ms without a heartbeat before a socket is reaped. Unset in
   * `wrangler.toml`; defaults to `STALE_AFTER_MS`.
   */
  RELAY_STALE_MS?: string;
  /**
   * Dev only: `"1"` makes the room log every payload it forwards, for the
   * relay e2e's blindness check (`devPayloadLogEnabled` in `room.ts`).
   * Never set in `wrangler.toml`; only `wrangler dev --var` sets it.
   */
  RELAY_DEV_PAYLOAD_LOG?: string;
  /** `/jev/folder` calls per client IP, keyed `jevip:<ip>` (ADR-211 D3). */
  JEV_LIMITER: RateLimit;
  /** `/jev/folder` calls per relay identity, keyed `jevid:<roomId>`. */
  JEV_ID_LIMITER: RateLimit;
  /** The singleton global daily Jev budget (`idFromName("global")`). */
  JEV_BUDGET: DurableObjectNamespace<JevBudget>;
  /** Jev calls allowed per UTC day, all users together; decimal string. */
  JEV_DAILY_CALLS?: string;
  /**
   * Manor's TypeSafe key, a wrangler secret (`wrangler secret put
   * TYPESAFE_API_KEY`). Never in `wrangler.toml`; unset, `/jev/folder` is 503.
   */
  TYPESAFE_API_KEY?: string;
  /** Test seam: the TypeSafe API origin. Defaults to `https://api.typesafe.ai`. */
  JEV_UPSTREAM_URL?: string;
}
