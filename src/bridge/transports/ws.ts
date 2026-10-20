/**
 * The browser's transport: one socket to the host.
 *
 * Everything that is *about the socket* and nothing that is about
 * `ns.method`: the connect, the hello, the JSON framing, the pending map, the
 * outbox, the live-subscription registry, the reconnect with its capped
 * backoff, and the two close codes that mean "stop dialling". The proxy above
 * it (`../client.ts`) is the same code the desktop runs.
 *
 * **The socket itself is a `Pipe`**: "open something, send
 * text, receive text, learn the close code". The page is served only by the
 * relay origin, so the pipe is `./relay-pipe.ts`, which runs the
 * Noise handshake under those four callbacks; the tests hand in fakes.
 * Everything above the pipe knows nothing about the carrier.
 *
 * The frame shapes and the close codes come from
 * `electron/bridge/types.ts` — the host's own definition of the protocol,
 * imported rather than mirrored, which is what makes "one protocol, two
 * transports" a fact and not a convention. That file imports nothing, so
 * taking it into a browser bundle costs the bundle nothing.
 *
 * Opened on first use rather than on construction: `web-main.tsx` installs the
 * bridge before it renders anything, and a socket opened there would race the
 * first paint for no reason. Everything before `hello` is answered is queued,
 * not dropped.
 */

import {
  CLOSE_UNAUTHORIZED,
  PING_METHOD,
  PING_NS,
  type ClientFrame,
  type EventFrame,
  type HelloReplyFrame,
  type ResultFrame,
} from "../../../electron/bridge/types";
import { settleResult } from "../../../electron/bridge/settle";
import {
  BridgeDisconnectedError,
  type BridgeListener,
  type BridgeTransport,
} from "../client";
import { SubscriptionRegistry } from "../subscription-registry";
import { LOCALLY_SERVED } from "../unavailable";

/**
 * What a `Pipe` tells the transport. Each connection calls `onClose` exactly
 * once, and nothing after it.
 */
export interface PipeHandlers {
  /** Ready to carry text frames: the transport says hello now. */
  onOpen(): void;
  onMessage(text: string): void;
  onClose(code: number): void;
}

/** One connection a `Pipe` opened. */
export interface PipeConnection {
  /** True between `onOpen` and `onClose`. */
  readonly open: boolean;
  /** One text frame. May throw on a dying connection; the caller catches. */
  send(text: string): void;
  /**
   * Is the far end still answering? Resolves true on any sign of life
   * within `timeoutMs`, false otherwise.
   */
  probe(timeoutMs: number): Promise<boolean>;
  /**
   * Give up on this connection: report it through `onClose` exactly once,
   * before returning, with one of the pipe's `unreachableCodes`.
   */
  close(): void;
}

/** Something that can open connections carrying the bridge's text frames. */
export interface Pipe {
  connect(handlers: PipeHandlers): PipeConnection;
  /**
   * Close codes that mean "the host is not there right now" rather than "the
   * line dropped": still retried with backoff, but also surfaced, so the page
   * can say so instead of looking frozen.
   */
  readonly unreachableCodes?: ReadonlySet<number>;
}

/**
 * A pipe's verdict that the far end does not hold the key this page was
 * paired with (`relay-pipe.ts`: several bad Noise message 2s in a row). Never
 * on the wire. Unlike 4401 it is not proof the credentials are dead — so the
 * transport stops dialling and asks to re-pair, but does not forget them.
 */
export const CLOSE_KEY_MISMATCH = 4502;

/** First reconnect delay, and the ceiling it doubles towards. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * How long a drop with no listed close code is tolerated before the server is
 * called unreachable. Long enough that a one-second blip does not
 * flash the reachability overlay or bounce pane listeners home and back.
 */
export const DROP_GRACE_MS = 4_000;

/**
 * How long a foreground check waits for the far end before calling an
 * open-looking socket dead. iOS kills a backgrounded socket
 * without a close event; this finds out in seconds, not a heartbeat or two.
 */
export const PROBE_TIMEOUT_MS = 2_000;

/**
 * How long the far server may say nothing before the transport asks it
 * something. A relay answers the pipe's heartbeat itself, so an
 * open line proves only the leg to the relay; a frozen desktop behind it
 * looks alive for as long as the relay keeps its socket (about 90 s).
 *
 * Only silence costs a ping: a line carrying anything never sends one. Idle,
 * that is one ping and one answer per 10 s: 8,640 round trips of about 175
 * bytes sealed, about 1.5 MB a day per viewer, under 0.1% of a room's daily
 * byte budget (`DEFAULT_DAILY_BYTES`, 2 GiB).
 */
