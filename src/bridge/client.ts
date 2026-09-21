/**
 * `window.electronAPI`, built in the page over one transport (ADR-180 D3).
 *
 * The desktop renderer used to reach its host through a preload script: 211
 * methods across 26 namespaces, each of them an `ipcRenderer.invoke` or an
 * `ipcRenderer.on`. The web renderer (ADR-178 D8) is the same `.tsx` files
 * with no preload under them, so it installed an object of the same shape
 * whose methods were frames on a WebSocket. This module is that object for
 * both of them: one proxy, one protocol (`electron/bridge/types.ts`), and a
 * `BridgeTransport` underneath it that is either `window.manorHost`'s IPC
 * channels or the `/ws` socket. Ninety-seven files call into it and not one
 * of them knows which.
 *
 * **The page builds it, on both platforms.** `contextBridge` copies the shape
 * it is handed across the isolated-world boundary, and a `Proxy`'s members
 * are not there to copy — so the preload cannot simply hand the desktop this
 * object. It hands it the door instead (`ManorHost`), and the desktop builds
 * the proxy over it exactly where the browser already builds one.
 *
 * **A `Proxy` rather than 211 written-out methods.** The alternative is a
 * hand-maintained mirror of `src/electron.d.ts` that is wrong the first time
 * someone adds a method and does not notice this file. The proxy is not
 * clever about which methods exist — it cannot be, and it should not try: the
 * authority on what the host implements is `HANDLERS`, and a method absent
 * from it comes back as `unavailable:web` from the one place that knows.
 *
 * Two rules turn a property access into a frame:
 *
 * - `ns.method(...args)` → `{id, kind:"invoke", ns, method, args}`, awaiting
 *   `{id, kind:"result"}`, which `settle` below turns into the value or the
 *   error — the same way for both transports.
 * - A listener → a `subscribe` frame and a local listener, returning the
 *   unsubscribe. Which members are listeners, and which event each one
 *   hears, is `SUBSCRIPTIONS` (`electron/bridge/events.ts`) — read here, not
 *   restated. For `pty.*` the leading argument is the `paneId`, and it rides
 *   along as the frame's `key` — the host filters on it, and so does the
 *   delivery side, because one connection carries every pane's output.
 *
 * A listener subscribes only if it was *also* handed a function as its last
 * argument; called any other way it is an ordinary invoke, and the host
 * answers that it has no such method.
 *
 * **What a property access resolves to, in order.**
 *
 * 1. `transport.localNamespaces[ns]` — a namespace the transport serves in
 *    process, called straight through with the arguments it was given. On the
 *    desktop that is `manorHost.native`: the namespaces that can never leave
 *    the preload (`webview`, `window`, `menu`, `dialog`, `shell`,
 *    `clipboard`, `updater`). Empty in a browser.
 * 2. `transport.locallyServed["ns.method"]` — one method the transport
 *    answers itself: the browser's own clipboard and viewport
 *    (`./unavailable.ts`). Empty on the desktop.
 * 3. `UNAVAILABLE_NAMESPACES` — refused without asking, because no host can
 *    answer it in a browser (`./unavailable.ts` says why). A desktop never
 *    reaches this step: every namespace in that set is in `localNamespaces`
 *    above, and stays there forever.
 * 4. The transport — an invoke frame, or a subscribe frame and a listener.
 *
 * **What deliberately is not here.** The pending map, the outbox and the
 * live-subscription registry are *inside* the transports rather than above
 * them. Correlating a reply with its call is something a transport does with
 * its own ids, and the two do it differently: the WebSocket has to replay
 * every subscription after a reconnect, while the IPC transport has no
 * reconnect and a preload that holds the registry. Both registries are one
 * class (`./subscription-registry.ts`). What is left here is what both
 * halves must agree on — what `ns.method` means, and what a result frame
 * means.
 */

import { SUBSCRIPTIONS } from "../../electron/bridge/events";
import {
  UNAVAILABLE_CODE,
  type ResultFrame,
} from "../../electron/bridge/types";
import type { ElectronAPI } from "../electron";
import type { Listener } from "./subscription-registry";
import { UNAVAILABLE_NAMESPACES } from "./unavailable";

/** Delivered a frame's `args`, spread — the shape an `onX` callback has. */
export type BridgeListener = Listener;

/**
 * How the proxy reaches a host. A socket and an IPC channel are both this.
 *
 * Everything a transport is — a `WebSocket`, a reconnect timer, a hello, the
 * preload's four channels — stays on its own side of this interface, and
 * everything above it is the same code on both platforms. The next transport
 * (a cloud host, ADR-178 D7) is a file next to the two that exist.
 */
export interface BridgeTransport {
  /**
   * Make sure the host is reachable. Called before the first invoke or
   * subscribe and on every one after, so it must be cheap and idempotent: the
   * WebSocket dials on the first call and ignores the rest, and IPC — which
   * is up before the page runs — does nothing at all.
   */
  start(): void;
  invoke(ns: string, method: string, args: unknown[]): Promise<unknown>;
  subscribe(
    ns: string,
    event: string,
    /** A `paneId`, or undefined for every key of this event. */
    key: string | undefined,
    callback: BridgeListener,
  ): () => void;
  /** Host-assigned connection id, once known (ADR-179 D3). */
  readonly rendererId: string | null;
  /** ADR-178 D8's discriminator. Answered synchronously, during render. */
  readonly platform: "electron" | "web";
  /** Root values the transport answers without a round trip. */
  readonly rootValues: Record<string, unknown>;
  /** Namespaces the transport serves itself (native preload, or the tab). */
  readonly localNamespaces: Record<string, unknown>;
  /** `ns.method` entries the transport answers itself. */
  readonly locallyServed: Record<string, (...args: unknown[]) => unknown>;
}

