/**
 * The relay's wire protocol (ADR-206 D1): ops, limits and close codes.
 *
 * Imported by both sides of the room — the Worker in `relay/` and the desktop
 * connector in Electron main — so the numbers cannot drift. Constants only,
 * no imports: the Worker bundles this file by direct path.
 *
 * Host-side binary messages are `[op, ch_hi, ch_lo, ...payload]`. Viewer-side
 * messages are the bare payload; the room adds or strips the header and never
 * looks inside the payload (it is Noise ciphertext).
 */

/** Room → host: a viewer joined on this channel. No payload. */
export const OP_OPEN = 0x01;
/** Either direction on the host socket: payload for/from this channel. */
export const OP_DATA = 0x02;
/**
 * Either direction on the host socket: this channel is gone. From the host
 * it may carry a 2-byte big-endian close code after the channel
 * (`RELAY_CLOSE_WITH_CODE_BYTES` in all); the room hands it to the viewer
 * only if it is in `PASSTHROUGH_CLOSE_CODES`, else the viewer sees 1000.
 * From the room it is always the bare header.
 */
export const OP_CLOSE = 0x03;

/**
 * Room → host, after every binary message the room has taken from the host:
 * `[OP_ACK, 0, 0, n_3, n_2, n_1, n_0]`, `n` the full length of that message
 * (header included), big-endian. The host's flow control (`connector.ts`)
 * keeps at most a window of unacknowledged bytes on the socket, so its
 * backlog stays in per-channel queues it can schedule fairly, not in kernel
 * buffers it cannot see.
 */
export const OP_ACK = 0x04;
/** Length of an `OP_ACK`. */
export const RELAY_ACK_BYTES = 7;

/** Bytes of `[op, ch_hi, ch_lo]` in front of every host-side message. */
export const RELAY_HEADER_BYTES = 3;

/** Length of a host `OP_CLOSE` that carries a close code. */
export const RELAY_CLOSE_WITH_CODE_BYTES = RELAY_HEADER_BYTES + 2;

/**
 * Channels are 1..65535; 0 is never assigned. The room hands them out in
 * rotation (the next number after the last one it gave, skipping any still
 * open), not lowest-free: a number comes round again only after 65 535 more
 * joins, so a frame the host sent to a viewer that just left can never land
 * on the next viewer.
 */
export const MIN_CHANNEL = 1;
export const MAX_CHANNEL = 0xffff;

/**
 * Heartbeat (both host and viewer sockets). Either side sends the text
 * message `HEARTBEAT_PING`; the room answers `HEARTBEAT_PONG` itself, via
 * the Durable Object auto-response, without waking. The room uses the time
 * of each socket's last ping to reap sockets that have gone quiet (a sleeping
 * laptop, a phone that lost signal): `STALE_AFTER_MS` without one and the
 * socket is closed with `CLOSE_IDLE`, and a join finding its host stale is
 * refused with `CLOSE_NO_HOST`. The clients treat a missing pong as the
 * line being dead.
 */
export const HEARTBEAT_PING = "ping";
export const HEARTBEAT_PONG = "pong";
/** How often a client pings. */
export const HEARTBEAT_INTERVAL_MS = 20_000;
/**
 * A socket that has not pinged for this long is dead to the room. Generous
 * because a hidden browser tab's timers may be throttled to once a minute.
 */
export const STALE_AFTER_MS = 90_000;

/** Viewer sockets a room holds open at once. */
export const MAX_CHANNELS = 8;

/** Largest payload in one message, either direction (the bridge's frame cap). */
export const MAX_RELAY_PAYLOAD_BYTES = 1024 * 1024;

/** Per-room byte budget per UTC day, both directions, unless overridden. */
export const DEFAULT_DAILY_BYTES = 2 * 1024 * 1024 * 1024;

/** An unauthenticated host socket is closed after this long. */
export const HOST_AUTH_TIMEOUT_MS = 5_000;

/** Random bytes in the room's host challenge. */
export const HOST_CHALLENGE_BYTES = 32;

/** Normal close: the host closed this channel. */
export const CLOSE_NORMAL = 1000;
/** Malformed host-side message (short header, unknown op). */
export const CLOSE_PROTOCOL_ERROR = 1002;
/** Text where binary was required. */
export const CLOSE_UNSUPPORTED_DATA = 1003;
/** Message larger than `MAX_RELAY_PAYLOAD_BYTES`. */
export const CLOSE_TOO_BIG = 1009;
/** Host auth failed: bad message, wrong key for the room, bad signature. */
export const CLOSE_AUTH_FAILED = 4401;
/** Host did not authenticate within `HOST_AUTH_TIMEOUT_MS`. */
export const CLOSE_AUTH_TIMEOUT = 4408;
/** Viewer: no authenticated host (or the host went away). */
export const CLOSE_NO_HOST = 4404;
/** Host: a newer host authenticated for this room. */
export const CLOSE_REPLACED = 4409;
/** Host or viewer: no heartbeat for `STALE_AFTER_MS`. */
export const CLOSE_IDLE = 4410;
/** Viewer: channel cap reached or the daily byte budget is spent. */
export const CLOSE_LIMIT = 4429;

/**
 * Bridge close codes a host may pass through `OP_CLOSE` to its viewer: 4401
 * (no hello, bad or revoked token), which the page treats as "forget
 * credentials", and 4403 — reserved, not sent. 4403 meant "capability below
 * `full`" until ADR-207 D4 removed the tiers; it stays listed (and stays
 * `CLOSE_FORBIDDEN` in `electron/bridge/types.ts`) so the code is never
 * reused for something an older page would misread. Anything else reaches
 * the viewer as `CLOSE_NORMAL`.
 */
export const PASSTHROUGH_CLOSE_CODES: ReadonlySet<number> = new Set([
  4401, 4403,
]);
