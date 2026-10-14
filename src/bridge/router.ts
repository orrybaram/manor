/**
 * `window.electronAPI` over a set of servers (ADR-228 D1).
 *
 * Renderer code calls one `ElectronAPI`, as it always has. Behind it is no
 * longer one bridge but the page's server set (`./server-set.ts`), and this
 * router decides which of them answers each call, by the route manifest
 * (`electron/bridge/routes.ts`) that main's `HostRouting` reads too:
 *
 * - **Served at home.** A native namespace, a method the home transport
 *   serves itself (a browser's viewport and clipboard) and a namespace refused
 *   in a browser go to the home server's bridge, which handles them exactly
 *   as before. A host server's socket transport would answer those for a
 *   browser it is not, so no other server is ever asked.
 * - **Routed** (`RouteRule`). The host the named argument points at, read off
 *   the renderer's own stores (`./host-lookups.ts`), answered by that host's
 *   **source** (D3): a direct bridge to it if one is reachable, else a server
 *   that lists it, else none — and a call for a host with no source is
 *   refused with `unavailable:host-away`. Arguments go out in the server's
 *   form and the answer comes back in the renderer's (`host-rewrite.ts`).
 * - **Merged** (`"merge"`). Every server is asked; each one's answer is
 *   stamped with renderer host ids (D2), its records for a host whose source
 *   is another server are dropped, and the rest are merged. A project's
 *   group is the desktop's (D3). A server that is away, or fails, contributes
 *   its last answer (D6), kept here in memory — and, on the phone, in
 *   IndexedDB (`RouterOptions.lastKnown`), so a reload while it is away
 *   still shows it.
 * - **Home.** Everything else.
 *
 * **Renderer host ids (D2).** On the desktop the local server is `local` and
 * a host server is the desktop's own id for that host, which is what every
 * record already says. On the phone every server is named by its room: a
 * server's `local` becomes its room id, and a host a desktop lists becomes
 * that host's room (`ServerEntry.aliases`, from the desktop's `hosts.list`),
 * or `<desktop room>~<hostId>` when it reports none. Every call to such a
 * server, home calls included, has its arguments turned back into that
 * server's own ids (`toServerArgs`) and its answer stamped (`stampResult`).
 *
 * **Subscriptions.** A listener of a merged namespace (`layout`, `projects`,
 * `agents`) is opened on every server, replayed on one that joins later, and
 * its events are stamped and deduplicated like a merged answer. A pane's
 * `chat.*` and `pty.*` are opened only on the pane's source, keyed by server
 * and pane; a pane id two servers' layouts both hold is refused rather than
 * cross-wired. Any other listener is home's.
 *
 * **What main did on the way, done here.** A call that used to reach a host
 * through main's `HostRouting` picked up a few things there that a direct
 * call must get here instead: a queued command for a pane no layout holds
 * yet travels with the layout command that adds it (`setPendingCommand`
 * below), a project the host answers with carries the desktop's group, and a
 * layout broadcast's origin names this window, not its stream to the host.
 *
 * **The desktop's own server alone is a pass-through.** With only it in the
 * set — every desktop window, until a host server joins — each call is
 * handed to it as it was given and its answer returned untouched: no
 * resolving, no re-stamping, no copying. Main still merges remote hosts
 * itself (`HostRouting`), so that is exactly what the stores got before. A
 * phone's lone pairing is stamped all the same, so its ids do not change
 * when a second one joins.
 */

import { keyFor } from "../../electron/bridge/host-rewrite";
import { byPane, ROUTES, type RouteRule } from "../../electron/bridge/routes";
import { BridgeUnavailableError } from "../../electron/bridge/settle";
import { UNAVAILABLE_HOST_AWAY_CODE, UNAVAILABLE_HOST_CODE } from "../../electron/bridge/types";
import { parseChatTaskKey } from "../../electron/chat-mirror/task-key";
import type { ElectronAPI } from "../electron";
import type { LayoutEntry } from "../lib/layout/protocol";
import { layoutPaneIds } from "../lib/layout/workspace-layout";
import {
  LOCAL_HOST_ID,
  normalizeHostId,
  parseWorkspaceKey,
} from "../lib/workspace-key";
import { BridgeDisconnectedError, LISTENERS, NOT_MEMBERS, servesItself } from "./client";
import { hostLookups } from "./host-lookups";
import { linearServers, type LinearChoice } from "./linear-servers";
import type { LastKnownStore } from "./last-known";
import { servers, viaServer, type ServerEntry, type ServerSet } from "./server-set";

/** Which host a routed call is for. */
export interface HostResolver {
  /**
   * The renderer host id the argument `rule` names points at, or null when
   * the renderer does not know — which the home server answers, as main's
   * `HostRouting` answers what it does not know itself.
   */
  hostOf(rule: RouteRule, args: readonly unknown[]): string | null;
}

/** `hostOf`, read off the stores' lookups. */
export const storeResolver: HostResolver = {
  hostOf(rule, args) {
    // A delegated call names no host; the caller says (`onBehalfOf`).
    if (rule.by === "delegated") return null;
    const arg = args[rule.arg];
    const lookups = hostLookups();
    switch (rule.by) {
      case "project":
        return typeof arg === "string" ? (lookups.project?.(arg) ?? null) : null;
      case "workspaceKey":
        return typeof arg === "string" ? parseWorkspaceKey(arg).hostId : null;
      case "pane": {
        if (typeof arg !== "string") return null;
        const key = lookups.paneWorkspace?.(arg);
        if (key) return parseWorkspaceKey(key).hostId;
        const known = lookups.paneHost?.(arg);
        if (known) return known;
        // A pane no layout holds yet: the host its create names.
        const opts = rule.hostOpt === undefined ? null : args[rule.hostOpt];
        const named = isPlainObject(opts) ? opts.hostId : null;
        return typeof named === "string" && named ? named : null;
      }
      case "agent":
        return typeof arg === "string" ? (lookups.agent?.(arg) ?? null) : null;
      case "host":
        return typeof arg === "string" && arg ? arg : LOCAL_HOST_ID;
      case "ghRepo": {
        const hostId =
          typeof arg === "object" && arg !== null
            ? (arg as { hostId?: unknown }).hostId
            : null;
        return normalizeHostId(typeof hostId === "string" ? hostId : null);
      }
    }
  },
};