/**
 * The host does not implement this, and never will here.
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
 * The connection dropped with this call still in flight.
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

/**
 * A result frame, as what the call it answers resolves with or throws.
 *
 * One place for both transports: the socket delivers the frame as a message
 * and the preload as the answer to `ipcMain.handle`, and neither decides for
 * itself what `unavailable:web` means.
 */
export function settle(frame: ResultFrame): unknown {
  if (frame.ok === true) return frame.result;
  const message =
    typeof frame.error === "string" ? frame.error : "The host refused";
  throw frame.code === UNAVAILABLE_CODE
    ? new BridgeUnavailableError(message)
    : new Error(message);
}

/** A listener's `ns.method` → the event it subscribes to, split for a frame. */
const LISTENERS: Record<string, { ns: string; event: string }> =
  Object.fromEntries(
    Object.entries(SUBSCRIPTIONS).map(([listener, wire]) => {
      const at = wire.lastIndexOf(".");
      return [listener, { ns: wire.slice(0, at), event: wire.slice(at + 1) }];
    }),
  );

/**
 * Property names that are never bridge members: JavaScript asks for them on
 * its own (string coercion, `await`, a console formatter, React's element
 * check), and answering with a function that opens a connection would turn
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

/**
 * `ns.method` on a namespace the transport serves in process, or null.
 *
 * `ns` is a path because `git.push` is one (see `member` below), so this
 * walks it: `localNamespaces.git.push.start`. Own properties only — a proxy
 * that resolved `pty.hasOwnProperty` onto `Object.prototype` would be handing
 * the page an arbitrary built-in through the host surface. A namespace that
 * is present but has no such method falls through to the transport rather
 * than throwing, which is how a method added to `ElectronAPI` and to
 * `HANDLERS` but not to the preload still works.
 */
function localMember(
  root: Record<string, unknown>,
  ns: string,
  name: string,
): {
  owner: Record<string, unknown>;
  fn: (...args: unknown[]) => unknown;
} | null {
  let owner: unknown = root;
  for (const segment of ns.split(".")) {
    if (typeof owner !== "object" || owner === null) return null;
    if (!hasOwn(owner, segment)) return null;
    owner = (owner as Record<string, unknown>)[segment];
  }
  if (typeof owner !== "object" || owner === null) return null;
  const target = owner as Record<string, unknown>;
  if (!hasOwn(target, name)) return null;
  const fn = target[name];
  if (typeof fn !== "function") return null;
  return { owner: target, fn: fn as (...args: unknown[]) => unknown };
}

/**
 * Build the bridge. The returned object claims to be an `ElectronAPI`; the
 * cast is the honest part of the design — a `Proxy` cannot be structurally
 * checked against 211 signatures, and the host, not the type, decides what
 * actually answers. ADR-180 D7 is the check that closes that gap.
 */
export function createBridge(transport: BridgeTransport): ElectronAPI {
  const namespaces = new Map<string, Record<string, unknown>>();

  function method(ns: string, name: string): (...a: unknown[]) => unknown {
    const key = `${ns}.${name}`;
    const listens = hasOwn(LISTENERS, key) ? LISTENERS[key] : null;
    return (...args: unknown[]) => {
      // 1. A namespace this transport serves in process (`manorHost.native`).
      const native = localMember(transport.localNamespaces, ns, name);
      if (native) return native.fn.apply(native.owner, args);

      // 2. One method it answers itself.
      const served = hasOwn(transport.locallyServed, key)
        ? transport.locallyServed[key]
        : undefined;
      if (served) return served(...args);

      const last = args[args.length - 1];

      // 3. Refused here, without asking a host that could not answer either.
      if (UNAVAILABLE_NAMESPACES.has(ns)) {
        // A component that subscribes on mount and unsubscribes on unmount
        // must survive both halves; throwing here would take the tree down
        // on the way up, before it could render its empty state. A call
        // handed a callback is a listen, so it gets a no-op unsubscribe.
        if (typeof last === "function") return () => {};
        return Promise.reject(
          new BridgeUnavailableError(`${key} is not available in the browser`),
        );
      }

      // 4. The transport.
      transport.start();
      if (listens && typeof last === "function") {
        // `pty.onOutput(paneId, cb)` and friends: the leading argument names
        // the pane, and one connection carries every pane.
        const subscriptionKey =
          args.length > 1 && typeof args[0] === "string" ? args[0] : undefined;
        return transport.subscribe(
          listens.ns,
          listens.event,
          subscriptionKey,
          last as BridgeListener,
        );
      }
      return transport.invoke(ns, name, args);
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

  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string" || NOT_MEMBERS.has(prop)) {
          return undefined;
        }
        // Synchronously, every time: forty-odd components branch on
        // `platform` while they render, and a promise is not a branch.
        if (prop === "platform") return transport.platform;
        // Not in `rootValues`: it is not a constant. A WebSocket host names
        // the connection in its hello reply, and names it again after a
        // reconnect (ADR-179 D3).
        if (prop === "rendererId") return transport.rendererId;
        if (hasOwn(transport.rootValues, prop)) {
          return transport.rootValues[prop];
        }
        return namespace(prop);
      },
    },
  ) as unknown as ElectronAPI;
}
