/**
 * The browser's transport: one WebSocket to `/ws` (ADR-178 D8, ADR-180 D3).
 *
 * Everything that is *about the socket* and nothing that is about
 * `ns.method`: the connect, the hello, the JSON framing, the pending map, the
 * outbox, the live-subscription registry, the reconnect with its capped
 * backoff, and the two close codes that mean "stop dialling". The proxy above
 * it (`../client.ts`) is the same code the desktop runs.
 *
 * The frame shapes and `UNAVAILABLE_CODE` come from
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
  UNAVAILABLE_CODE,
  type EventFrame,
  type ResultFrame,
} from "../../../electron/bridge/types";
import {
  BridgeDisconnectedError,
  BridgeUnavailableError,
  type BridgeListener,
  type BridgeTransport,
} from "../client";
import { LOCALLY_SERVED } from "../unavailable";

/** Where `web-main.tsx` keeps the pairing token this bridge says hello with. */
export const WEB_TOKEN_KEY = "manor.web.token";

/**
 * `electron/bridge/transports/ws.ts`'s close codes, mirrored rather than
 * imported: that module reaches for the `ws` package and, through the handler
 * table, the whole main process — the two numbers are cheaper than the bundle.
 */
/** `CLOSE_UNAUTHORIZED`: re-pair this device. */
const CLOSE_UNAUTHORIZED = 4401;
/** `CLOSE_FORBIDDEN`: paired, but below `full`. */
const CLOSE_FORBIDDEN = 4403;

/** First reconnect delay, and the ceiling it doubles towards. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * The key a subscription that named none is filed under, on both sides of the
 * socket. Kept out of the wire frame: the host defaults a missing `key` to
 * exactly this, and sending it would be saying the same thing twice.
 */
const ALL_KEYS = "*";

/** Plain, non-function root members of `ElectronAPI`, answered from here. */
const ROOT_VALUES: Record<string, unknown> = {
  /** Detached windows are Electron's (ADR-156); a tab is never one. */
  isDetached: false,
  detachedWindowId: null,
  /** And a browser never claims a tab either (ADR-179 D4): it sees them all. */
  claim: null,
  /** The preload reads this off its own launch argv. A page has no argv. */
  env: { isPackaged: false },
};

export interface WsTransportOptions {
  /** The paired device's token. `null` installs a bridge that never dials. */
  token: string | null;
  url: string;
  /** Close 4401: the token is dead. Default forgets it and reloads. */
  onUnauthorized?: () => void;
  /** Close 4403: paired below `full`. Default logs; `web-main` renders it. */
  onForbidden?: () => void;
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
class WsTransport implements BridgeTransport {
  private socket: WebSocket | null = null;
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
  /** `ns.event` → key → listeners. The key is a paneId, or `ALL_KEYS`. */
  private readonly listeners = new Map<
    string,
    Map<string, Set<BridgeListener>>
  >();

  readonly platform = "web" as const;
  readonly rootValues = ROOT_VALUES;
  /** A browser has no preload: nothing is served in process by a namespace. */
  readonly localNamespaces: Record<string, unknown> = {};
  readonly locallyServed = LOCALLY_SERVED;

