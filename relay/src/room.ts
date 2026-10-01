/**
 * A room (ADR-206 D1): one Durable Object per desktop, holding at most one
 * authenticated host socket and up to `MAX_CHANNELS` viewer sockets.
 *
 * The room is a blind pipe. It reads the 3-byte header it adds and strips on
 * the host side (plus the optional close code on a host `OP_CLOSE`), and
 * never looks at a payload — payloads are Noise
 * ciphertext. Everything the room needs to survive hibernation (who is the
 * host, a pending host's challenge and deadline, each viewer's channel) lives
 * in the socket attachments; the daily byte count and the next channel
 * number live in storage.
 *
 * **Liveness.** Host and viewers send `HEARTBEAT_PING` every
 * `HEARTBEAT_INTERVAL_MS`; the runtime answers it (auto-response, no wake-up)
 * and records when. An alarm sweeps every `staleAfterMs` and closes any live
 * socket that has not pinged within it (`CLOSE_IDLE`) — a half-open phone
 * otherwise holds a channel slot and is streamed to, and a sleeping desktop
 * otherwise looks present to every join. A join that finds its host stale
 * drops it and is refused `CLOSE_NO_HOST`, without waiting for the sweep.
 *
 * **The dev payload log.** The relay e2e (`tests/e2e/relay.spec.ts`) proves
 * the room is blind by reading every payload it forwarded and finding
 * neither the typed marker nor the device token in any of them. So the room
 * can print each forwarded payload, base64, one `console.log` line apiece —
 * a Worker cannot write files; `wrangler dev`'s stdout is the file, and the
 * e2e fixture appends it to one. See `devPayloadLogEnabled` for why this can
 * never be on in production.
 */
import { DurableObject } from "cloudflare:workers";

import {
  base64urlDecode,
  base64urlEncode,
  verifyHostChallenge,
} from "../../src/lib/relay-crypto";
import {
  CLOSE_AUTH_FAILED,
  CLOSE_AUTH_TIMEOUT,
  CLOSE_IDLE,
  CLOSE_LIMIT,
  CLOSE_NORMAL,
  CLOSE_NO_HOST,
  CLOSE_PROTOCOL_ERROR,
  CLOSE_REPLACED,
  CLOSE_TOO_BIG,
  CLOSE_UNSUPPORTED_DATA,
  DEFAULT_DAILY_BYTES,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  HOST_AUTH_TIMEOUT_MS,
  HOST_CHALLENGE_BYTES,
  MAX_CHANNEL,
  MAX_CHANNELS,
  MAX_RELAY_PAYLOAD_BYTES,
  MIN_CHANNEL,
  OP_ACK,
  OP_CLOSE,
  OP_DATA,
  OP_OPEN,
  PASSTHROUGH_CLOSE_CODES,
  RELAY_ACK_BYTES,
  RELAY_CLOSE_WITH_CODE_BYTES,
  RELAY_HEADER_BYTES,
  STALE_AFTER_MS,
} from "../../src/lib/relay-crypto/protocol";
import type { Env } from "./env";

type HostAttachment =
  | {
      role: "host";
      roomId: string;
      state: "pending";
      /** base64url of the challenge this socket must sign. */
      challenge: string;
      /** Epoch ms after which the alarm closes it. */
      deadline: number;
    }
  | {
      role: "host";
      roomId: string;
      state: "live";
      /** Epoch ms it authenticated: its liveness until its first ping. */
      since: number;
    }
  /** Replaced, failed or dropped: its remaining events are ignored. */
  | { role: "host"; roomId: string; state: "gone" };

interface ViewerAttachment {
  role: "viewer";
  ch: number;
  /** False once the room has started closing it. */
  open: boolean;
  /** Epoch ms it joined: its liveness until its first ping. */
  since: number;
}

type Attachment = HostAttachment | ViewerAttachment;

/** Longest host `auth` message accepted; it is ~150 bytes in practice. */
const MAX_AUTH_MESSAGE_CHARS = 1024;