/** The namespaces with a merged read: their listeners fan out. */
const FAN_OUT_NAMESPACES: ReadonlySet<string> = new Set(
  Object.entries(ROUTES)
    .filter(([, route]) => route === "merge")
    .map(([key]) => key.slice(0, key.lastIndexOf("."))),
);

/**
 * The namespaces whose listeners are keyed by pane (`electron/bridge/events.ts`)
 * and whose calls route by pane: their listeners go to the pane's source.
 */
const PANE_NAMESPACES: ReadonlySet<string> = new Set(
  ["pty", "chat"].filter((ns) =>
    Object.entries(ROUTES).some(
      ([key, route]) =>
        key.startsWith(`${ns}.`) && typeof route === "object" && route.by === "pane",
    ),
  ),
);

const PANE_RULE = byPane(0);

/**
 * How long a queued command for a pane no layout holds yet waits for the
 * layout command that adds the pane, before it goes home anyway.
 */
const HOLD_PENDING_MS = 5_000;

type Fn = (...args: unknown[]) => unknown;

/** `bridge.<ns path>.<name>`, as callable. */
function memberOf(bridge: ElectronAPI, ns: string, name: string): Fn {
  let owner = bridge as unknown as Record<string, unknown>;
  for (const segment of ns.split(".")) {
    owner = owner[segment] as Record<string, unknown>;
  }
  return owner[name] as Fn;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every string in `value`, however deep: a layout command's pane ids among them. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (isPlainObject(value)) for (const item of Object.values(value)) stringsIn(item, out);
  return out;
}

/** A stable key for one call's arguments, for its last-known answer. */
function callKey(key: string, args: readonly unknown[]): string {
  try {
    return `${key}:${JSON.stringify(args)}`;
  } catch {
    return key;
  }
}

/** One server's answer to a merged read, in the renderer's form. */
interface Answer {
  entry: ServerEntry;
  value: unknown;
}

/** A listener opened on every server. */
interface FanSub {
  ns: string;
  name: string;
  /** The event it hears, for stamping. */
  event: { ns: string; event: string };
  args: unknown[];
  listener: Fn;
  offs: Map<string, () => void>;
}

/** A listener opened on one pane's source. */
interface PaneSub {
  ns: string;
  name: string;
  paneId: string;
  args: unknown[];
  listener: Fn;
  /** The server it is open on, and how to close it there. */
  serverId: string | null;
  off: (() => void) | null;
}

/** The host a delegated call is being made for, while its dispatch runs. */
let delegatedHost: string | null = null;

/**
 * Run `call`, a `linear.*` call, on behalf of `hostId` (ADR-228 D10): the
 * router picks that host's Linear server (`linearServerFor`) rather than
 * the page's. The call is dispatched synchronously, so the host is read
 * before this returns. Null is no host: browsing.
 */
export function onBehalfOf<T>(hostId: string | null | undefined, call: () => T): T {
  const was = delegatedHost;
  delegatedHost = hostId ? normalizeHostId(hostId) : null;
  try {
    return call();
  } finally {
    delegatedHost = was;
  }
}

/**
 * The server a Linear call for `hostId` goes to, or the reason there is none:
 * the host's own server if it has Linear, else the desktop that lists the
 * host, else a refusal. No host: home first, then any server with Linear.
 */
export function linearServerFor(
  hostId: string | null,
  set: ServerSet = servers,
): Promise<LinearChoice> {
  return linearServers(set).choose(hostId);
}

export interface RouterOptions {
  /**
   * Where each server's last answers outlive the page (D6): the phone's
   * IndexedDB (`./last-known.ts`). Without it they are kept in memory only.
   */
  lastKnown?: LastKnownStore;
}