  constructor(private readonly options: WsTransportOptions) {}

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
    const name = `${ns}.${event}`;
    const slot = key ?? ALL_KEYS;
    let byKey = this.listeners.get(name);
    if (!byKey) {
      byKey = new Map();
      this.listeners.set(name, byKey);
    }
    let set = byKey.get(slot);
    const isFirst = set === undefined;
    if (!set) {
      set = new Set();
      byKey.set(slot, set);
    }
    set.add(listener);
    if (isFirst) {
      // The registry is the source of truth; the frame is a copy of it that
      // the host happens to hold. On reconnect the registry is replayed.
      this.start();
      this.send(this.subscriptionFrame("subscribe", ns, event, slot));
    }

    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const current = this.listeners.get(name)?.get(slot);
      if (!current) return;
      current.delete(listener);
      if (current.size > 0) return;
      const owner = this.listeners.get(name);
      owner?.delete(slot);
      if (owner?.size === 0) this.listeners.delete(name);
      this.send(this.subscriptionFrame("unsubscribe", ns, event, slot));
    };
  }

  private subscriptionFrame(
    kind: "subscribe" | "unsubscribe",
    ns: string,
    event: string,
    key: string,
  ): Record<string, unknown> {
    return key === ALL_KEYS ? { kind, ns, event } : { kind, ns, event, key };
  }

  private open(): void {
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      // Authentication is a frame, not a URL — see the server's header.
      // `previousId` is this connection's own rendererId from before the
      // reconnect, if it had one — the server reuses it when nothing else is
      // holding it, so a selection hint addressed to "the tab that sent this"
      // still finds it after a blip, and this connection's `pty-attachments`
      // viewer identity does not reset (ADR-179 ticket 4's report).
      socket.send(
        JSON.stringify({
          type: "hello",
          token: this.options.token,
          ...(this.rendererId !== null && { previousId: this.rendererId }),
        }),
      );
    };
    socket.onmessage = (event: MessageEvent) => {
      this.onFrame(String(event.data));
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket === socket) this.onClose(event.code);
    };
    socket.onerror = () => {
      // A `close` always follows, and it carries the code this cares about.
    };
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
        this.rendererId =
          typeof frame.rendererId === "string" ? frame.rendererId : null;
        this.onReady();
      }
      return;
    }

    switch (frame.kind) {
      case "result":
        this.onResult(frame as unknown as ResultFrame);
        return;
      case "event":
        this.onEvent(frame as unknown as EventFrame);
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
    for (const [name, byKey] of this.listeners) {
      const split = name.indexOf(".");
      const ns = name.slice(0, split);
      const event = name.slice(split + 1);
      for (const key of byKey.keys()) {
        this.send(this.subscriptionFrame("subscribe", ns, event, key));
      }
    }
    for (const payload of this.outbox.splice(0)) this.write(payload);
  }

  private onResult(frame: ResultFrame): void {
    const id = String(frame.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (frame.ok === true) {
      pending.resolve(frame.result);
      return;
    }
    const message =
      typeof frame.error === "string" ? frame.error : "The host refused";
    pending.reject(
      frame.code === UNAVAILABLE_CODE
        ? new BridgeUnavailableError(message)
        : new Error(message),
    );
  }

  private onEvent(frame: EventFrame): void {
    const { ns, event } = frame;
    if (typeof ns !== "string" || typeof event !== "string") return;
    const byKey = this.listeners.get(`${ns}.${event}`);
    if (!byKey) return;
    const args = Array.isArray(frame.args) ? frame.args : [];
    // A keyless event is about the machine (`projects.changed`), so every
    // listener of that name wants it. A keyed one is about one pane, and goes
    // to that pane's listeners plus anyone who subscribed without naming one.
    const sets =
      typeof frame.key === "string"
        ? [byKey.get(frame.key), byKey.get(ALL_KEYS)]
        : [...byKey.values()];
    for (const set of sets) {
      if (!set) continue;
      for (const listener of [...set]) {
        try {
          listener(...args);
        } catch (err) {
          // One bad listener must not cost the others their event.
          console.error(`[ws-bridge] ${ns}.${event} listener threw:`, err);
        }
      }
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

  private sendOrQueue(frame: Record<string, unknown>): void {
    const payload = JSON.stringify(frame);
    if (this.ready) this.write(payload);
    else this.outbox.push(payload);
  }

  /**
   * Subscription frames are never queued: the registry is replayed in full
   * the moment a socket is ready, so a queued copy would be a duplicate or a
   * lie about a subscription that has since been dropped.
   */
  private send(frame: Record<string, unknown>): void {
    if (!this.ready) return;
    this.write(JSON.stringify(frame));
  }

  private write(payload: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
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
): BridgeTransport {
  return new WsTransport(options);
}
