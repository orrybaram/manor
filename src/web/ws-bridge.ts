/**
 * `window.electronAPI`, implemented over one WebSocket (ADR-178 D8).
 *
 * The desktop renderer reaches its host through a preload script: 219 methods
 * across 27 namespaces, each of them an `ipcRenderer.invoke` or an
 * `ipcRenderer.on`. The web renderer is the same 118 `.tsx` files with no
 * preload under them, so this module installs an object of the same shape
 * whose methods are frames on the `/ws` socket `ws-bridge-server.ts` answers.
 * Sixty-six files call into that object and not one of them changes.
 *
 * **A `Proxy` rather than 219 written-out methods.** The alternative is a
 * hand-maintained mirror of `src/electron.d.ts` that is wrong the first time
 * someone adds a method and does not notice this file. The proxy is not
 * clever about which methods exist — it cannot be, and it should not try: the
 * authority on what the host implements is `WS_HANDLERS`, and a method absent
 * from it comes back as `unavailable:web` from the one place that knows.
 *
 * Two rules turn a property access into a frame:
 *
 * - `ns.method(...args)` → `{id, kind:"invoke", ns, method, args}`, awaiting
 *   `{id, kind:"result"}`.
 * - `ns.on<Event>(...args, callback)` → a `subscribe` frame and a local
 *   listener, returning the unsubscribe function the preload returns. The
 *   event name is the method's, minus `on`, first letter lowered
 *   (`onOutput` → `output`); the exceptions are tabulated in
 *   `SUBSCRIPTION_EVENTS` below. For `pty.*` the leading argument is the
 *   `paneId`, and it rides along as the frame's `key` — the server filters on
 *   it, and so does the delivery side here, because one socket carries every
 *   pane's output.
 *
 * A method is a subscription only if it *also* was handed a function as its
 * last argument: `on`-prefixed invokes are not a thing today, but deciding
 * from the arguments rather than the name means they would work if they were.
 */

import type { ElectronAPI } from "../electron";
import { LOCALLY_SERVED, UNAVAILABLE_NAMESPACES } from "./unavailable";

/** Mirrors `UNAVAILABLE_CODE` in `electron/remote-control/ws-handlers.ts`. */
export const UNAVAILABLE_CODE = "unavailable:web";

/** Where `web-main.tsx` keeps the pairing token this bridge says hello with. */
export const WEB_TOKEN_KEY = "manor.web.token";

/** `ws-bridge-server.ts`'s `CLOSE_UNAUTHORIZED`: re-pair this device. */
const CLOSE_UNAUTHORIZED = 4401;
/** `ws-bridge-server.ts`'s `CLOSE_FORBIDDEN`: paired, but below `full`. */
const CLOSE_FORBIDDEN = 4403;

/** First reconnect delay, and the ceiling it doubles towards. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * The key a subscription that named none is filed under, on both sides of the
 * socket. Kept out of the wire frame: the server defaults a missing `key` to
 * exactly this, and sending it would be saying the same thing twice.
 */
const ALL_KEYS = "*";

/**
 * The host does not implement this, and never will in a browser.
 *
 * Its own type so a component can `catch` it and render the stated empty
 * state ADR-178 promises instead of a crash — `err instanceof
 * BridgeUnavailableError`, not a string match on a message.
 */
