/**
 * One bridge method, and the rules dispatch applies to it (ADR-182 D3).
 *
 * Each `./handlers/<ns>.ts` exports its namespace as a table of these, so a
 * method and what is true of it — audited, refused to devices, carrying a
 * credential — are written on one line, and `./handlers.ts` derives the rule
 * sets from the tables instead of restating them.
 */

import type { HostDeps } from "../ipc/types";
import { LOCAL_ROUTE, type RouteRule } from "./routes";
import type { CallerClass, UnavailableCode, ViewerKind } from "./types";

// The route rules live in `./routes.ts` (ADR-228 D1) so the renderer can read
// them; the tables import them from here.
export {
  LOCAL_ROUTE,
  byAgent,
  byGhRepo,
  byHost,
  byPane,
  byProject,
  delegated,
  byWorkspaceKey,
  type RouteRule,
} from "./routes";

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
  /**
   * `local` = an Electron renderer window; `owner` = the desktop on a host
   * server's owner channel (ADR-225 D4); `device` = a paired `full` device.
   */
  callerClass: CallerClass;
  /**
   * A desktop window's own stream to a host server (ADR-228 D4): an `owner`
   * that ranks as the desk for the winsize and is its own layout origin.
   * Absent for everyone else.
   */
  viewer?: ViewerKind;
  /** The paired device behind a `device` caller; null/absent for `local`. */
  deviceId?: string | null;
}

/**
 * What every handler gets before its wire arguments.
 *
 * `D` is the deps the table runs over: the desktop's `HostDeps` by default,
 * or the host server's narrower `HostServerDeps` (ADR-225 D6). A handler
 * shared by both declares only the slice of deps it reads, so either can
 * call it.
 */
export interface HandlerCtx<D = HostDeps> {
  deps: D;
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
export type BridgeHandler<D = HostDeps> = (
  ctx: HandlerCtx<D>,
  ...args: never[]
) => unknown;

/**
 * A handler over any deps. `never` deps is the bottom of every `HandlerCtx`,
 * so each handler, whatever slice of deps it declares, is one of these: what
 * a table entry is constrained by, before a server says which deps it runs.
 */
type AnyBridgeHandler = BridgeHandler<never>;

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
  /**
   * Which host answers it on the desktop (ADR-227 D4): a `RouteRule`, or
   * `LOCAL_ROUTE` for one this server answers whatever host it touches.
   * Absent is local too; a routed namespace says so explicitly.
   */
  route?: RouteRule | typeof LOCAL_ROUTE;
}

export interface Method<
  F extends AnyBridgeHandler = AnyBridgeHandler,
  R extends MethodRules = MethodRules,
> {
  fn: F;
  rules: R;
}

/** A table entry. `const R` keeps the rules literal for the derived types. */
export function method<
  F extends AnyBridgeHandler,
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

/** The keys of `methods` whose entry carries `rule`. */
function ruleSet(
  methods: Record<string, Method>,
  rule: Exclude<keyof MethodRules, "route">,
): ReadonlySet<string> {
  return new Set(
    Object.entries(methods)
      .filter(([, entry]) => entry.rules[rule])
      .map(([key]) => key),
  );
}

/**
 * What a `BridgeServer` dispatches: `ns.method` → handler, the rule sets read
 * off the same entries, and what kind of server answers with it
 * (`./handlers.ts` for the desktop, `../host-server/handlers.ts` for a host
 * server).
 */
export interface HandlerTable<D> {
  handlers: Readonly<Record<string, BridgeHandler<D>>>;
  /** Refused to every caller class not in `localOnlyCallers` (ADR-180 D4). */
  localOnly: ReadonlySet<string>;
  /** Audited when a device calls them. */
  mutating: ReadonlySet<string>;
  /** First argument is a credential; never written to the audit line. */
  secretFirstArg: ReadonlySet<string>;
  /**
   * The methods that name their host in an argument (ADR-227 D4): what the
   * desktop's `forward` reads to send a call to a remote host's server.
   */
  routes: ReadonlyMap<string, RouteRule>;
  /**
   * How a method absent from the table (or refused as `localOnly`) is
   * answered: `unavailable:web`, "in the browser" on the desktop;
   * `unavailable:host`, "on this host" on a host server (ADR-225 D6).
   */
  unavailable: { code: UnavailableCode; where: string };
  /**
   * Who may call `localOnly` methods: a desktop window (`local`) on the
   * desktop, the owner channel (`owner`, ADR-225 D4) on a host server. A
   * device never; an owner reaching the desktop's server — which no desktop
   * transport makes — is refused them like a device.
   */
  localOnlyCallers: ReadonlySet<CallerClass>;
}

/**
 * A flattened table as the `HandlerTable` a server dispatches on.
 *
 * `D` is checked here: every entry's handler must run over `D`, so a handler
 * that reads more deps than its server has fails to compile at the table,
 * not at a caller's first call.
 */
export function toHandlerTable<D>(
  methods: Readonly<Record<string, Method<BridgeHandler<D>>>>,
  surface: Pick<HandlerTable<D>, "unavailable" | "localOnlyCallers">,
): HandlerTable<D> {
  return {
    handlers: Object.fromEntries(
      Object.entries(methods).map(([key, entry]) => [key, entry.fn]),
    ),
    localOnly: ruleSet(methods, "localOnly"),
    mutating: ruleSet(methods, "mutating"),
    secretFirstArg: ruleSet(methods, "secretFirstArg"),
    routes: new Map(
      Object.entries(methods).flatMap(([key, entry]) => {
        const route = entry.rules.route;
        return route && route !== LOCAL_ROUTE ? [[key, route] as const] : [];
      }),
    ),
    ...surface,
  };
}

/**
 * A context for a caller at this machine that is not a bridge connection —
 * a test, or a host-side path that calls a handler directly.
 */
export function localCtx<D = HostDeps>(deps: D, id = "local"): HandlerCtx<D> {
  return { deps, caller: { id, callerClass: "local" } };
}