export function createRouter(
  set: ServerSet,
  resolver: HostResolver = storeResolver,
  options: RouterOptions = {},
): ElectronAPI {
  const persisted = options.lastKnown ?? null;
  /** Each server's saved answers, read in once: settles, never rejects. */
  const restoring = new Map<string, Promise<void>>();
  /** Each server's last answer to each merged read (D6). */
  const lastKnown = new Map<string, Map<string, unknown>>();
  /** Each server's panes, by workspace, as its merged layout says. */
  const panesByServer = new Map<string, Map<string, Set<string>>>();
  const fanSubs = new Set<FanSub>();
  const paneSubs = new Set<PaneSub>();
  /**
   * `layout.setPendingCommand` for panes no layout holds yet, by pane: the
   * renderer cannot tell which server the pane will be on until the layout
   * command that adds it goes out, so the queued line waits for it and goes
   * to the same server first — what main's `HostRouting` does for a pane it
   * cannot place (`movePendingCommands`).
   */
  const heldCommands = new Map<
    string,
    { args: unknown[]; timer: ReturnType<typeof setTimeout> }
  >();
  /** Each project's group, from the desktop's last `projects.getAll` (D3). */
  let desktopGroups = new Map<unknown, unknown>();
  /**
   * The desktop's claims on each workspace, as home last said them (D7): a
   * tab a detached window holds is the desktop's to know, and no host
   * server's layout carries it.
   */
  const homeClaims = new Map<string, unknown>();
  /**
   * The layout each workspace's answerer last gave, for a claim that moved
   * on a workspace home does not answer for: told again with it.
   */
  const lastLayouts = new Map<string, { version: unknown; layout: unknown }>();
  let members = new Map(set.list().map((entry) => [entry.id, entry.bridge]));

  // ── sources (D3) ──

  function isHome(entry: ServerEntry): boolean {
    return entry.id === set.homeId;
  }

  /**
   * Whether `entry` can be asked now. The desktop's own server always can,
   * and so can a lone server: its own transport queues, retries and refuses
   * as it did when it was the page's only bridge, and a router that refused
   * for it would change that. A phone's home among others is one server of
   * several: away is away (D6).
   */
  function reachable(entry: ServerEntry): boolean {
    if (entry.reachability !== "unreachable") return true;
    return isHome(entry) && (native(entry) || set.list().length === 1);
  }

  /**
   * Whether calls go to home as they are: the desktop's own server alone in
   * the set, whose answers are already in the renderer's form. A phone's
   * server is stamped even alone (D2), so its ids do not change when a
   * second pairing joins.
   */
  function passThrough(): boolean {
    return set.list().length === 1 && native(set.home());
  }

  function lists(entry: ServerEntry, hostId: string): boolean {
    return entry.lists === "all" || entry.lists.has(hostId);
  }

  /** The server answering for `hostId` now, or null: it is away (D3). */
  function sourceOf(hostId: string): ServerEntry | null {
    const direct = set.get(hostId);
    if (direct && reachable(direct)) return direct;
    for (const entry of set.list()) {
      if (entry.id !== hostId && lists(entry, hostId) && reachable(entry)) {
        return entry;
      }
    }
    // The home server's own machine, under the name its records use.
    if (hostId === LOCAL_HOST_ID) return set.home();
    return null;
  }

  /**
   * Whose answer about `hostId` the merge keeps: its source, or — every
   * source away — whoever answered for it last, its own server first.
   */
  function answerer(hostId: string): ServerEntry {
    return sourceOf(hostId) ?? set.get(hostId) ?? set.home();
  }

  /** The host a record in `entry`'s answer is about, once stamped. */
  function hostOfRecord(record: unknown, entry: ServerEntry): string {
    const hostId = isPlainObject(record) ? record.hostId : undefined;
    const id = normalizeHostId(typeof hostId === "string" ? hostId : null);
    return id === LOCAL_HOST_ID ? entry.id : id;
  }

  /**
   * Whether `entry` is the one answering for `hostId`. By id: an entry is a
   * new object on every change of its facts, and an answer that left before
   * its server's hello comes back after it.
   */
  function answersFor(entry: ServerEntry, hostId: string): boolean {
    return answerer(hostId).id === entry.id;
  }

  function kept(record: unknown, entry: ServerEntry): boolean {
    return answersFor(entry, hostOfRecord(record, entry));
  }

  function hostOfKey(key: string, entry: ServerEntry): string {
    const hostId = parseWorkspaceKey(key).hostId;
    return hostId === LOCAL_HOST_ID ? entry.id : hostId;
  }

  function hostOfPane(paneId: string, entry: ServerEntry): string {
    return resolver.hostOf(PANE_RULE, [paneId]) ?? entry.id;
  }

  function awayError(hostId: string): BridgeUnavailableError {
    const name = set.get(hostId)?.hello.name ?? hostId;
    return new BridgeUnavailableError(`${name} is offline`, UNAVAILABLE_HOST_AWAY_CODE);
  }

  // ── stamping (D2) ──

  /**
   * Whether `entry`'s answers are already in the renderer's form: the
   * desktop's own server, whose ids are the ones the stores have always held.
   */
  function native(entry: ServerEntry): boolean {
    return entry.id === LOCAL_HOST_ID;
  }

  /**
   * The renderer's id for a host `entry` calls `hostId`: its own machine is
   * `entry.id`; a host it lists goes by its alias (on the phone, that host's
   * room), else — dialled through a room — by `<room>~<hostId>`; else, on
   * the desktop, by the id it already is.
   */
  function rendererHost(entry: ServerEntry, hostId: string): string {
    if (native(entry)) return hostId;
    if (hostId === LOCAL_HOST_ID) return entry.id;
    const alias = entry.aliases.get(hostId);
    if (alias !== undefined) return alias;
    return entry.roomId === null ? hostId : viaServer(entry.id, hostId);
  }

  /** `rendererHost` backwards: the id `entry` knows `hostId` by, or null. */
  function serverHost(entry: ServerEntry, hostId: string): string | null {
    if (native(entry)) return null;
    if (hostId === entry.id) return LOCAL_HOST_ID;
    for (const [own, alias] of entry.aliases) if (alias === hostId) return own;
    const prefix = viaServer(entry.id, "");
    return entry.roomId !== null && hostId.startsWith(prefix) && hostId.length > prefix.length
      ? hostId.slice(prefix.length)
      : null;
  }

  /** A workspace key from `entry` in the renderer's form, or null to drop it. */
  function stampKey(entry: ServerEntry, key: string): string | null {
    if (native(entry)) return key;
    const { hostId, path } = parseWorkspaceKey(key);
    const host = rendererHost(entry, hostId);
    if (host === hostId) return key;
    // A key no host can be named in (Home's `__home__`) is the page's own,
    // and only the home server's copy of it is.
    return keyFor(host, path) ?? (hostId === LOCAL_HOST_ID && isHome(entry) ? key : null);
  }

  /** A record (or each record of a list) with its `hostId` stamped. */
  function stampRecords(entry: ServerEntry, value: unknown): unknown {
    if (native(entry)) return value;
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((item) => {
        const next = stampRecord(entry, item);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : value;
    }
    return stampRecord(entry, value);
  }

  function stampRecord(entry: ServerEntry, record: unknown): unknown {
    if (!isPlainObject(record)) return record;
    let out = record;
    if (typeof record.hostId === "string") {
      const host = rendererHost(entry, normalizeHostId(record.hostId));
      if (host !== record.hostId) out = { ...out, hostId: host };
    }
    // A project's group names the host it was last used on.
    const group = record.group;
    if (isPlainObject(group) && typeof group.lastUsedHostId === "string") {
      const host = rendererHost(entry, group.lastUsedHostId);
      if (host !== group.lastUsedHostId) out = { ...out, group: { ...group, lastUsedHostId: host } };
    }
    return out;
  }

  function stampResult(
    entry: ServerEntry,
    ns: string,
    name: string,
    result: unknown,
  ): unknown {
    if (native(entry)) return result;
    if (ns === "layout" && name === "getAll" && isPlainObject(result)) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(result)) {
        const stamped = stampKey(entry, key);
        if (stamped) out[stamped] = value;
      }
      return out;
    }
    if (ns === "layout" && name === "getLastActive") {
      return typeof result === "string" ? stampKey(entry, result) : result;
    }
    return stampRecords(entry, result);
  }

  /**
   * Arguments for `entry` in its own form: a string naming one of its hosts,
   * or keyed on one, at the top level and one level into a plain object —
   * `toHostArgs`'s reach, which is what main's `HostProxy` rewrites too — and
   * in each object of a top-level list (`branches.start`'s workspaces).
   */
  function toServerArgs(entry: ServerEntry, args: unknown[]): unknown[] {
    if (native(entry)) return args;
    const value = (v: unknown): unknown => {
      if (typeof v !== "string") return v;
      const host = serverHost(entry, v);
      if (host !== null) return host;
      const parsed = parseWorkspaceKey(v);
      if (parsed.hostId === LOCAL_HOST_ID) return v;
      const own = serverHost(entry, parsed.hostId);
      if (own === null) return v;
      return own === LOCAL_HOST_ID ? parsed.path : (keyFor(own, parsed.path) ?? v);
    };
    const object = (arg: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(arg)) out[k] = value(v);
      return out;
    };
    return args.map((arg) => {
      if (Array.isArray(arg)) return arg.map((item) => (isPlainObject(item) ? object(item) : value(item)));
      return isPlainObject(arg) ? object(arg) : value(arg);
    });
  }

  /**
   * `args` without the records of a top-level list that name a host `entry`
   * does not know: a list of workspaces to watch (`branches.start`,
   * `diffs.start`) holds every server's, and a server handed another's
   * would fail the whole call on a host it never heard of.
   */
  function onlyKnownHosts(entry: ServerEntry, args: unknown[]): unknown[] {
    if (native(entry)) return args;
    const known = (item: unknown): boolean => {
      if (!isPlainObject(item) || typeof item.hostId !== "string") return true;
      const hostId = normalizeHostId(item.hostId);
      return hostId === LOCAL_HOST_ID || serverHost(entry, hostId) !== null;
    };
    return args.map((arg) => (Array.isArray(arg) && !arg.every(known) ? arg.filter(known) : arg));
  }

  // ── panes ──

  /** Record `entry`'s merged layout's panes, for the collision check. */
  function notePanes(entry: ServerEntry, layout: Record<string, unknown>): void {
    const byKey = new Map<string, Set<string>>();
    for (const [key, value] of Object.entries(layout)) {
      byKey.set(key, panesOf(value));
    }
    panesByServer.set(entry.id, byKey);
  }

  function panesOf(value: unknown): Set<string> {
    const layout = isPlainObject(value) ? (value as Partial<LayoutEntry>).layout : null;
    if (!isPlainObject(layout)) return new Set();
    try {
      return layoutPaneIds(layout as unknown as LayoutEntry["layout"]);
    } catch {
      return new Set();
    }
  }

  /** Whether two servers' layouts both hold `paneId` (ADR-228 "Risks"). */
  function collides(paneId: string): boolean {
    let holders = 0;
    for (const byKey of panesByServer.values()) {
      for (const panes of byKey.values()) {
        if (panes.has(paneId)) {
          holders += 1;
          break;
        }
      }
      if (holders > 1) return true;
    }
    return false;
  }

  function collisionError(paneId: string): Error {
    return new Error(`Pane ${paneId} is on two servers; refusing to guess which`);
  }

  // ── calls ──

  function call(entry: ServerEntry, ns: string, name: string, args: unknown[]): unknown {
    return memberOf(entry.bridge, ns, name)(...args);
  }

  function routed(rule: RouteRule, ns: string, name: string, args: unknown[]): unknown {
    const home = set.home();
    if (passThrough()) {
      releaseHeldFor(ns, name, args, home);
      return call(home, ns, name, args);
    }
    const hostId = resolver.hostOf(rule, args);
    if (hostId === null && ns === "layout" && name === "setPendingCommand") {
      return holdPendingCommand(args);
    }
    const keyboard = ns === "pty" && name === "write";
    let target = hostId === null ? home : sourceOf(hostId);
    // A keystroke for a pane whose own bridge is not up this moment goes
    // through home, which forwards it to the host (main's `HostRouting`),
    // rather than waiting in a queue the next drop throws away.
    if (keyboard && target && hostId !== null && !isHome(target) && target.reachability !== "connected") {
      if (lists(home, hostId)) target = home;
    }
    if (!target) return Promise.reject(awayError(hostId as string));
    if (rule.by === "pane" && typeof args[rule.arg] === "string") {
      const paneId = args[rule.arg] as string;
      if (collides(paneId)) return Promise.reject(collisionError(paneId));
    }
    releaseHeldFor(ns, name, args, target);
    if (native(target)) return call(target, ns, name, args);
    const answer = Promise.resolve(
      call(target, ns, name, toServerArgs(target, args)),
    ).then((result) => {
      const out = stampResult(target, ns, name, result);
      return ns === "projects" ? withDesktopGroup(out) : out;
    });
    if (!keyboard) return answer;
    // Nobody awaits a keystroke. One the stream dropped mid-flight may or may
    // not have reached the host, so it is not sent twice; it is let go.
    const via = target;
    return answer.catch((err: unknown) => {
      if (!(err instanceof BridgeDisconnectedError)) throw err;
      console.warn(`[bridge-router] a keystroke to ${via.id} was lost as its stream dropped`);
    });
  }

  /** A delegated call (D10): to the server `linearServerFor` picks. */
  function delegated(ns: string, name: string, args: unknown[]): unknown {
    const home = set.home();
    if (passThrough()) return call(home, ns, name, args);
    const hostId = delegatedHost;
    return linearServerFor(hostId, set).then((choice) => {
      const target = choice.server;
      if (!target) {
        throw new BridgeUnavailableError(choice.refusal, UNAVAILABLE_HOST_CODE);
      }
      if (native(target)) return call(target, ns, name, args);
      return Promise.resolve(call(target, ns, name, args)).then((result) =>
        stampResult(target, ns, name, result),
      );
    });
  }

  // ── what main's `HostRouting` did on the way ──

  /**
   * Queue `layout.setPendingCommand` for a pane no layout holds yet, until
   * the command that adds it (`releaseHeldFor`) — or, if none comes, home,
   * where main places it as before. Answered at once: the caller only needs
   * it sent before that command, and this keeps it so.
   */
  function holdPendingCommand(args: unknown[]): Promise<void> {
    const paneId = args[0];
    if (typeof paneId !== "string") {
      return Promise.resolve(call(set.home(), "layout", "setPendingCommand", args)).then(
        () => {},
      );
    }
    releaseHeld(paneId, set.home());
    const timer = setTimeout(() => releaseHeld(paneId, set.home()), HOLD_PENDING_MS);
    heldCommands.set(paneId, { args, timer });
    return Promise.resolve();
  }

  /** Send `paneId`'s held command to `target`, ahead of whatever follows. */
  function releaseHeld(paneId: string, target: ServerEntry): void {
    const held = heldCommands.get(paneId);
    if (!held) return;
    heldCommands.delete(paneId);
    clearTimeout(held.timer);
    // The line as it was queued: main moves it to a host unchanged, too.
    void Promise.resolve(call(target, "layout", "setPendingCommand", held.args)).catch(
      (err: unknown) => {
        console.error(`[bridge-router] pending command for ${paneId} failed:`, err);
      },
    );
  }

  /** A layout command going to `target` takes the held commands of the panes it names. */
  function releaseHeldFor(ns: string, name: string, args: unknown[], target: ServerEntry): void {
    if (heldCommands.size === 0 || ns !== "layout" || name !== "apply") return;
    for (const paneId of stringsIn(args[1])) releaseHeld(paneId, target);
  }

  /** A host's project, or projects, with the desktop's group on each (D3). */
  function withDesktopGroup(result: unknown): unknown {
    const one = (project: unknown): unknown => {
      if (!isPlainObject(project) || !desktopGroups.has(project.id)) return project;
      if (!Array.isArray(project.workspaces)) return project;
      const group = desktopGroups.get(project.id);
      return (project.group ?? null) === group ? project : { ...project, group };
    };
    return Array.isArray(result) ? result.map(one) : one(result);
  }

  async function merged(ns: string, name: string, args: unknown[]): Promise<unknown> {
    const key = `${ns}.${name}`;
    const memo = callKey(key, args);
    const answers: Answer[] = [];
    let failure: unknown = null;
    await Promise.all(
      set.list().map(async (entry) => {
        if (reachable(entry)) {
          try {
            const result = await call(entry, ns, name, args);
            // Its facts as they are now: a hello may have landed meanwhile.
            const now = set.get(entry.id) ?? entry;
            const value = stampResult(now, ns, name, result);
            remember(entry.id, memo, value);
            answers.push({ entry: now, value });
            return;
          } catch (err) {
            if (isHome(entry)) failure = err;
          }
        }
        await restore(entry.id);
        const remembered = lastKnown.get(entry.id);
        if (remembered?.has(memo)) answers.push({ entry, value: remembered.get(memo) });
      }),
    );
    if (answers.length === 0) throw failure ?? awayError(set.homeId);
    // In set order, home first, whatever order they settled in.
    const order = set.list().map((entry) => entry.id);
    answers.sort((a, b) => order.indexOf(a.entry.id) - order.indexOf(b.entry.id));
    return merge(key, answers);
  }

  // ── last-known (D6) ──

  function remember(serverId: string, memo: string, value: unknown): void {
    let mine = lastKnown.get(serverId);
    if (!mine) {
      mine = new Map();
      lastKnown.set(serverId, mine);
    }
    mine.set(memo, value);
    persisted?.write(serverId, memo, value);
  }

  /**
   * Read `serverId`'s saved answers in, once, under the ones this page has
   * heard since: what a reload with the server away shows.
   */
  function restore(serverId: string): Promise<void> {
    if (!persisted) return Promise.resolve();
    let reading = restoring.get(serverId);
    if (!reading) {
      reading = persisted.read(serverId).then(
        (saved) => {
          if (!members.has(serverId)) return;
          const mine = lastKnown.get(serverId) ?? new Map<string, unknown>();
          for (const [memo, value] of saved) if (!mine.has(memo)) mine.set(memo, value);
          lastKnown.set(serverId, mine);
        },
        () => {},
      );
      restoring.set(serverId, reading);
    }
    return reading;
  }

  function merge(key: string, answers: Answer[]): unknown {
    switch (key) {
      case "projects.getAll":
      case "projects.getRemote":
        return mergeProjects(answers);
      case "layout.getAll":
        return mergeLayouts(answers);
      case "layout.getLastActive":
        return firstOf(answers, (value, entry) =>
          typeof value === "string" && answersFor(entry, hostOfKey(value, entry)),
        );
      case "agents.get":
        return firstOf(answers, (value, entry) => kept(value, entry));
      case "agents.getPaneStatuses":
        return answers.flatMap(({ entry, value }) =>
          (Array.isArray(value) ? value : []).filter((update: unknown) => {
            const paneId = isPlainObject(update) ? update.paneId : null;
            if (typeof paneId !== "string") return true;
            return answersFor(entry, hostOfPane(paneId, entry));
          }),
        );
      default:
        return mergeRecords(answers);
    }
  }

  /** The first answer `accept` takes, else the first that is anything. */
  function firstOf(
    answers: Answer[],
    accept: (value: unknown, entry: ServerEntry) => boolean,
  ): unknown {
    for (const { entry, value } of answers) {
      if (value != null && accept(value, entry)) return value;
    }
    for (const { value } of answers) if (value != null) return value;
    return answers[0]?.value ?? null;
  }

  /** Lists of records concatenated, each kept by its source, one per id. */
  function mergeRecords(answers: Answer[]): unknown {
    if (!answers.some(({ value }) => Array.isArray(value))) {
      return firstOf(answers, () => true);
    }
    const ids = new Set<unknown>();
    const out: unknown[] = [];
    for (const { entry, value } of answers) {
      if (!Array.isArray(value)) continue;
      for (const record of value) {
        if (!kept(record, entry)) continue;
        const id = isPlainObject(record) ? record.id : undefined;
        if (id !== undefined) {
          if (ids.has(id)) continue;
          ids.add(id);
        }
        out.push(record);
      }
    }
    return out;
  }

  function mergeLayouts(answers: Answer[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const { entry, value } of answers) {
      if (!isPlainObject(value)) continue;
      if (holdsClaims(entry)) {
        homeClaims.clear();
        for (const [key, layout] of Object.entries(value)) {
          if (isPlainObject(layout) && Array.isArray(layout.claims)) homeClaims.set(key, layout.claims);
        }
      }
      const mine: Record<string, unknown> = {};
      for (const [key, layout] of Object.entries(value)) {
        if (!answersFor(entry, hostOfKey(key, entry))) continue;
        noteLayout(key, layout);
        mine[key] = isHome(entry) ? layout : withHomeClaims(key, layout);
      }
      notePanes(entry, mine);
      Object.assign(out, mine);
    }
    return out;
  }

  /**
   * Projects from every source, in the desktop's order, each carrying the
   * desktop's group (D3): a group is desktop state, and a host server's own
   * answer knows nothing of it. Projects no desktop listed follow, in set
   * order. With no desktop in the set, there are no groups to give.
   */
  function mergeProjects(answers: Answer[]): unknown[] {
    const own = answers.map(({ entry, value }) => ({
      entry,
      records: (Array.isArray(value) ? value : []).filter((record: unknown) =>
        kept(record, entry),
      ) as Record<string, unknown>[],
    }));
    const desktop = answers.find(({ entry }) => !entry.hello.hostServer);
    const desktopList = (Array.isArray(desktop?.value) ? desktop.value : []) as Record<
      string,
      unknown
    >[];
    const groups = new Map<unknown, unknown>(
      desktopList.map((project) => [project.id, project.group ?? null]),
    );
    if (desktop) desktopGroups = groups;
    const withGroup = (project: Record<string, unknown>): Record<string, unknown> => {
      if (!groups.has(project.id)) return project;
      const group = groups.get(project.id);
      return (project.group ?? null) === group ? project : { ...project, group };
    };
    const byId = new Map<unknown, Record<string, unknown>>();
    for (const { records } of own) {
      for (const project of records) {
        if (!byId.has(project.id)) byId.set(project.id, withGroup(project));
      }
    }
    const out: unknown[] = [];
    const placed = new Set<unknown>();
    for (const project of desktopList) {
      const mine = byId.get(project.id);
      if (mine && !placed.has(project.id)) {
        out.push(mine);
        placed.add(project.id);
      }
    }
    for (const [id, project] of byId) {
      if (placed.has(id)) continue;
      out.push(project);
      placed.add(id);
    }
    return out;
  }

  // ── claims (D7) ──

  /** Whether `entry` says which tabs the desktop's windows hold: a desktop at home. */
  function holdsClaims(entry: ServerEntry): boolean {
    return isHome(entry) && !entry.hello.hostServer;
  }

  /** `layout` with the desktop's claims on `key`, when home has said any. */
  function withHomeClaims(key: string, layout: unknown): unknown {
    if (!isPlainObject(layout) || !homeClaims.has(key)) return layout;
    return { ...layout, claims: homeClaims.get(key) };
  }

  function noteLayout(key: string, layout: unknown): void {
    if (isPlainObject(layout)) lastLayouts.set(key, { version: layout.version, layout: layout.layout });
  }

  /**
   * Home's claims on `key` from one of its broadcasts: true when they moved.
   * A removed workspace has none left.
   */
  function noteHomeClaims(key: string, payload: Record<string, unknown>): boolean {
    if (payload.removed) {
      homeClaims.delete(key);
      return false;
    }
    if (!Array.isArray(payload.claims)) return false;
    const moved = JSON.stringify(homeClaims.get(key) ?? []) !== JSON.stringify(payload.claims);
    homeClaims.set(key, payload.claims);
    return moved;
  }

  // ── subscriptions ──

  /** `entry`'s event in the renderer's form, or null to drop it (D3). */
  function stampEvent(
    entry: ServerEntry,
    event: { ns: string; event: string },
    args: unknown[],
  ): unknown[] | null {
    const [first, ...rest] = args;
    if (event.ns === "layout" && event.event === "changed" && isPlainObject(first)) {
      const path = first.workspacePath;
      if (typeof path !== "string") return args;
      const key = stampKey(entry, path);
      if (key === null) return null;
      const claimsMoved = holdsClaims(entry) && noteHomeClaims(key, first);
      if (!answersFor(entry, hostOfKey(key, entry))) {
        // A desktop window took or let go of a tab of a workspace another
        // server answers for (D7): that server's layout, with the claims.
        const last = lastLayouts.get(key);
        if (!claimsMoved || !last) return null;
        return [
          { workspacePath: key, version: last.version, layout: last.layout, claims: first.claims, origin: first.origin },
          ...rest,
        ];
      }
      const byKey = panesByServer.get(entry.id) ?? new Map<string, Set<string>>();
      if (first.removed) {
        byKey.delete(key);
        lastLayouts.delete(key);
      } else {
        byKey.set(key, panesOf(first));
        noteLayout(key, first);
      }
      panesByServer.set(entry.id, byKey);
      const origin = ownOrigin(entry, first.origin);
      // A host server's broadcast carries no desktop window's claims.
      const claims =
        isHome(entry) || first.removed || !homeClaims.has(key) ? first.claims : homeClaims.get(key);
      if (key === path && origin === first.origin && claims === first.claims) return args;
      return [{ ...first, workspacePath: key, origin, claims }, ...rest];
    }
    if (event.ns === "agents" && event.event === "updated") {
      const agent = stampRecords(entry, first);
      if (!kept(agent, entry)) return null;
      return agent === first ? args : [agent, ...rest];
    }
    if (event.ns === "agents" && event.event === "status" && isPlainObject(first)) {
      const paneId = first.paneId;
      if (typeof paneId === "string" && !answersFor(entry, hostOfPane(paneId, entry))) {
        return null;
      }
    }
    return args;
  }

  /**
   * A layout command this window sent a host itself carries, as its origin,
   * the window's connection to that host. The window knows itself by its
   * home id (`rendererId`), as it did when main forwarded the command, so
   * its selection hint lands (ADR-179 D3).
   */
  function ownOrigin(entry: ServerEntry, origin: unknown): unknown {
    if (isHome(entry) || !isPlainObject(origin)) return origin;
    const mine = entry.transport.rendererId;
    const home = set.home().transport.rendererId;
    if (mine === null || home === null || origin.id !== mine) return origin;
    return { kind: "window", id: home };
  }

  function openFan(sub: FanSub, entry: ServerEntry): void {
    let live = true;
    const deliver = (...args: unknown[]): void => {
      if (!live) return;
      if (passThrough()) {
        sub.listener(...args);
        return;
      }
      const current = set.get(entry.id) ?? entry;
      const out = stampEvent(current, sub.event, args);
      if (out) sub.listener(...out);
    };
    const off = call(entry, sub.ns, sub.name, [...sub.args, deliver]);
    sub.offs.set(entry.id, () => {
      live = false;
      if (typeof off === "function") (off as () => void)();
    });
  }

  function subscribeFan(
    ns: string,
    name: string,
    event: { ns: string; event: string },
    args: unknown[],
  ): () => void {
    const sub: FanSub = {
      ns,
      name,
      event,
      args: args.slice(0, -1),
      listener: args[args.length - 1] as Fn,
      offs: new Map(),
    };
    fanSubs.add(sub);
    for (const entry of set.list()) openFan(sub, entry);
    return () => {
      if (!fanSubs.delete(sub)) return;
      for (const off of sub.offs.values()) off();
      sub.offs.clear();
    };
  }

  /** The server a pane's listeners belong on now. */
  function paneTarget(paneId: string): ServerEntry {
    const home = set.home();
    if (passThrough()) return home;
    const hostId = resolver.hostOf(PANE_RULE, [paneId]);
    return hostId === null ? home : answerer(hostId);
  }

  function bindPane(sub: PaneSub, target: ServerEntry): void {
    sub.off?.();
    const off = call(target, sub.ns, sub.name, [...sub.args, sub.listener]);
    sub.off = typeof off === "function" ? (off as () => void) : () => {};
    sub.serverId = target.id;
  }

  /** Move every pane listener whose source changed: keyed by (server, pane). */
  function rebindPanes(only?: string): void {
    const targets = new Map<string, ServerEntry>();
    for (const sub of paneSubs) {
      if (only !== undefined && sub.paneId !== only) continue;
      let target = targets.get(sub.paneId);
      if (!target) {
        target = paneTarget(sub.paneId);
        targets.set(sub.paneId, target);
      }
      const bound = sub.serverId === null ? undefined : set.get(sub.serverId);
      if (bound?.id !== target.id || members.get(target.id) !== target.bridge) {
        bindPane(sub, target);
      }
    }
  }

  function subscribePane(ns: string, name: string, paneId: string, args: unknown[]): () => void {
    if (set.list().length > 1 && collides(paneId)) {
      console.error(`[bridge-router] ${collisionError(paneId).message}`);
      return () => {};
    }
    const sub: PaneSub = {
      ns,
      name,
      paneId,
      args: args.slice(0, -1),
      listener: args[args.length - 1] as Fn,
      serverId: null,
      off: null,
    };
    paneSubs.add(sub);
    // The pane's earlier listeners move with it if it resolves elsewhere now.
    rebindPanes(paneId);
    return () => {
      if (!paneSubs.delete(sub)) return;
      sub.off?.();
      sub.off = null;
    };
  }

  function subscribe(
    ns: string,
    name: string,
    event: { ns: string; event: string },
    args: unknown[],
  ): unknown {
    if (FAN_OUT_NAMESPACES.has(event.ns)) return subscribeFan(ns, name, event, args);
    const first = args[0];
    if (PANE_NAMESPACES.has(event.ns) && args.length > 1 && typeof first === "string") {
      const paneId =
        event.event === "taskEntry" ? (parseChatTaskKey(first)?.paneId ?? first) : first;
      return subscribePane(ns, name, paneId, args);
    }
    return callHome(ns, name, args);
  }

  // ── the set changing ──

  set.subscribe(() => {
    const now = new Map(set.list().map((entry) => [entry.id, entry.bridge]));
    for (const [id, bridge] of members) {
      if (now.get(id) === bridge) continue;
      for (const sub of fanSubs) {
        sub.offs.get(id)?.();
        sub.offs.delete(id);
      }
      panesByServer.delete(id);
      if (!now.has(id)) {
        lastKnown.delete(id);
        restoring.delete(id);
        // Gone from the set is gone for good: a pairing removed or refused.
        persisted?.forget(id);
      }
    }
    const before = members;
    members = now;
    for (const entry of set.list()) {
      if (before.get(entry.id) === entry.bridge) continue;
      for (const sub of fanSubs) openFan(sub, entry);
    }
    rebindPanes();
  });

  // ── the proxy, shaped as `createBridge`'s ──

  function dispatch(ns: string, name: string, args: unknown[]): unknown {
    const home = set.home();
    if (servesItself(home.transport, ns, name)) return call(home, ns, name, args);
    const key = `${ns}.${name}`;
    const listens = Object.prototype.hasOwnProperty.call(LISTENERS, key)
      ? LISTENERS[key]
      : null;
    if (listens && typeof args[args.length - 1] === "function") {
      return subscribe(ns, name, listens, args);
    }
    const route = Object.prototype.hasOwnProperty.call(ROUTES, key)
      ? ROUTES[key]
      : "home";
    if (route === "merge") {
      return passThrough() ? call(home, ns, name, args) : merged(ns, name, args);
    }
    if (typeof route === "object" && route.by === "delegated") {
      return delegated(ns, name, args);
    }
    if (typeof route === "object") return routed(route, ns, name, args);
    return callHome(ns, name, args);
  }

  /**
   * A call home, in home's form (D2): on the phone the page's ids are rooms,
   * so the arguments go out as home knows them and the answer — or each
   * event, for a listener — comes back stamped.
   */
  function callHome(ns: string, name: string, args: unknown[]): unknown {
    const home = set.home();
    if (native(home)) return call(home, ns, name, args);
    const out = toServerArgs(home, onlyKnownHosts(home, args)).map((arg) =>
      typeof arg === "function"
        ? (...event: unknown[]) =>
            (arg as Fn)(...event.map((value) => stampRecords(set.get(home.id) ?? home, value)))
        : arg,
    );
    const result = call(home, ns, name, out);
    if (!isThenable(result)) return result;
    return Promise.resolve(result).then((value) =>
      stampResult(set.get(home.id) ?? home, ns, name, value),
    );
  }

  function member(ns: string, name: string): Fn {
    const fn: Fn = (...args) => dispatch(ns, name, args);
    const nested = new Map<string, unknown>();
    return new Proxy(fn, {
      get(target, prop, receiver) {
        if (
          typeof prop !== "string" ||
          NOT_MEMBERS.has(prop) ||
          Reflect.has(target, prop)
        ) {
          return Reflect.get(target, prop, receiver) as unknown;
        }
        const existing = nested.get(prop);
        if (existing) return existing;
        const child = member(`${ns}.${name}`, prop);
        nested.set(prop, child);
        return child;
      },
    });
  }

  const namespaces = new Map<string, Record<string, unknown>>();
  function namespace(ns: string): Record<string, unknown> {
    const cached = namespaces.get(ns);
    if (cached) return cached;
    const fns = new Map<string, unknown>();
    const proxy = new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== "string" || NOT_MEMBERS.has(prop)) return undefined;
          const existing = fns.get(prop);
          if (existing) return existing;
          const fn = member(ns, prop);
          fns.set(prop, fn);
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
        if (typeof prop !== "string" || NOT_MEMBERS.has(prop)) return undefined;
        // The page's facts are the home server's: `platform`, `rendererId`
        // and the transport's root values, read through its bridge, live.
        const home = set.home();
        if (
          prop === "platform" ||
          prop === "rendererId" ||
          Object.prototype.hasOwnProperty.call(home.transport.rootValues, prop)
        ) {
          return (home.bridge as unknown as Record<string, unknown>)[prop];
        }
        return namespace(prop);
      },
    },
  ) as unknown as ElectronAPI;
}
