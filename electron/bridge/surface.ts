/**
 * Every method of `ElectronAPI`, placed — checked by the compiler (ADR-180 D7).
 *
 * `src/electron.d.ts` is the contract: 206 methods that the desktop renderer
 * and a browser tab both call through `window.electronAPI`. Nothing at
 * runtime knows that list. The client in the page is a `Proxy` (ADR-180 D3)
 * and cannot be — it turns *any* `ns.method(...)` into a frame, so a method
 * nobody implemented is not a missing function, it is a frame the host
 * answers `unavailable:web` to, in a browser somebody opened a week later. A
 * 140-method migration through a waist that narrow needs a check that runs
 * before the browser does.
 *
 * So this file derives the surface from the interface at the type level and
 * asserts that every method of it is **placed**: served by something, on
 * every platform that has it. The four places a method can be served are the
 * whole of the host surface, and adding one is a design decision:
 *
 * | placement           | who answers | where it is written |
 * | ------------------- | ----------- | ------------------- |
 * | `TableMethod`       | the host, over either transport | `HANDLERS` in `./handlers.ts` |
 * | `NativeMethod`      | the preload, in the renderer process | `nativeApi` in `../preload.ts` |
 * | `LocallyServedMethod` | the browser tab itself | `LOCALLY_SERVED` in `src/bridge/unavailable.ts` |
 * | `SubscriptionMethod` | the host, as a pushed event | `SUBSCRIPTIONS` below |
 *
 * **Why four and not D7's three.** D7 named the first three. The fourth is
 * what writing the check found: a `ns.onX(cb)` is not a table entry and never
 * was — it is a `subscribe` frame and an event somebody has to publish
 * (D5) — so the three sets left all twenty-five non-native subscriptions
 * unplaced, which is exactly the hole D5's own risk paragraph describes: *"a
 * `webContents.send` that nobody converts is a feature that quietly stops
 * updating"*. `SUBSCRIPTIONS` is that list, and adding a listener to
 * `ElectronAPI` now means naming the event it listens for.
 *
 * **What the check cannot see.** Three things, and they are worth knowing
 * before trusting it:
 *
 * 1. *That an event is ever published.* `SUBSCRIPTIONS` says
 *    `preferences.onChange` hears `preferences.changed`; that some
 *    `publishRendererBroadcast("preferences", "changed", …)` exists is only
 *    checked by `src/bridge/__tests__/resolution.test.ts` agreeing with the
 *    client's naming rule, not by anything that reads the publisher.
 * 2. *That a handler's signature matches the interface's.* `BridgeHandler`
 *    takes `never[]` on purpose (see `./handlers.ts`), because the arguments
 *    really are whatever arrived; each handler's `assert*` validation is what
 *    stands in for the types here.
 * 3. *That an optional argument survives the wire.* An argument nobody passed
 *    arrives as `undefined` over IPC and as `null` over the socket, and a
 *    default parameter only fires for `undefined` — which is how ADR-180
 *    ticket 10 nearly shipped `gh issue list --limit null` to the first
 *    browser that opened the issue picker. Both callers satisfy the same
 *    signature, so no type can tell them apart: it stays a thing handlers
 *    guard with `?? undefined`, and it stays unguarded by this file.
 *
 * **When this file errors.** It names the method. That is the whole payload:
 *
 * ```
 * surface.ts(260,14): error TS2322: Type 'boolean' is not assignable to type
 * 'Complaint<"ADR-180 D7 — place this method: HANDLERS, nativeApi,
 * LOCALLY_SERVED or SUBSCRIPTIONS", "pty.frobnicate">'.
 * ```
 *
 * means you added `pty.frobnicate` to `ElectronAPI` and nothing serves it.
 * Pick a row of the table above and put it there; widening the check is how
 * the drift comes back.
 *
 * Nothing here exists at runtime but `SUBSCRIPTIONS` — every import is a
 * type, so a browser bundle that reads the catalogue does not pull the main
 * process in behind it.
 *
 * **Nothing runs `tsc` in CI today** (`pnpm build` is Vite, which strips
 * types; `pnpm test` is Vitest, which does not typecheck), so this check
 * bites in an editor and under `npx tsc -p tsconfig.electron.json`. Making it
 * bite in CI means clearing that config's error baseline first.
 */

import type { ElectronAPI } from "../../src/electron";
import type {
  HandlerMethod,
  MutatingMethod,
  SecretFirstArgMethod,
} from "./handlers";
import type {
  LocallyServedMethod as TabMethod,
  UnavailableNamespace,
} from "../../src/bridge/unavailable";
import type { NativeApi } from "../preload";

