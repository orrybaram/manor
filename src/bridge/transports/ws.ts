/**
 * The browser's transport: one socket to the host (ADR-178 D8, ADR-180 D3).
 *
 * Everything that is *about the socket* and nothing that is about
 * `ns.method`: the connect, the hello, the JSON framing, the pending map, the
 * outbox, the live-subscription registry, the reconnect with its capped
 * backoff, and the two close codes that mean "stop dialling". The proxy above
 * it (`../client.ts`) is the same code the desktop runs.
 *
 * **The socket itself is a `Pipe`** (ADR-206 D3): "open something, send
 * text, receive text, learn the close code". The listener-served `/app`
 * uses `webSocketPipe` — a plain WebSocket to `/ws`, exactly what this file
 * always did — and a relay-served page uses `./relay-pipe.ts`, which runs the
 * Noise handshake under the same four callbacks. Everything above the pipe
 * is one piece of code for both.
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
  CLOSE_FORBIDDEN,
  CLOSE_UNAUTHORIZED,
  type ClientFrame,
  type EventFrame,
  type HelloReplyFrame,
  type ResultFrame,
} from "../../../electron/bridge/types";
import {
  BridgeDisconnectedError,
  settle,
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
}

/** Something that can open connections carrying the bridge's text frames. */
export interface Pipe {
  connect(handlers: PipeHandlers): PipeConnection;
  /**
   * Close codes that mean "the host is not there right now" rather than "the
   * line dropped": still retried with backoff, but also surfaced, so the page
   * can say so instead of looking frozen. The plain WebSocket has none.
   */
  readonly unreachableCodes?: ReadonlySet<number>;
}

/** The listener's pipe: a plain WebSocket to `url`, text frames as-is. */
export function webSocketPipe(url: string): Pipe {
  return {
    connect(handlers) {
      const socket = new WebSocket(url);
      socket.onopen = () => handlers.onOpen();
      socket.onmessage = (event: MessageEvent) => {
        handlers.onMessage(String(event.data));
      };
      socket.onclose = (event: CloseEvent) => handlers.onClose(event.code);
      socket.onerror = () => {
        // A `close` always follows, and it carries the code this cares about.
      };
      return {
        get open() {
          return socket.readyState === 1;
        },
        send: (text) => socket.send(text),
      };
    },
  };
}

/**
 * A pipe's verdict that the far end does not hold the key this page was
 * paired with (`relay-pipe.ts`: several bad Noise message 2s in a row). Never
 * on the wire. Unlike 4401 it is not proof the credentials are dead — so the
 * transport stops dialling and asks to re-pair, but does not forget them.
 */
export const CLOSE_KEY_MISMATCH = 4502;

/** Where `web-main.tsx` keeps the pairing token this bridge says hello with. */
export const WEB_TOKEN_KEY = "manor.web.token";

/** First reconnect delay, and the ceiling it doubles towards. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Plain, non-function root members of `ElectronAPI`, answered from here. */
const ROOT_VALUES: Record<string, unknown> = {
  /**
   * A browser never claims a tab (ADR-179 D4): it sees them all, and so it is
   * never a detached window either.
   */
  claim: null,
  /** The preload reads this off its own launch argv. A page has no argv. */
  env: { isPackaged: false },
};

export interface WsTransportOptions {
  /** The paired device's token. `null` installs a bridge that never dials. */
  token: string | null;
  /** A plain WebSocket to this URL. Ignored when `pipe` is given. */
  url?: string;
  /** What carries the frames. Defaults to `webSocketPipe(url)`. */
  pipe?: Pipe;
  /** Close 4401: the token is dead. Default forgets it and reloads. */
  onUnauthorized?: () => void;
  /** Close 4403: paired below `full`. Default logs; `web-main` renders it. */
  onForbidden?: () => void;
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
  /** The desktop's version (ADR-206 D4), or null from an older host. */
  appVersion: string | null;
}

