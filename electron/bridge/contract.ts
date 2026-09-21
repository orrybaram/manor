/**
 * `ElectronAPI`'s bridge half, derived rather than written (ADR-182 D4).
 *
 * Every method a renderer calls on the host is a handler on the table in
 * `./handlers.ts`, and every listener is a row of `SUBSCRIPTIONS` in
 * `./events.ts`. The types below read both and produce the nested
 * `ns.method(...)` shape `window.electronAPI` has, so a handler's signature
 * *is* its client signature: change a parameter or a return type there, and
 * every caller in `src/` is checked against the change.
 *
 * Types only. `src/electron.d.ts` imports this, and the renderer bundles must
 * never pull the main process in behind a type.
 */

import type { HANDLERS } from "./handlers";
import type { EventName, SUBSCRIPTIONS, WireEventArgs } from "./events";

type Fn = (...args: never[]) => unknown;

/**
 * The table key that is not spelled like its `ElectronAPI` path.
 *
 * `sendAppCommandResult` has no namespace because it predates them, and the
 * table would not take a bare name — so the client maps it to
 * `appCommands.result` on the way out (`ROOT_INVOKES` in
 * `src/bridge/client.ts`) and this maps it back.
 */
type WireAliases = { "appCommands.result": "sendAppCommandResult" };

/** A table key, as the interface spells it. */
export type AsSurface<M extends string> = M extends keyof WireAliases
  ? WireAliases[M]
  : M;

/**
 * A handler's wire arguments: everything after the `ctx` the bridge supplies.
 * A handler that needs no context takes no parameters at all, and has none to
 * strip.
 */
type WireArgs<P extends unknown[]> = P extends [unknown, ...infer A] ? A : [];

/** One handler, as a renderer calls it: the ctx gone, the result a promise. */
type Client<F> = F extends (...args: infer P) => infer R
  ? (...args: WireArgs<P>) => Promise<Awaited<R>>
  : never;

/** `"git.push.start"` and `V` → `{ git: { push: { start: V } } }`. */
type Nest<Path extends string, V> = Path extends `${infer Head}.${infer Rest}`
  ? { [K in Head]: Nest<Rest, V> }
  : { [K in Path]: V };

type UnionToIntersection<U> = (
  U extends unknown ? (u: U) => void : never
) extends (i: infer I) => void
  ? I
  : never;

/**
 * An intersection of nested single-member objects, as one object. Functions
 * are leaves; anything else is a namespace, merged all the way down.
 */
type Merge<T> = T extends Fn ? T : { [K in keyof T]: Merge<T[K]> };

/** Every entry of a handler table, as the nested namespaces a client sees. */
export type ClientOf<T> = Merge<
  UnionToIntersection<
    { [K in keyof T & string]: Nest<AsSurface<K>, Client<T[K]>> }[keyof T &
      string]
  >
>;

/** A callback for event `W`, called with what `W` is published with. */
type Callback<W extends EventName> = (...args: WireEventArgs<W>) => void;

/**
 * One listener. The PTY stream's events are per pane, so their listeners
 * name the pane first; every other event is about the machine. Either way
 * the answer is the unsubscribe.
 */
type Listener<W extends EventName> = W extends `pty.${string}`
  ? (paneId: string, callback: Callback<W>) => () => void
  : (callback: Callback<W>) => () => void;

/** Every row of a subscription table, as the nested listeners it declares. */
export type ListenersOf<S extends Record<string, EventName>> = Merge<
  UnionToIntersection<
    { [L in keyof S & string]: Nest<L, Listener<S[L]>> }[keyof S & string]
  >
>;

/**
 * What the host answers, over either transport: every table method and every
 * listener, merged into one set of namespaces.
 */
export type BridgeApi = Merge<
  ClientOf<typeof HANDLERS> & ListenersOf<typeof SUBSCRIPTIONS>
>;