/**
 * The byte count is written to storage once this many uncounted bytes have
 * piled up, when a socket closes, and `BUDGET_FLUSH_DELAY_MS` after any
 * uncounted byte — not on every message. The delayed write is what makes
 * the count survive hibernation: a pending timer keeps the room awake until
 * it has fired, so a room never hibernates holding uncounted bytes.
 */
const BUDGET_FLUSH_BYTES = 64 * 1024;
const BUDGET_FLUSH_DELAY_MS = 1_000;

const BUDGET_KEY_PREFIX = "bytes:";

/** Storage key of the next channel number to hand out. */
const NEXT_CHANNEL_KEY = "next-channel";

/** Socket tag: this socket's forwarded payloads go to the dev payload log. */
const DEV_LOG_TAG = "dev-payload-log";

/** Prefix of a dev payload log line; the e2e fixture greps for it. */
export const DEV_PAYLOAD_LOG_PREFIX = "[relay-dev-payload]";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a socket opened by `request` has its forwarded payloads logged.
 *
 * Two gates, both required, so neither a config slip nor a request alone can
 * turn it on:
 *
 * - **`RELAY_DEV_PAYLOAD_LOG === "1"`.** The deployed `wrangler.toml` never
 *   sets it (and `wrangler deploy` does not read `wrangler dev --var`), so a
 *   deploy has to be edited on purpose to carry it.
 * - **The request was addressed to loopback.** Under `wrangler dev` the
 *   Worker sees the URL the client dialled — `http://127.0.0.1:<port>/…`.
 *   A deployed Worker is reached only through Cloudflare at its own
 *   hostname, so `request.url` can never name loopback there; a client
 *   cannot send one, because Cloudflare routes on the hostname it carries.
 *
 * Decided once per socket and recorded as a tag, which survives hibernation
 * and cannot be changed afterwards.
 */
export function devPayloadLogEnabled(
  env: Pick<Env, "RELAY_DEV_PAYLOAD_LOG">,
  requestUrl: string,
): boolean {
  if (env.RELAY_DEV_PAYLOAD_LOG !== "1") return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(requestUrl).hostname);
  } catch {
    return false;
  }
}
const ROUTE_PATTERN = /^\/(host|join)\/([A-Za-z0-9_-]{22})$/;

function budgetKey(now: number): string {
  return BUDGET_KEY_PREFIX + new Date(now).toISOString().slice(0, 10);
}

function header(op: number, ch: number): Uint8Array {
  return Uint8Array.of(op, (ch >> 8) & 0xff, ch & 0xff);
}

/** `OP_ACK` for a host message of `n` bytes. */
function ack(n: number): Uint8Array {
  const out = new Uint8Array(RELAY_ACK_BYTES);
  out[0] = OP_ACK;
  new DataView(out.buffer).setUint32(3, n, false);
  return out;
}

function attachmentOf(ws: WebSocket): Attachment | null {
  return ws.deserializeAttachment() as Attachment | null;
}

/** Close, tolerating a socket that is already closing or closed. */
function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

