/**
 * One bridge method, and the rules dispatch applies to it (ADR-182 D3).
 *
 * Each `./handlers/<ns>.ts` exports its namespace as a table of these, so a
 * method and what is true of it — audited, refused to devices, carrying a
 * credential — are written on one line, and `./handlers.ts` derives the rule
 * sets from the tables instead of restating them.
 */

import type { HostDeps } from "../ipc/types";

/**
 * Who is calling, as the transport saw it — never as the frame says.
 *
 * `id` is the `BridgeConnection.id`: a desktop window's `webContents.id` as a
 * string, or a paired device's socket. It is what a pane viewer is held
 * under, what a layout command's origin names, and where a progress stream
 * addressed to "whoever asked" goes.
 */
export interface Caller {
  id: string;
  /** `local` = an Electron renderer window; `device` = a paired `full` device. */
  callerClass: "local" | "device";
}

/** What every handler gets before its wire arguments. */
export interface HandlerCtx {
  deps: HostDeps;
  caller: Caller;
}

/**
 * A handler the bridge may call.
 *
 * `never[]` rather than `unknown[]`: a handler declares the argument types it
 * actually wants, and parameter contravariance makes each one assignable to
 * this. The server widens it back to `unknown[]` at the single call site,
 * where the arguments really are whatever JSON arrived — which is why every
 * handler runs its own `assert*` validation.
 */
export type BridgeHandler = (ctx: HandlerCtx, ...args: never[]) => unknown;

export interface MethodRules {
  /**
   * A device's call leaves an audit line. Anything that starts or ends a
   * session, or moves state the *other* viewers of this host will see; not
   * what a viewer does to its own view. A `local` call is never audited.
   */
  mutating?: true;
  /**
   * The first argument is a credential, so the audit line never records it —
   * and `surface.ts` makes it a compile error to also be `mutating`.
   */
  secretFirstArg?: true;
  /**
   * Refused to a device, however `full` its tier, with the same
   * `unavailable:web` an absent method gets (ADR-180 D4). Mirrored for the
   * browser in `./local-only.ts`.
   */
  localOnly?: true;
}

export interface Method<
  F extends BridgeHandler = BridgeHandler,
  R extends MethodRules = MethodRules,
> {
  fn: F;
  rules: R;
}

/** A table entry. `const R` keeps the rules literal for the derived types. */
export function method<
  F extends BridgeHandler,
  const R extends MethodRules = Record<never, never>,
>(fn: F, rules?: R): Method<F, R> {
  return { fn, rules: rules ?? ({} as R) };
}

/** A namespace: method name → entry. */
type Table = Record<string, Method>;

/** Every `[ns.method, entry]` pair of a set of namespaces. */
type Entry<T extends Record<string, Table>> = {
  [NS in keyof T & string]: {
    [M in keyof T[NS] & string]: [`${NS}.${M}`, T[NS][M]];
  }[keyof T[NS] & string];
}[keyof T & string];

export type Flat<T extends Record<string, Table>> = {
  [E in Entry<T> as E[0]]: E[1];
};

/**
 * The namespaces as one `"ns.method"`-keyed table. A namespace key may itself
 * be dotted — `"git.push"` gives `git.push.start`, the one two-level path
 * the surface has.
 */
export function flatten<const T extends Record<string, Table>>(
  tables: T,
): Flat<T> {
  const flat: Record<string, Method> = {};
  for (const [ns, table] of Object.entries(tables)) {
    for (const [name, entry] of Object.entries(table)) {
      flat[`${ns}.${name}`] = entry;
    }
  }
  return flat as Flat<T>;
}

/**
 * A context for a caller at this machine that is not a bridge connection —
 * a test, or a host-side path that calls a handler directly.
 */
export function localCtx(deps: HostDeps, id = "local"): HandlerCtx {
  return { deps, caller: { id, callerClass: "local" } };
}