export const SERVER_SILENCE_MS = 10_000;

/**
 * How long, after a `bridge.ping`, a frame of any kind may take to arrive
 * before the line is called dead and redialled, as a failed probe is. So a
 * silent server reads unreachable about 15 s after it went quiet.
 */
export const SERVER_SILENCE_TIMEOUT_MS = 5_000;

/** Plain, non-function root members of `ElectronAPI`, answered from here. */
const ROOT_VALUES: Record<string, unknown> = {
  /**
   * A browser never claims a tab: it sees them all, and so it is
   * never a detached window either.
   */
  claim: null,
  /** The preload reads this off its own launch argv. A page has no argv. */
  env: { isPackaged: false },
};

export interface WsTransportOptions {
  /**
   * The paired device's token. `null` installs a bridge that never dials —
   * unless `preAuthenticated`, which needs none.
   */
  token: string | null;
  /**
   * A pairing ticket to redeem `token` with: `token` is one this
   * browser chose, which the host does not know yet. Sent alongside it in
   * every hello until one is accepted, never after — not on a reconnect. Null
   * or absent for a token the host already holds.
   */
  ticket?: string | null;
  /**
   * The far end of the pipe has already said the hello (a
   * desktop window's `server-bridge --viewer` stream, `./host-pipe.ts`).
   * The transport sends none, and takes the first `hello` reply frame that
   * arrives as the handshake; `onHello` hears the same facts as on the web.
   * `token` is not read.
   */
  preAuthenticated?: boolean;
  /** What carries the frames. Never connected while there is nothing to dial with. */
  pipe: Pipe;
  /**
   * Close 4401: the token is dead. Default logs; `install-web.ts` forgets
   * the pairing and `web-main` renders the pairing screen.
   */
  onUnauthorized?: () => void;
  /**
   * `CLOSE_KEY_MISMATCH`: stop dialling and offer to re-pair, keeping the
   * stored pairing. Without it the transport does not stop: it reports
   * `unreachable` and keeps retrying, because wiping credentials on a
   * verdict that is not certain is worse than retrying.
   */
  onKeyMismatch?: () => void;
  /** Every accepted hello, with whatever the host said about itself. */
  onHello?: (reply: HelloReply) => void;
  /**
   * Reachability, for the page: `unreachable` on a close the pipe lists in
   * `unreachableCodes` (the dial is still retried), `connected` on every
   * accepted hello.
   */
  onStatus?: (status: "connected" | "unreachable") => void;
}

/** The parts of the host's `HelloReplyFrame` a page acts on. */
export interface HelloReply {
  rendererId: string | null;
  /** The desktop's version, or null from an older host. */
  appVersion: string | null;
  /** The host's own name for itself, or null. */
  hostName: string | null;
  /** True when a host server answered, not the desktop. */
  hostServer: boolean;
  /**
   * This hello resumed an earlier connection (it carried `previousId`): a
   * reconnect, after which pushes may have been missed. False on the first.
   */
  resumed: boolean;
}

/**
 * `probeNow`'s verdict: the line answered; a fresh dial is (or already was)
 * on its way — whose hello is the moment to re-fetch; or the transport has
 * stopped (no token, or the host refused it) and will not dial again.
 */
export type ProbeOutcome = "alive" | "redialing" | "stopped";