/**
 * A member that is a method, for `Methods` below. `never[]` rather than
 * `unknown[]` for the same reason `BridgeHandler` uses it: every real
 * signature is assignable to it, and `Function` is banned by the lint rules.
 */
type Fn = (...args: never[]) => unknown;

/**
 * Every `ns.method` of an interface, as a string union — the surface, derived
 * rather than listed.
 *
 * Recursive, because `git.push.start` is a member of a member: a property
 * that is a function is a method, a property that is an object is a
 * namespace, and anything else (`platform`, `claim`, `env`) contributes
 * nothing. A root-level function keeps its bare name, which is what
 * `onProjectsChanged` and `sendAppCommandResult` are.
 *
 * `Depth` bounds the recursion at three levels — `git.push.start` is the
 * deepest thing the surface has ever had, and an unbounded version is a
 * `TS2589` ("excessively deep") on an interface this wide. A fourth level
 * would simply not be seen, which is the one way this check can be too
 * narrow: nest a namespace three deep and widen the counter.
 */
type Depth = [never, 0, 1, 2];

export type Methods<T, D extends 0 | 1 | 2 | 3 = 3> = D extends 0
  ? never
  : {
      [N in Extract<keyof T, string>]: NonNullable<T[N]> extends Fn
        ? N
        : NonNullable<T[N]> extends object
          ? `${N}.${Methods<NonNullable<T[N]>, Depth[D]> & string}`
          : never;
    }[Extract<keyof T, string>];

/** The contract, whole. */
export type Surface = Methods<ElectronAPI>;

/**
 * Host→renderer events, by the method that listens for them.
 *
 * The other three placements are lists that already existed for their own
 * reasons; this one is written here because there was nowhere else it could
 * be. The host publishes `ns.event` (`renderer-broadcast.ts`, and the PTY
 * stream); the client turns `ns.onEvent(cb)` into a `subscribe` frame by a
 * naming rule with a short exception table (`SUBSCRIPTION_EVENTS` in
 * `src/bridge/client.ts`). Neither side holds the pairing, so neither side
 * can tell you that a listener nobody publishes for is dead code.
 *
 * The value is the wire name, `ns.event`, and it is not decoration:
 * `resolution.test.ts` asserts that the client resolves each key to exactly
 * this string, so a change to the naming rule fails a test rather than
 * silently retiring a subscription. What remains unchecked is the publisher —
 * see this file's header.
 *
 * `pty.*` are the six the daemon's stream carries plus `winsizeOwner`, and
 * are the only ones with a key (the `paneId`). The two root entries predate
 * the namespaces around them and are aliased on the wire, like
 * `sendAppCommandResult` below. Native subscriptions are *not* here:
 * `webview.*`, `updater.*` and `menu.onMenuCommand` are members of a native
 * namespace and placed by being written in the preload.
 */
export const SUBSCRIPTIONS = {
  "pty.onOutput": "pty.output",
  "pty.onExit": "pty.exit",
  "pty.onCwd": "pty.cwd",
  "pty.onResized": "pty.resized",
  "pty.onError": "pty.error",
  "pty.onAgentStatus": "pty.agentStatus",
  "pty.onWinsizeOwner": "pty.winsizeOwner",
  "layout.onChanged": "layout.changed",
  "projects.onRemoveWorktreeProgress": "projects.removeWorktreeProgress",
  "projects.onWorktreeSetupProgress": "projects.worktreeProgress",
  "theme.onChanged": "theme.changed",
  "ports.onChange": "ports.changed",
  "branches.onChange": "branches.changed",
  "diffs.onChange": "diffs.changed",
  "git.push.onProgress": "git.push.progress",
  "agents.onUpdate": "agents.updated",
  "preferences.onChange": "preferences.changed",
  "keybindings.onChange": "keybindings.changed",
  "keybindings.onForwardedCommand": "keybindings.forwardedCommand",
  "notifications.onChanged": "notifications.changed",
  "notifications.onNavigate": "notifications.navigate",
  "stats.onChanged": "stats.changed",
  "remoteControl.onStatus": "remoteControl.status",
  /** The root pair (`ROOT_SUBSCRIPTIONS` in `src/bridge/client.ts`). */
  onProjectsChanged: "projects.changed",
  onAppCommand: "appCommands.command",
} as const;

/** A listener on the contract, answered by an event frame. */
export type SubscriptionMethod = keyof typeof SUBSCRIPTIONS;

