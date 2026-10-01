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
}