/** `BridgeTransport`, plus what the page's reconnect triggers need. */
export interface WsBridgeTransport extends BridgeTransport {
  /**
   * The page came back (foreground, `pageshow`, `online`, "try again"): dial
   * now if a dial is pending or there is no socket, and probe one that looks
   * open, redialing at once if it does not answer.
   */
  probeNow(): Promise<ProbeOutcome>;
  /**
   * Stop for good: close the socket, fail what is in flight and dial no more.
   * For a server that leaves the page's set (a host removed).
   */
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function defaultUnauthorized(): void {
  console.error("[ws-bridge] the host refused this device's token");
}

/** The socket, the pending calls and the live subscriptions. */
class WsTransport implements WsBridgeTransport {
  private readonly pipe: Pipe;
  private socket: PipeConnection | null = null;
  /** Bumped per dial; a pipe callback from an older dial is ignored. */
  private generation = 0;
  private ready = false;
  /**
   * What the host calls this socket, from the hello reply.
   *
   * Null until the first hello, and a *different* value after a reconnect —
   * which is correct: it names a connection, and a layout command's origin is
   * the connection that sent it. A hint addressed to the previous id simply
   * does not apply, and the reconcile that runs on every broadcast leaves the
   * tab looking where it was looking.
   */
  rendererId: string | null = null;
  /** Set by a 4401: this token will not work, so stop dialling. */
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending "call it unreachable" after a drop with no listed code. */
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The ticket the hello still carries (`WsTransportOptions.ticket`): dropped
   * on the first accepted hello, after which the host knows the token.
   */
  private ticket: string | null;
  /** Whether the hello in flight carried `previousId`. */
  private resuming = false;
  /** The probe in flight, so a burst of foreground events sends only one. */
  private probing: Promise<ProbeOutcome> | null = null;
  /** When the far server last sent a frame, by `Date.now()`. */
  private lastHeard = 0;
  /** The next look at how long the far server has been quiet. */
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Each waits for the next frame from the far server (`heardFromServer`). */
  private readonly heardWaiters = new Set<(heard: boolean) => void>();
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  /** Invoke frames raised before the socket was ready. */
  private readonly outbox: string[] = [];
  /**
   * Every live listener. The source of truth for what the host should be
   * sending: a subscribe frame is a copy of it that the host happens to hold,
   * and on reconnect the registry is replayed.
   */
  private readonly registry = new SubscriptionRegistry(
    (frame) => this.send(frame),
    "ws-bridge",
  );

  readonly platform = "web" as const;
  readonly rootValues = ROOT_VALUES;
  /** A browser has no preload: nothing is served in process by a namespace. */
  readonly localNamespaces: Record<string, unknown> = {};
  readonly locallyServed = LOCALLY_SERVED;

  constructor(private readonly options: WsTransportOptions) {
    this.pipe = options.pipe;
    this.ticket = options.ticket ?? null;
  }

  /** A token to say hello with, or a pipe whose far end said it. */
  private get canDial(): boolean {
    return this.options.preAuthenticated === true || this.options.token !== null;
  }

  probeNow(): Promise<ProbeOutcome> {
    if (this.stopped || !this.canDial) {
      return Promise.resolve("stopped");
    }
    if (this.reconnectTimer) {
      this.redialNow();
      return Promise.resolve("redialing");
    }
    if (!this.socket) {
      this.open();
      return Promise.resolve("redialing");
    }
    // Mid-handshake: a dial is already on its way to a hello.
    if (!this.ready) return Promise.resolve("redialing");
    this.probing ??= this.probe(this.socket);
    return this.probing;
  }

  /**
   * Probe the current socket. A socket that does not answer, and is still
   * the current one, is closed and redialled at once.
   *
   * Alive takes both the pipe's own check and a frame from the far server:
   * over the relay the first proves only the leg to the
   * relay, which answers it whether or not the desktop behind it is there.
   */
  private async probe(socket: PipeConnection): Promise<ProbeOutcome> {
    const generation = this.generation;
    const current = (): boolean =>
      this.generation === generation && this.socket === socket;
    try {
      // Both asked at once, within the one `PROBE_TIMEOUT_MS`.
      const server = this.heardFromServer(PROBE_TIMEOUT_MS);
      let alive: boolean;
      try {
        alive = await socket.probe(PROBE_TIMEOUT_MS);
      } catch {
        alive = false;
      }
      if (alive) alive = await server;
      if (!current()) return "redialing";
      if (alive) return "alive";
      this.giveUp(socket);
      return "redialing";
    } finally {
      this.probing = null;
    }
  }

  /**
   * The current line does not answer: report it through `onClose` like any
   * drop — teardown, and an unreachable code the page shows until the
   * redial's hello — and dial again now, skipping the backoff timer.
   */
  private giveUp(socket: PipeConnection): void {
    socket.close();
    this.redialNow();
  }

  /**
   * Ask the far server something it must answer, and resolve true on the
   * next frame of any kind from it within `timeoutMs`: the answer, an older
   * server's error frame for a method it does not have, or anything else it
   * happened to send. False on a timeout, or if the line closes first.
   */
  private heardFromServer(timeoutMs: number): Promise<boolean> {
    if (!this.ready) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const done = (heard: boolean): void => {
        clearTimeout(timer);
        this.heardWaiters.delete(done);
        resolve(heard);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.heardWaiters.add(done);
      // Not in `pending`: its answer matters only as a frame that arrived.
      this.send({
        id: String(this.nextId++),
        kind: "invoke",
        ns: PING_NS,
        method: PING_METHOD,
        args: [],
      });
    });
  }