function safeSend(ws: WebSocket, data: string | ArrayBufferView): void {
  try {
    ws.send(data);
  } catch {
    // The socket died; its close event cleans up.
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export class Room extends DurableObject<Env> {
  private budgetDay = "";
  private bytesToday = 0;
  private bytesFlushed = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private nextChannel = MIN_CHANNEL;
  private readonly dailyBudget: number;
  private readonly staleAfterMs: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.dailyBudget = positiveInt(env.RELAY_DAILY_BYTES, DEFAULT_DAILY_BYTES);
    this.staleAfterMs = positiveInt(env.RELAY_STALE_MS, STALE_AFTER_MS);
    // Answered by the runtime, even while the room hibernates; the time of
    // each answer is what `lastSeen` reads.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG),
    );
    void ctx.blockConcurrencyWhile(async () => {
      await this.loadBudget();
      const stored = await ctx.storage.get<number>(NEXT_CHANNEL_KEY);
      if (stored !== undefined) this.nextChannel = stored;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const route = ROUTE_PATTERN.exec(new URL(request.url).pathname);
    if (!route) return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const [, kind, roomId] = route;
    const { 0: client, 1: server } = new WebSocketPair();
    const devLog = devPayloadLogEnabled(this.env, request.url);
    if (kind === "host") await this.acceptHost(server, roomId, devLog);
    else await this.acceptViewer(server, devLog);
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- Host ---------------------------------------------------------------

  private async acceptHost(
    ws: WebSocket,
    roomId: string,
    devLog: boolean,
  ): Promise<void> {
    const challenge = base64urlEncode(
      crypto.getRandomValues(new Uint8Array(HOST_CHALLENGE_BYTES)),
    );
    const deadline = Date.now() + HOST_AUTH_TIMEOUT_MS;
    this.ctx.acceptWebSocket(ws, devLog ? ["host", DEV_LOG_TAG] : ["host"]);
    ws.serializeAttachment({
      role: "host",
      roomId,
      state: "pending",
      challenge,
      deadline,
    } satisfies HostAttachment);
    ws.send(JSON.stringify({ t: "challenge", c: challenge }));
    // An alarm, not setTimeout: it fires even if the room hibernates first.
    await this.alarmBy(deadline);
  }

  /** Make sure the alarm fires no later than `at`. */
  private async alarmBy(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  /** The next liveness sweep; scheduled whenever a socket goes live. */
  private scheduleSweep(): Promise<void> {
    return this.alarmBy(Date.now() + this.staleAfterMs);
  }

  /** When `ws` last proved it was there: its last ping, or when it arrived. */
  private lastSeen(ws: WebSocket, since: number): number {
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws);
    return Math.max(since, pinged?.getTime() ?? 0);
  }

  private isStale(ws: WebSocket, since: number, now = Date.now()): boolean {
    return now - this.lastSeen(ws, since) > this.staleAfterMs;
  }

  private liveHost(): WebSocket | null {
    return this.liveHostEntry()?.ws ?? null;
  }

  private liveHostEntry(): {
    ws: WebSocket;
    a: Extract<HostAttachment, { state: "live" }>;
  } | null {
    for (const ws of this.ctx.getWebSockets("host")) {
      const a = attachmentOf(ws);
      if (a?.role === "host" && a.state === "live") return { ws, a };
    }
    return null;
  }

  private markGone(ws: WebSocket, roomId: string): void {
    ws.serializeAttachment({
      role: "host",
      roomId,
      state: "gone",
    } satisfies HostAttachment);
  }

  private async handleAuth(
    ws: WebSocket,
    a: Extract<HostAttachment, { state: "pending" }>,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (Date.now() > a.deadline) {
      this.markGone(ws, a.roomId);
      safeClose(ws, CLOSE_AUTH_TIMEOUT, "auth timeout");
      return;
    }
    if (!this.verifyAuth(a, message)) {
      this.markGone(ws, a.roomId);
      safeClose(ws, CLOSE_AUTH_FAILED, "auth failed");
      return;
    }

    // The laptop that woke up is the live one: replace any previous host.
    // Its viewers' Noise sessions died with it, so they go too.
    const previous = this.liveHost();
    if (previous) {
      this.markGone(previous, a.roomId);
      safeClose(previous, CLOSE_REPLACED, "replaced");
      this.closeAllViewers(CLOSE_NO_HOST, "host replaced");
    }
    ws.serializeAttachment({
      role: "host",
      roomId: a.roomId,
      state: "live",
      since: Date.now(),
    } satisfies HostAttachment);
    ws.send(JSON.stringify({ t: "ok" }));
    await this.scheduleSweep();
  }

  private verifyAuth(
    a: Extract<HostAttachment, { state: "pending" }>,
    message: string | ArrayBuffer,
  ): boolean {
    if (typeof message !== "string") return false;
    if (message.length > MAX_AUTH_MESSAGE_CHARS) return false;
    try {
      const parsed: unknown = JSON.parse(message);
      if (typeof parsed !== "object" || parsed === null) return false;
      const { t, pub, sig } = parsed as Record<string, unknown>;
      if (t !== "auth" || typeof pub !== "string" || typeof sig !== "string") {
        return false;
      }
      // verifyHostChallenge checks both that pub hashes to the room and
      // that sig is its signature over this room's challenge.
      return verifyHostChallenge(
        base64urlDecode(pub),
        a.roomId,
        base64urlDecode(a.challenge),
        base64urlDecode(sig),
      );
    } catch {
      return false;
    }
  }

  private handleHostFrame(
    ws: WebSocket,
    roomId: string,
    message: string | ArrayBuffer,
  ): void {
    if (typeof message === "string") {
      this.dropHost(ws, roomId, CLOSE_UNSUPPORTED_DATA, "binary only");
      return;
    }
    const bytes = new Uint8Array(message);
    if (bytes.length < RELAY_HEADER_BYTES) {
      this.dropHost(ws, roomId, CLOSE_PROTOCOL_ERROR, "short message");
      return;
    }
    const payloadBytes = bytes.length - RELAY_HEADER_BYTES;
    if (payloadBytes > MAX_RELAY_PAYLOAD_BYTES) {
      this.dropHost(ws, roomId, CLOSE_TOO_BIG, "message too big");
      return;
    }
    const op = bytes[0];
    const ch = (bytes[1] << 8) | bytes[2];
    const viewer = this.viewerFor(ch);
    if (op === OP_DATA || op === OP_CLOSE) safeSend(ws, ack(bytes.length));

    if (op === OP_DATA) {
      if (!viewer) {
        // The viewer left before this arrived; tell the host the channel is gone.
        safeSend(ws, header(OP_CLOSE, ch));
        return;
      }
      this.countBytes(payloadBytes);
      const payload = bytes.subarray(RELAY_HEADER_BYTES);
      this.devLog(ws, "host->viewer", ch, payload);
      safeSend(viewer, payload);
    } else if (op === OP_CLOSE) {
      let code = CLOSE_NORMAL;
      if (bytes.length === RELAY_CLOSE_WITH_CODE_BYTES) {
        const sent = (bytes[3] << 8) | bytes[4];
        // Only codes the page knows how to act on; nothing else is passed on.
        if (PASSTHROUGH_CLOSE_CODES.has(sent)) code = sent;
      } else if (bytes.length !== RELAY_HEADER_BYTES) {
        this.dropHost(ws, roomId, CLOSE_PROTOCOL_ERROR, "bad close");
        return;
      }
      if (viewer) this.closeViewer(viewer, code, "closed by host");
    } else {
      this.dropHost(ws, roomId, CLOSE_PROTOCOL_ERROR, "unknown op");
    }
  }

  /** The live host broke protocol or left: it goes, and so do its viewers. */
  private dropHost(
    ws: WebSocket,
    roomId: string,
    code: number,
    reason: string,
  ): void {
    this.markGone(ws, roomId);
    safeClose(ws, code, reason);
    this.closeAllViewers(CLOSE_NO_HOST, "host gone");
  }

  // --- Viewers ------------------------------------------------------------

  private openViewers(): Array<{ ws: WebSocket; ch: number }> {
    const out: Array<{ ws: WebSocket; ch: number }> = [];
    for (const ws of this.ctx.getWebSockets("viewer")) {
      const a = attachmentOf(ws);
      if (a?.role === "viewer" && a.open) out.push({ ws, ch: a.ch });
    }
    return out;
  }

  private viewerFor(ch: number): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(`viewer:${ch}`)) {
      const a = attachmentOf(ws);
      if (a?.role === "viewer" && a.open) return ws;
    }
    return null;
  }

  private async acceptViewer(ws: WebSocket, devLog: boolean): Promise<void> {
    const live = this.liveHostEntry();
    if (!live) return refuse(ws, CLOSE_NO_HOST, "no host");
    if (this.isStale(live.ws, live.a.since)) {
      // A desktop that went to sleep without closing its socket: it is not
      // there, and this viewer should hear so now, not after a handshake
      // timeout.
      this.dropHost(live.ws, live.a.roomId, CLOSE_IDLE, "no heartbeat");
      return refuse(ws, CLOSE_NO_HOST, "no host");
    }
    const open = this.openViewers();
    if (open.length >= MAX_CHANNELS) {
      return refuse(ws, CLOSE_LIMIT, "too many viewers");
    }
    if (this.budgetSpent()) {
      return refuse(ws, CLOSE_LIMIT, "daily byte budget spent");
    }

    const ch = this.allocateChannel(new Set(open.map((v) => v.ch)));
    const tags = ["viewer", `viewer:${ch}`];
    if (devLog) tags.push(DEV_LOG_TAG);
    this.ctx.acceptWebSocket(ws, tags);
    ws.serializeAttachment({
      role: "viewer",
      ch,
      open: true,
      since: Date.now(),
    } satisfies ViewerAttachment);
    safeSend(live.ws, header(OP_OPEN, ch));
    await this.scheduleSweep();
  }

  /**
   * The next channel number in rotation, skipping any still open — see
   * `MIN_CHANNEL`. Never the lowest free one: the host may still have frames
   * in flight for a viewer that has just left, and they must not reach the
   * next viewer on the same number.
   */
  private allocateChannel(used: ReadonlySet<number>): number {
    let ch = this.nextChannel;
    // At most MAX_CHANNELS numbers are in use, so this ends quickly.
    while (used.has(ch)) ch = ch >= MAX_CHANNEL ? MIN_CHANNEL : ch + 1;
    this.nextChannel = ch >= MAX_CHANNEL ? MIN_CHANNEL : ch + 1;
    void this.ctx.storage.put(NEXT_CHANNEL_KEY, this.nextChannel, {
      allowUnconfirmed: true,
    });
    return ch;
  }

  private handleViewerFrame(
    ws: WebSocket,
    ch: number,
    message: string | ArrayBuffer,
  ): void {
    if (typeof message === "string") {
      this.closeViewer(ws, CLOSE_UNSUPPORTED_DATA, "binary only", true);
      return;
    }
    if (message.byteLength > MAX_RELAY_PAYLOAD_BYTES) {
      this.closeViewer(ws, CLOSE_TOO_BIG, "message too big", true);
      return;
    }
    const host = this.liveHost();
    if (!host) {
      this.closeViewer(ws, CLOSE_NO_HOST, "no host");
      return;
    }
    this.countBytes(message.byteLength);
    this.devLog(ws, "viewer->host", ch, new Uint8Array(message));
    const out = new Uint8Array(RELAY_HEADER_BYTES + message.byteLength);
    out.set(header(OP_DATA, ch), 0);
    out.set(new Uint8Array(message), RELAY_HEADER_BYTES);
    safeSend(host, out);
  }

  private closeViewer(
    ws: WebSocket,
    code: number,
    reason: string,
    notifyHost = false,
  ): void {
    const a = attachmentOf(ws);
    if (a?.role !== "viewer") return;
    ws.serializeAttachment({ ...a, open: false } satisfies ViewerAttachment);
    safeClose(ws, code, reason);
    if (notifyHost) this.notifyHostClosed(a.ch);
  }

  private closeAllViewers(code: number, reason: string): void {
    for (const { ws } of this.openViewers()) this.closeViewer(ws, code, reason);
  }

  private notifyHostClosed(ch: number): void {
    const host = this.liveHost();
    if (host) safeSend(host, header(OP_CLOSE, ch));
  }

  /** One dev payload log line, if `from` was opened with the log on. */
  private devLog(
    from: WebSocket,
    direction: "host->viewer" | "viewer->host",
    ch: number,
    payload: Uint8Array,
  ): void {
    if (!this.ctx.getTags(from).includes(DEV_LOG_TAG)) return;
    console.log(
      `${DEV_PAYLOAD_LOG_PREFIX} ${direction} ch=${ch} ${base64urlEncode(payload)}`,
    );
  }

  // --- Hibernation handlers -----------------------------------------------

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const a = attachmentOf(ws);
    if (!a) return;
    if (a.role === "viewer") {
      if (a.open) this.handleViewerFrame(ws, a.ch, message);
    } else if (a.state === "pending") {
      await this.handleAuth(ws, a, message);
    } else if (a.state === "live") {
      this.handleHostFrame(ws, a.roomId, message);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.socketGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.socketGone(ws);
  }

  private socketGone(ws: WebSocket): void {
    const a = attachmentOf(ws);
    if (a?.role === "viewer" && a.open) {
      ws.serializeAttachment({ ...a, open: false } satisfies ViewerAttachment);
      this.notifyHostClosed(a.ch);
    } else if (a?.role === "host" && a.state === "live") {
      this.dropHost(ws, a.roomId, CLOSE_NO_HOST, "host gone");
    }
    this.flushBudget();
  }

  /**
   * Closes host sockets that did not authenticate in time, and live sockets
   * that stopped sending heartbeats. Re-arms itself while anything is live.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | null = null;
    const wake = (at: number) => {
      if (next === null || at < next) next = at;
    };
    for (const ws of this.ctx.getWebSockets("host")) {
      const a = attachmentOf(ws);
      if (a?.role !== "host") continue;
      if (a.state === "pending") {
        if (a.deadline <= now) {
          this.markGone(ws, a.roomId);
          safeClose(ws, CLOSE_AUTH_TIMEOUT, "auth timeout");
        } else {
          wake(a.deadline);
        }
      } else if (a.state === "live") {
        if (this.isStale(ws, a.since, now)) {
          this.dropHost(ws, a.roomId, CLOSE_IDLE, "no heartbeat");
        } else {
          wake(now + this.staleAfterMs);
        }
      }
    }
    for (const ws of this.ctx.getWebSockets("viewer")) {
      const a = attachmentOf(ws);
      if (a?.role !== "viewer" || !a.open) continue;
      if (this.isStale(ws, a.since, now)) {
        this.closeViewer(ws, CLOSE_IDLE, "no heartbeat", true);
      } else {
        wake(now + this.staleAfterMs);
      }
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  // --- Daily byte budget --------------------------------------------------

  private async loadBudget(): Promise<void> {
    const key = budgetKey(Date.now());
    const stored = await this.ctx.storage.list<number>({
      prefix: BUDGET_KEY_PREFIX,
    });
    const stale = [...stored.keys()].filter((k) => k !== key);
    if (stale.length > 0) await this.ctx.storage.delete(stale);
    this.budgetDay = key;
    this.bytesToday = stored.get(key) ?? 0;
    this.bytesFlushed = this.bytesToday;
  }

  /** Starts a fresh count when the UTC day rolls over. */
  private rollBudgetDay(): void {
    const key = budgetKey(Date.now());
    if (key === this.budgetDay) return;
    void this.ctx.storage.delete(this.budgetDay);
    this.budgetDay = key;
    this.bytesToday = 0;
    this.bytesFlushed = 0;
  }

  private countBytes(n: number): void {
    this.rollBudgetDay();
    this.bytesToday += n;
    if (this.bytesToday - this.bytesFlushed >= BUDGET_FLUSH_BYTES) {
      this.flushBudget();
    } else if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushBudget();
      }, BUDGET_FLUSH_DELAY_MS);
    }
  }

  private flushBudget(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.bytesToday === this.bytesFlushed) return;
    // Unconfirmed: the count is advisory, and holding every forwarded
    // message behind the write (the output gate) would stall the pipe.
    void this.ctx.storage.put(this.budgetDay, this.bytesToday, {
      allowUnconfirmed: true,
    });
    this.bytesFlushed = this.bytesToday;
  }

  private budgetSpent(): boolean {
    this.rollBudgetDay();
    return this.bytesToday >= this.dailyBudget;
  }
}

/** Refuse a viewer with a close code (codes need an open socket to ride on). */
function refuse(ws: WebSocket, code: number, reason: string): void {
  ws.accept();
  ws.close(code, reason);
}