/**
 * The table key that is not an `ElectronAPI` method name.
 *
 * `sendAppCommandResult` has no namespace because it predates them, and the
 * table would not take a bare name — so the client maps it to
 * `appCommands.result` on the way out (`ROOT_INVOKES` in
 * `src/bridge/client.ts`) and this maps it back, so that everything below is
 * compared in one vocabulary: the interface's.
 */
type WireAliases = { "appCommands.result": "sendAppCommandResult" };

/** A wire name, as the interface spells it. */
type AsSurface<M extends string> = M extends keyof WireAliases
  ? WireAliases[M]
  : M;

/** On the handler table: answered by the host, over either transport. */
export type TableMethod = AsSurface<HandlerMethod>;

/** In the preload: answered in the renderer process, desktop only. */
export type NativeMethod = Methods<NativeApi>;

/** Answered by the browser tab, without asking anybody. */
export type LocallyServedMethod = TabMethod;

/** Served by something, somewhere. */
export type PlacedMethod =
  | TableMethod
  | NativeMethod
  | LocallyServedMethod
  | SubscriptionMethod;

/**
 * The error message, carrying the method that caused it.
 *
 * A bare `Unplaced extends never ? true : false` would report that `true` is
 * not assignable to `false`, which is accurate and useless. An object type
 * keyed by a sentence puts both the complaint and the method into the text
 * the compiler prints, so the error explains itself where it is read — in a
 * terminal, or in a tooltip, by somebody who has never opened this file.
 */
type Complaint<Problem extends string, M extends string> = Record<Problem, M>;

/** Nowhere to be found: on the contract, and nothing answers it. */
type Unplaced = Exclude<Surface, PlacedMethod>;

/** Answered, but not on the contract: a dead table entry, or a typo in one. */
type Unknown_ = Exclude<PlacedMethod, Surface>;

/**
 * On the table *and* in the preload. Not a harmless duplicate: the client
 * resolves native first (`src/bridge/client.ts`), so the desktop would keep
 * using the preload copy while a paired device used the table's — two
 * implementations of one method, drifting, which is the whole condition
 * ADR-180 exists to end.
 */
type ServedTwice = TableMethod & NativeMethod;

/**
 * Reachable on the desktop and nowhere on the web, in a namespace a browser
 * does not refuse outright — the `unavailable:web` D7 promises nobody should
 * discover by opening a browser.
 */
type WebHole = Exclude<
  Surface,
  | TableMethod
  | LocallyServedMethod
  | SubscriptionMethod
  | `${UnavailableNamespace}.${string}`
>;

/**
 * The four assertions. Each is `true` when the set behind it is empty, and
 * when it is not, the type error names the offending method.
 *
 * They are `const`s rather than `type`s because a failed type-level
 * constraint says "does not satisfy the constraint" and points at the
 * constraint; a failed assignment points at the value, and prints the method
 * name in the type it would have had to be.
 */
export const _unplaced: Unplaced extends never
  ? true
  : Complaint<
      "ADR-180 D7 — place this method: HANDLERS, nativeApi, LOCALLY_SERVED or SUBSCRIPTIONS",
      Unplaced
    > = true;

export const _unknown: Unknown_ extends never
  ? true
  : Complaint<
      "ADR-180 D7 — nothing on ElectronAPI is named this; rename it or delete it",
      Unknown_
    > = true;

export const _servedTwice: ServedTwice extends never
  ? true
  : Complaint<
      "ADR-180 D7 — on the handler table and in the preload; the desktop would never reach the table's copy",
      ServedTwice
    > = true;

export const _webHole: WebHole extends never
  ? true
  : Complaint<
      "ADR-180 D7 — no browser can reach this and none refuses it; put it on the table, in LOCALLY_SERVED, or in a namespace UNAVAILABLE_NAMESPACES names",
      WebHole
    > = true;

/**
 * And the one rule about the audit log that is a type rather than a test: a
 * method whose first argument is a credential may never be `MUTATING`,
 * because `bridgeTarget` writes an audited call's first string argument into
 * `remote-audit.log`. `linear.connect` is the one, and `SECRET_FIRST_ARG` in
 * `./handlers.ts` is where that is said in full.
 */
type AuditedSecret = Extract<SecretFirstArgMethod, MutatingMethod>;

export const _auditedSecret: AuditedSecret extends never
  ? true
  : Complaint<
      "ADR-180 D4 — this method's first argument is a credential and MUTATING would write it to the audit log",
      AuditedSecret
    > = true;