export class BridgeUnavailableError extends Error {
  readonly code = UNAVAILABLE_CODE;
  constructor(message: string) {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

/**
 * The socket dropped with this call still in flight.
 *
 * Every pending invoke gets one the moment the socket closes. The alternative
 * — leaving promises pending across a reconnect — is a UI that spins forever
 * because a tunnel blinked, and a caller that cannot tell "slow" from "gone".
 * The reconnect happens regardless; it just does not carry the old calls,
 * which may have been applied on the host before it dropped.
 */
export class BridgeDisconnectedError extends Error {
  constructor(message = "The connection to Manor dropped") {
    super(message);
    this.name = "BridgeDisconnectedError";
  }
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

export interface WsBridgeOptions {
  /** The paired device's token. `null` installs a bridge that never dials. */
  token: string | null;
  url: string;
  /** Close 4401: the token is dead. Default forgets it and reloads. */
  onUnauthorized?: () => void;
  /** Close 4403: paired below `full`. Default logs; `web-main` renders it. */
  onForbidden?: () => void;
}

type Listener = (...args: unknown[]) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * The name of the event `ns.on<Event>` subscribes to, where lowering the
 * first letter of the suffix is not the answer.
 *
 * Every entry is a place the preload named the *verb* and
 * `renderer-broadcast.ts` named the *fact*: main broadcasts that preferences
 * `changed`, and the renderer asked to be told `onChange`. The list is short
 * and closed — it is the full set of non-`pty` events the server publishes
 * (see `onRendererBroadcast` in `ws-bridge-server.ts`) whose preload name does
 * not already match. `notifications.onChanged` and `stats.onChanged` are
 * absent because they need no help.
 */
const SUBSCRIPTION_EVENTS: Record<string, string> = {
  "agents.onUpdate": "updated",
  "preferences.onChange": "changed",
  "keybindings.onChange": "changed",
};

/**
 * The one subscription that lives on the root rather than in a namespace.
 * `onProjectsChanged(cb)` predates the namespaces around it; on the wire it is
 * `projects.changed` like everything else.
 */
const ROOT_SUBSCRIPTIONS: Record<string, { ns: string; event: string }> = {
  onProjectsChanged: { ns: "projects", event: "changed" },
};

/** Plain, non-function members of `ElectronAPI`, answered from here. */
const ROOT_VALUES: Record<string, unknown> = {
  /** ADR-178 D8's discriminator: which implementation is installed. */
  platform: "web",
  /** Detached windows are Electron's (ADR-156); a tab is never one. */
  isDetached: false,
  detachedWindowId: null,
  /** And a browser never claims a tab either (ADR-179 D4): it sees them all. */
  claim: null,
  /** The preload reads this off its own launch argv. A page has no argv. */
  env: { isPackaged: false },
};

/**
 * Property names that are never bridge members: JavaScript asks for them on
 * its own (string coercion, `await`, a console formatter, React's element
 * check), and answering with a function that opens a socket would turn
 * logging the bridge into calling it.
 */
const NOT_MEMBERS: ReadonlySet<string> = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "toString",
  "valueOf",
  "constructor",
  "$$typeof",
  "nodeType",
]);

/** `Object.hasOwn` in an ES2020 lib: the prototype chain is not a member. */
function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function eventNameFor(ns: string, method: string): string {
  return (
    SUBSCRIPTION_EVENTS[`${ns}.${method}`] ??
    method.charAt(2).toLowerCase() + method.slice(3)
  );
}

/** `onOutput` yes, `once` no: `on` followed by an upper-case letter. */
function looksLikeSubscription(method: string): boolean {
  if (!method.startsWith("on") || method.length < 3) return false;
  const third = method.charAt(2);
  return third !== third.toLowerCase();
}

/**
 * The socket, the pending calls and the live subscriptions.
 *
 * Opened on first use rather than on construction: `web-main.tsx` installs the
 * bridge before it renders anything, and a socket opened there would race the
 * first paint for no reason. Everything before `hello` is answered is queued,
 * not dropped.
 */
class BridgeConnection {
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
  private readonly listeners = new Map<string, Map<string, Set<Listener>>>();