/** `BridgeTransport`, plus the one thing a "not reachable" screen needs. */
export interface WsBridgeTransport extends BridgeTransport {
  /** Skip the rest of the backoff wait and dial now, if one is pending. */
  retryNow(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** Drop a token the host refused. The next load shows the pairing screen. */
export function forgetWebToken(): void {
  try {
    localStorage.removeItem(WEB_TOKEN_KEY);
  } catch {
    // Private browsing with storage denied. There was nothing to forget.
  }
}

/** `ws://` or `wss://` this page's own host, at `BRIDGE_PATH`. */
export function bridgeUrlFromLocation(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
}

function defaultUnauthorized(): void {
  forgetWebToken();
  location.reload();
}

function defaultForbidden(): void {
  console.error(
    "[ws-bridge] this device is paired below the 'full' capability",
  );
}

/** The socket, the pending calls and the live subscriptions. */
class WsTransport implements WsBridgeTransport {
  private readonly pipe: Pipe;
  private socket: PipeConnection | null = null;
  /** Bumped per dial; a pipe callback from an older dial is ignored. */
  private generation = 0;
  private ready = false;
  /**
   * What the host calls this socket, from the hello reply (ADR-179 D3).
   *
   * Null until the first hello, and a *different* value after a reconnect —
   * which is correct: it names a connection, and a layout command's origin is
   * the connection that sent it. A hint addressed to the previous id simply
   * does not apply, and the reconcile that runs on every broadcast leaves the
   * tab looking where it was looking.
   */
  rendererId: string | null = null;
  /** Set by a 4401/4403: this token will not work, so stop dialling. */
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
    if (options.pipe) this.pipe = options.pipe;
    else if (options.url !== undefined) this.pipe = webSocketPipe(options.url);
    else throw new Error("createWsTransport needs a url or a pipe");
  }

  retryNow(): void {
    if (!this.reconnectTimer || this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.open();
  }

  /** Dial, if there is a token and nothing is dialling already. */
  start(): void {
    if (this.socket || this.stopped || this.options.token === null) return;
    if (this.reconnectTimer) return;
    this.open();
  }

  invoke(ns: string, method: string, args: unknown[]): Promise<unknown> {
    if (this.options.token === null) {
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
   */
  private sayHello(): void {
    this.write(
      JSON.stringify({
        type: "hello",
        token: this.options.token,
        ...(this.rendererId !== null && { previousId: this.rendererId }),
      }),
    );
  }

  private onFrame(text: string): void {
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
        this.onReady();
        this.options.onStatus?.("connected");
        this.options.onHello?.({
          rendererId: this.rendererId,
          appVersion:
            typeof reply.appVersion === "string" ? reply.appVersion : null,
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
   * stream that follows it join up (ADR-159/164). Flushing the calls first
   * would open that gap on every reconnect.
   */
  private onReady(): void {
    this.ready = true;
    this.attempt = 0;
    for (const frame of this.registry.keys()) this.send(frame);
    for (const payload of this.outbox.splice(0)) this.write(payload);
  }

  private onResult(frame: ResultFrame): void {
    const id = String(frame.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    try {
      pending.resolve(settle(frame));
    } catch (err) {
      pending.reject(err as Error);
    }
  }

  private onClose(code: number): void {
    this.socket = null;
    this.ready = false;

    const dropped = new BridgeDisconnectedError();
    for (const pending of [...this.pending.values()]) pending.reject(dropped);
    this.pending.clear();
    this.outbox.length = 0;

    if (code === CLOSE_UNAUTHORIZED) {
      this.stopped = true;
      (this.options.onUnauthorized ?? defaultUnauthorized)();
      return;
    }
    if (code === CLOSE_FORBIDDEN) {
      this.stopped = true;
      (this.options.onForbidden ?? defaultForbidden)();
      return;
    }
    if (code === CLOSE_KEY_MISMATCH && this.options.onKeyMismatch) {
      this.stopped = true;
      this.options.onKeyMismatch();
      return;
    }
    if (code === CLOSE_KEY_MISMATCH) this.options.onStatus?.("unreachable");
    if (this.pipe.unreachableCodes?.has(code)) {
      this.options.onStatus?.("unreachable");
    }

    // Capped exponential backoff: a laptop that closed its lid should not
    // find a hundred failed dials in the tunnel's log when it wakes.
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
