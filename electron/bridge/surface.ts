/**
 * What the compiler checks about the host surface that derivation cannot
 * (ADR-180 D7, ADR-182 D4).
 *
 * `ElectronAPI` is built from its parts (`src/electron.d.ts`): the handler
 * table, the preload's `nativeApi` and `SUBSCRIPTIONS`, each method with the
 * signature its implementation declares. So every method of it is served by
 * something by construction, and its arguments and results are checked at
 * every call site. What no derivation can say is whether the parts agree with
 * *each other* and with the browser — which is what this file asserts:
 *
 * - nothing is served twice, by the table and the preload;
 * - every method has an answer in a browser, or is in a namespace the browser
 *   refuses whole;
 * - the tab's own `LOCALLY_SERVED` list names only methods that exist;
 * - the table's rules are consistent: no audited credential, the local-only
 *   flags match `./local-only.ts`, and each local-only method has a browser
 *   answer.
 *
 * **When this file errors.** It names the method:
 *
 * ```
 * surface.ts(120,14): error TS2322: Type 'boolean' is not assignable to type
 * 'Complaint<"ADR-180 D7 — no browser can reach this …", "shell.frobnicate">'.
 * ```
 *
 * means `shell.frobnicate` has no answer in a browser. Fix the placement the
 * message names; widening the check is how the drift comes back.
 *
 * **What it cannot see.** That an event is ever published: `SUBSCRIPTIONS`
 * says `preferences.onChange` hears `preferences.changed`, and the typed
 * publishers refuse an undeclared event, but nothing proves some publisher
 * exists. And that an optional argument survives the wire: one nobody passed
 * arrives as `undefined` over IPC and as `null` over the socket, and a
 * default parameter only fires for `undefined`, so handlers guard it with
 * `?? undefined` — no type can tell the two callers apart.
 *
 * Every import is a type. It runs in `pnpm typecheck`, which `pnpm build`
 * runs first.
 */

import type { ElectronAPI } from "../../src/electron";
import type { AsSurface } from "./contract";
import type { SubscriptionMethod } from "./events";
import type {
  HandlerMethod,
  MutatingMethod,
  SecretFirstArgMethod,
  TableLocalOnlyMethod,
} from "./handlers";
import type { LocalOnlyMethod } from "./local-only";
import type {
  HostRefusedMethod,
  LocallyServedMethod,
  UnavailableNamespace,
} from "../../src/bridge/unavailable";
import type { NativeApi } from "../preload";

/**
 * A member that is a method, for `Methods` below. `never[]` rather than
 * `unknown[]` because every real signature is assignable to it, and
 * `Function` is banned by the lint rules.
 */
type Fn = (...args: never[]) => unknown;

/**
 * Every `ns.method` of an interface, as a string union.
 *
 * Recursive, because `git.push.start` is a member of a member: a property
 * that is a function is a method, a property that is an object is a
 * namespace, and anything else (`platform`, `claim`, `env`) contributes
 * nothing. `Depth` bounds the recursion at three levels — `git.push.start` is
 * the deepest the surface has — because an unbounded version is a `TS2589`
 * on a type this wide.
 */
type Depth = [never, 0, 1, 2];

type Methods<T, D extends 0 | 1 | 2 | 3 = 3> = D extends 0
  ? never
  : {
      [N in Extract<keyof T, string>]: NonNullable<T[N]> extends Fn
        ? N
        : NonNullable<T[N]> extends object
          ? `${N}.${Methods<NonNullable<T[N]>, Depth[D]> & string}`
          : never;
    }[Extract<keyof T, string>];

/** The contract, whole. */
type Surface = Methods<ElectronAPI>;

/** On the handler table: answered by the host, over either transport. */
type TableMethod = AsSurface<HandlerMethod>;

/** In the preload: answered in the renderer process, desktop only. */
type NativeMethod = Methods<NativeApi>;

/**
 * The error message, carrying the method that caused it: an object type
 * keyed by a sentence puts both into the text the compiler prints.
 */
type Complaint<Problem extends string, M extends string> = Record<Problem, M>;

/**
 * On the table *and* in the preload. Not a harmless duplicate: the client
 * resolves native first (`src/bridge/client.ts`), so the desktop would keep
 * using the preload copy while a paired device used the table's — two
 * implementations of one method, drifting.
 */
type ServedTwice = TableMethod & NativeMethod;

export const _servedTwice: ServedTwice extends never
  ? true
  : Complaint<
      "ADR-180 D7 — on the handler table and in the preload; the desktop would never reach the table's copy",
      ServedTwice
    > = true;

/**
 * Reachable on the desktop and nowhere on the web, in a namespace a browser
 * does not refuse outright — the `unavailable:web` nobody should discover by
 * opening a browser.
 */
type WebHole = Exclude<
  Surface,
  | TableMethod
  | LocallyServedMethod
  | SubscriptionMethod
  | `${UnavailableNamespace}.${string}`
>;

export const _webHole: WebHole extends never
  ? true
  : Complaint<
      "ADR-180 D7 — no browser can reach this and none refuses it; put it on the table, in LOCALLY_SERVED, or in a namespace UNAVAILABLE_NAMESPACES names",
      WebHole
    > = true;

/** Served by the tab, and not on the contract: a dead entry, or a typo in one. */
type UnknownLocal = Exclude<LocallyServedMethod, Surface>;

export const _unknownLocal: UnknownLocal extends never
  ? true
  : Complaint<
      "ADR-180 D7 — nothing on ElectronAPI is named this; rename it or delete it from SERVED_HERE",
      UnknownLocal
    > = true;

/**
 * A method whose first argument is a credential may never be `mutating`,
 * because `bridgeTarget` writes an audited call's first string argument into
 * `remote-audit.log`. `linear.connect` is the one.
 */
type AuditedSecret = Extract<SecretFirstArgMethod, MutatingMethod>;

export const _auditedSecret: AuditedSecret extends never
  ? true
  : Complaint<
      "ADR-180 D4 — this method's first argument is a credential and MUTATING would write it to the audit log",
      AuditedSecret
    > = true;

/**
 * The tables' `localOnly` flags and `./local-only.ts` are one fact in two
 * places — dispatch reads the flags, the browser reads the list, and the
 * browser may not import the tables. Either both name a method or neither
 * does.
 */
type LocalOnlyDrift =
  | Exclude<TableLocalOnlyMethod, LocalOnlyMethod>
  | Exclude<LocalOnlyMethod, TableLocalOnlyMethod>;

export const _localOnlyDrift: LocalOnlyDrift extends never
  ? true
  : Complaint<
      "ADR-182 D3 — flag this method localOnly in its table and list it in local-only.ts, or do neither",
      LocalOnlyDrift
    > = true;

/**
 * Every local-only method has a browser answer: the tab serves it itself
 * (`SERVED_HERE`), or the tab leaves it to the host's refusal on purpose
 * (`HostRefusedMethod`). A new one in neither is a method a browser would ask
 * for and be refused without anybody having decided that it should.
 */
type LocalOnlyUnanswered = Exclude<
  AsSurface<LocalOnlyMethod>,
  LocallyServedMethod | HostRefusedMethod
>;

export const _localOnlyUnanswered: LocalOnlyUnanswered extends never
  ? true
  : Complaint<
      "ADR-182 D3 — give this local-only method a browser answer: SERVED_HERE, or HostRefusedMethod",
      LocalOnlyUnanswered
    > = true;