  /** Look again at the far server's silence in `delayMs`. */
  private armSilence(delayMs: number): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      void this.checkSilence();
    }, delayMs);
  }

  /**
   * Quiet for `SERVER_SILENCE_MS`: ping, and give the line up if nothing
   * comes back within `SERVER_SILENCE_TIMEOUT_MS`. The redial's
   * hello then decides; a frozen desktop gives none, and the first-hello
   * deadline and the backoff take it from there.
   */
  private async checkSilence(): Promise<void> {
    const socket = this.socket;
    if (!this.ready || !socket) return;
    const quiet = Date.now() - this.lastHeard;
    if (quiet < SERVER_SILENCE_MS) {
      this.armSilence(SERVER_SILENCE_MS - quiet);
      return;
    }
    const generation = this.generation;
    const heard = await this.heardFromServer(SERVER_SILENCE_TIMEOUT_MS);
    if (this.generation !== generation || this.socket !== socket) return;
    if (!heard) {
      this.giveUp(socket);
      return;
    }
    this.armSilence(
      Math.max(0, SERVER_SILENCE_MS - (Date.now() - this.lastHeard)),
    );
  }

  /**
   * Dial now instead of waiting out the backoff: the page is in front of
   * someone right now. The backoff starts over should this dial fail too.
   */
  private redialNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.stopped) return;
    this.attempt = 0;
    this.open();
  }

  close(): void {
    this.stopped = true;
    this.clearGrace();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    // Whatever the pipe reports after this is about a connection now gone.
    this.generation += 1;
    this.teardown();
    socket?.close();
  }

  /** Dial, if there is a token and nothing is dialling already. */
  start(): void {
    if (this.socket || this.stopped || !this.canDial) return;
    if (this.reconnectTimer) return;
    this.open();
  }

  invoke(ns: string, method: string, args: unknown[]): Promise<unknown> {
    if (!this.canDial) {
      return Promise.reject(
        new BridgeDisconnectedError("This browser is not paired with Manor"),
      );
    }
    if (this.stopped) {
      return Promise.reject(
        new BridgeDisconnectedError("This browser is no longer connected"),
      );
    }
    this.start();
    const id = String(this.nextId++);
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendOrQueue({ id, kind: "invoke", ns, method, args });
    });
  }

  subscribe(
    ns: string,
    event: string,
    key: string | undefined,
    listener: BridgeListener,
  ): () => void {
    this.start();
    return this.registry.subscribe(ns, event, key, listener);
  }

  private open(): void {
    // Each callback checks it is still about the current connection, so a
    // pipe that reports late — a stale close after a reconnect — is ignored.
    const generation = ++this.generation;
    const current = (): boolean => this.generation === generation;
    this.socket = this.pipe.connect({
      onOpen: () => {
        if (current()) this.sayHello();
      },
      onMessage: (text) => {
        if (current()) this.onFrame(text);
      },
      onClose: (code) => {
        if (current()) this.onClose(code);
      },
    });
  }

  /**
   * Authentication is a frame, not a URL — see the server's header.
   * `previousId` is this connection's own rendererId from before the
   * reconnect, if it had one — the server reuses it when nothing else is
   * holding it, so a selection hint addressed to "the tab that sent this"
   * still finds it after a blip, and this connection's `pty-attachments`
   * viewer identity does not reset.
   *
   * `ticket` goes with the token until a hello is accepted: a
   * dial that failed before then retries with it, one after never does.
   *
   * Not said at all over a `preAuthenticated` pipe.
   */
  private sayHello(): void {
    this.resuming = this.rendererId !== null;
    // Said already, at the far end: what comes back is the reply to it. No
    // `previousId` can go with it, so a resumed connection there is a new
    // id — which a layout command's origin tolerates (see `rendererId`).
    if (this.options.preAuthenticated) return;
    this.write(
      JSON.stringify({
        type: "hello",
        token: this.options.token,
        ...(this.ticket !== null && { ticket: this.ticket }),
        ...(this.rendererId !== null && { previousId: this.rendererId }),
      }),
    );
  }

  private onFrame(text: string): void {
    // Anything at all from the far end says it is there.
    this.lastHeard = Date.now();
    for (const heard of [...this.heardWaiters]) heard(true);

    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    if (!this.ready) {
      if (frame.type === "hello" && frame.ok === true) {
        const reply = frame as Partial<HelloReplyFrame>;
        this.rendererId =
          typeof reply.rendererId === "string" ? reply.rendererId : null;
        // Redeemed, or the token was already known: the ticket is spent.
        this.ticket = null;
        this.onReady();
        this.options.onStatus?.("connected");
        this.options.onHello?.({
          rendererId: this.rendererId,
          appVersion:
            typeof reply.appVersion === "string" ? reply.appVersion : null,
          hostName: typeof reply.hostName === "string" ? reply.hostName : null,
          hostServer:
            typeof reply.hostServer === "boolean" ? reply.hostServer : false,
          resumed: this.resuming,
        });
      }
      return;
    }

    switch (frame.kind) {
      case "result":
        this.onResult(frame as unknown as ResultFrame);
        return;
      case "event":
        this.registry.deliver(frame as unknown as EventFrame);
        return;
      default:
        // Same rule the server applies to us: a frame from a newer host is
        // something to ignore, not something to disconnect over.
        return;
    }
  }

  /**
   * The host said hello back.
   *
   * Subscriptions go out before the queued invokes, and the order is
   * load-bearing: `useTerminalStream` subscribes to a pane's output and
   * *then* calls `pty.create`, so that the snapshot it gets back and the
   * stream that follows it join up. Flushing the calls first
   * would open that gap on every reconnect.
   */
  private onReady(): void {
    this.clearGrace();
    this.ready = true;
    this.attempt = 0;
    this.armSilence(SERVER_SILENCE_MS);
    for (const frame of this.registry.keys()) this.send(frame);
    for (const payload of this.outbox.splice(0)) this.write(payload);
  }

  private onResult(frame: ResultFrame): void {
    const id = String(frame.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    try {
      pending.resolve(settleResult(frame));
    } catch (err) {
      pending.reject(err as Error);
    }
  }

  /** The socket is gone: fail what was waiting on it. */
  private teardown(): void {
    this.socket = null;
    this.ready = false;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    for (const heard of [...this.heardWaiters]) heard(false);
    const dropped = new BridgeDisconnectedError();
    for (const pending of [...this.pending.values()]) pending.reject(dropped);
    this.pending.clear();
    this.outbox.length = 0;
  }

  private onClose(code: number): void {
    this.teardown();

    if (code === CLOSE_UNAUTHORIZED) {
      this.stopped = true;
      this.clearGrace();
      (this.options.onUnauthorized ?? defaultUnauthorized)();
      return;
    }
    if (code === CLOSE_KEY_MISMATCH && this.options.onKeyMismatch) {
      this.stopped = true;
      this.clearGrace();
      this.options.onKeyMismatch();
      return;
    }
    if (code === CLOSE_KEY_MISMATCH) this.options.onStatus?.("unreachable");
    if (this.pipe.unreachableCodes?.has(code)) {
      this.clearGrace();
      this.options.onStatus?.("unreachable");
    } else if (this.graceTimer === null) {
      // Any other drop that leads to a redial: give the redial a moment, then
      // stop pretending the server is reachable. Host pipes end
      // every pipe with a listed code, so they never get here.
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (this.stopped) return;
        this.options.onStatus?.("unreachable");
      }, DROP_GRACE_MS);
    }

    // Capped exponential backoff: a laptop that closed its lid should not
    // find a hundred failed dials in the relay's log when it wakes.
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * 2 ** this.attempt,
    );
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.open();
    }, delay);
  }

  private clearGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private sendOrQueue(frame: ClientFrame): void {
    const payload = JSON.stringify(frame);
    if (this.ready) this.write(payload);
    else this.outbox.push(payload);
  }

  /**
   * Subscription frames are never queued: the registry is replayed in full
   * the moment a socket is ready, so a queued copy would be a duplicate or a
   * lie about a subscription that has since been dropped.
   */
  private send(frame: ClientFrame): void {
    if (!this.ready) return;
    this.write(JSON.stringify(frame));
  }

  private write(payload: string): void {
    const socket = this.socket;
    if (!socket || !socket.open) return;
    try {
      socket.send(payload);
    } catch {
      // The socket died between the check and the send; `close` will clean up.
    }
  }
}

/** The transport `web-main.tsx` hands `createBridge`. */
export function createWsTransport(
  options: WsTransportOptions,
): WsBridgeTransport {
  return new WsTransport(options);
}