  constructor(private readonly options: WsBridgeOptions) {}

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
    this.ensureSocket();
    const id = String(this.nextId++);
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendOrQueue({ id, kind: "invoke", ns, method, args });
    });
  }

  subscribe(
    ns: string,
    event: string,
    key: string,
    listener: Listener,
  ): () => void {
    const name = `${ns}.${event}`;
    let byKey = this.listeners.get(name);
    if (!byKey) {
      byKey = new Map();
      this.listeners.set(name, byKey);
    }
    let set = byKey.get(key);
    const isFirst = set === undefined;
    if (!set) {
      set = new Set();
      byKey.set(key, set);
    }
    set.add(listener);
    if (isFirst) {
      // The registry is the source of truth; the frame is a copy of it that
      // the server happens to hold. On reconnect the registry is replayed.
      this.ensureSocket();
      this.send(this.subscriptionFrame("subscribe", ns, event, key));
    }

    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const current = this.listeners.get(name)?.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size > 0) return;
      const owner = this.listeners.get(name);
      owner?.delete(key);
      if (owner?.size === 0) this.listeners.delete(name);
      this.send(this.subscriptionFrame("unsubscribe", ns, event, key));
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

  private ensureSocket(): void {
    if (this.socket || this.stopped || this.options.token === null) return;
    if (this.reconnectTimer) return;
    this.open();
  }

  private open(): void {
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => {
      // Authentication is a frame, not a URL — see the server's header.
      socket.send(JSON.stringify({ type: "hello", token: this.options.token }));
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
        this.onResult(frame);
        return;
      case "event":
        this.onEvent(frame);
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

  private onResult(frame: Record<string, unknown>): void {
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

  private onEvent(frame: Record<string, unknown>): void {
    const { ns, event } = frame;
    if (typeof ns !== "string" || typeof event !== "string") return;
    const byKey = this.listeners.get(`${ns}.${event}`);
    if (!byKey) return;
    const args = Array.isArray(frame.args) ? (frame.args as unknown[]) : [];
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

function defaultUnauthorized(): void {
  forgetWebToken();
  location.reload();
}

function defaultForbidden(): void {
  console.error(
    "[ws-bridge] this device is paired below the 'full' capability",
  );
}

/**
 * Build the bridge. The returned object claims to be an `ElectronAPI`; the
 * cast is the honest part of the design — a `Proxy` cannot be structurally
 * checked against 219 signatures, and the server, not the type, decides what
 * actually answers.
 */
export function createWsBridge(options: WsBridgeOptions): ElectronAPI {
  const connection = new BridgeConnection(options);
  const namespaces = new Map<string, Record<string, unknown>>();

  function method(
    ns: string | null,
    name: string,
  ): (...a: unknown[]) => unknown {
    const key = ns === null ? name : `${ns}.${name}`;
    return (...args: unknown[]) => {
      const last = args[args.length - 1];
      if (looksLikeSubscription(name) && typeof last === "function") {
        const listener = last as Listener;
        if (ns !== null && UNAVAILABLE_NAMESPACES.has(ns)) {
          // A component that subscribes on mount and unsubscribes on unmount
          // must survive both halves; throwing here would take the tree down
          // on the way up, before it could render its empty state.
          return () => {};
        }
        const target =
          ns === null
            ? (ROOT_SUBSCRIPTIONS[name] as
                | { ns: string; event: string }
                | undefined)
            : { ns, event: eventNameFor(ns, name) };
        if (!target) return () => {};
        // `pty.onOutput(paneId, cb)` and friends: the leading argument names
        // the pane, and one socket carries every pane.
        const subscriptionKey =
          args.length > 1 && typeof args[0] === "string" ? args[0] : ALL_KEYS;
        return connection.subscribe(
          target.ns,
          target.event,
          subscriptionKey,
          listener,
        );
      }

      const local = hasOwn(LOCALLY_SERVED, key)
        ? LOCALLY_SERVED[key]
        : undefined;
      if (local) return local(...args);
      if (ns === null) {
        return Promise.reject(
          new BridgeUnavailableError(`${name} is not available in the browser`),
        );
      }
      if (UNAVAILABLE_NAMESPACES.has(ns)) {
        return Promise.reject(
          new BridgeUnavailableError(`${key} is not available in the browser`),
        );
      }
      return connection.invoke(ns, name, args);
    };
  }

  /**
   * One member of a namespace: callable, and also a namespace itself.
   *
   * `git.push` is both — `git.push.start(...)` and `git.push.onProgress(cb)`
   * are the only two-level path in `preload.ts`, and a member that were only
   * a function would make `DiffPane` throw a `TypeError` on mount rather than
   * render the refusal it is being handed. Nesting costs one proxy and keeps
   * the rule uniform: the namespace of `git.push.start` is `git.push`, which
   * is what the handler table would key it under if it ever serves it.
   */
  function member(ns: string, name: string): (...a: unknown[]) => unknown {
    const fn = method(ns, name);
    const nested = new Map<string, unknown>();
    return new Proxy(fn, {
      get(target, prop, receiver) {
        if (
          typeof prop !== "string" ||
          NOT_MEMBERS.has(prop) ||
          // `name`, `length`, `call`, `bind` — the function's own.
          Reflect.has(target, prop)
        ) {
          return Reflect.get(target, prop, receiver) as unknown;
        }
        const existing = nested.get(prop);
        if (existing) return existing;
        const child = method(`${ns}.${name}`, prop);
        nested.set(prop, child);
        return child;
      },
    });
  }

  function namespace(ns: string): Record<string, unknown> {
    const cached = namespaces.get(ns);
    if (cached) return cached;
    const members = new Map<string, unknown>();
    const proxy = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== "string" || NOT_MEMBERS.has(prop)) {
            return undefined;
          }
          const existing = members.get(prop);
          if (existing) return existing;
          const fn = member(ns, prop);
          members.set(prop, fn);
          return fn;
        },
      },
    ) as Record<string, unknown>;
    namespaces.set(ns, proxy);
    return proxy;
  }

  const rootMembers = new Map<string, unknown>();
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string" || NOT_MEMBERS.has(prop)) {
          return undefined;
        }
        // Not in `ROOT_VALUES`: it is not a constant. The host names the
        // connection in its hello reply, and names it again after a
        // reconnect (ADR-179 D3).
        if (prop === "rendererId") return connection.rendererId;
        if (hasOwn(ROOT_VALUES, prop)) return ROOT_VALUES[prop];
        if (hasOwn(ROOT_SUBSCRIPTIONS, prop) || hasOwn(LOCALLY_SERVED, prop)) {
          const existing = rootMembers.get(prop);
          if (existing) return existing;
          const fn = method(null, prop);
          rootMembers.set(prop, fn);
          return fn;
        }
        // `onAppCommand` lands here as a namespace and would be wrong; it is
        // the only root `on*` with no wire event, so it is named explicitly.
        if (looksLikeSubscription(prop)) return () => () => {};
        return namespace(prop);
      },
    },
  ) as unknown as ElectronAPI;
}
