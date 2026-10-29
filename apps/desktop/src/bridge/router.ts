/**
 * `window.electronAPI` over a set of servers.
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
 *   **source**: a direct bridge to it if one is reachable, else a server
 *   that lists it, else none — and a call for a host with no source is
 *   refused with `unavailable:host-away`. Arguments go out in the server's
 *   form and the answer comes back in the renderer's (`host-rewrite.ts`).
 * - **Merged** (`"merge"`). Every server is asked; each one's answer is
 *   stamped with renderer host ids, its records for a host whose source
 *   is another server are dropped, and the rest are merged. A project's
 *   group is the desktop's. A server that is away, or fails, contributes
 *   its last answer, kept in memory (`./last-known-cache.ts`) — and, on
 *   the phone, in IndexedDB (`RouterOptions.lastKnown`), so a reload while
 *   it is away still shows it.
 * - **Split** (`"split"`). A list of workspaces to watch: each
 *   server is sent the ones it answers for, a server away gets its share
 *   when it comes back, and one too old to watch (`unavailable:host`) has
 *   its share given to a desktop that lists its host. The watchers' events
 *   are re-keyed and merged across the servers.
 * - **Home.** Everything else.
 *
 * **Renderer host ids.** On the desktop the local server is `local` and
 * a host server is the desktop's own id for that host, which is what every
 * record already says. On the phone every server is named by its room: a
 * server's `local` becomes its room id, and a host a desktop lists becomes
 * that host's room (`ServerEntry.aliases`, from the desktop's `hosts.list`),
 * or `<desktop room>~<hostId>` when it reports none. Every call to such a
 * server, home calls included, has its arguments turned back into that
 * server's own ids (`toServerArgs`) and its answer stamped (`stampResult`).
 *
 * **The bell** (`notifications`). Every server keeps its own log, and
 * each `notifications.changed` carries one server's whole log: the router
 * keeps each server's last one and hands the listener all of them merged,
 * newest first, as `notifications.getAll` answers. A mark goes to the host
 * the record names (`byHost`).
 *
 * **Subscriptions.** A listener of a merged or split namespace (`layout`,
 * `projects`, `agents`, `branches`, `diffs`), and `automations`, is opened on every server,
 * replayed on one that joins later, and its events are stamped and
 * deduplicated like a merged answer. A pane's
 * `chat.*` and `pty.*` are opened only on the pane's source, keyed by server
 * and pane; a pane id two servers' layouts both hold is refused rather than
 * cross-wired. Any other listener is home's.
 *
 * **Waking**. A routed write (`wakesHost`) for a host the
 * stores say is asleep first asks home to wake it (`hosts.wake`), waits for
 * that and for the host's own bridge to come back (bounded), and only then
 * is sent. A read never wakes a host. On the desktop, main's `HostRouting`
 * wakes a host for a write it forwards too; asking twice is harmless. A
 * create or attach with `wake: false` — a pane restored at launch — wakes nothing, and answers `host-unavailable` for a host asleep.
 *
 * **What main did on the way, done here.** A call that used to reach a host
 * through main's `HostRouting` picked up a few things there that a direct
 * call must get here instead: a queued command for a pane no layout holds
 * yet travels with the layout command that adds it (`./held-commands.ts`),
 * a project the host answers with carries the desktop's group, and a
 * layout broadcast's origin names this window, not its stream to the host.
 *
 * **The desktop's own server alone is a pass-through.** With only it in the
 * set — every desktop window, until a host server joins — each call is
 * handed to it as it was given and its answer returned untouched: no
 * re-stamping, no copying, and no resolving except to wake a sleeping host. Main still merges remote hosts
 * itself (`HostRouting`), so that is exactly what the stores got before. A
 * phone's lone pairing is stamped all the same, so its ids do not change
 * when a second one joins.
 */

import type { EventName, WireEventArgs } from "../../electron/bridge/events";
import {
  keyAutomationPaths,
  keyFor,
  rewriteNestedWorkspace,
} from "../../electron/bridge/host-rewrite";
import { byPane, declinesWake, ROUTES, wakesHost, type RouteRule } from "../../electron/bridge/routes";
import { BridgeUnavailableError } from "../../electron/bridge/settle";
import { UNAVAILABLE_HOST_AWAY_CODE, UNAVAILABLE_HOST_CODE } from "../../electron/bridge/types";
import { parseChatTaskKey } from "../../electron/chat-mirror/task-key";
import type { ElectronAPI, PtyFailure } from "../electron";
import type { LayoutEntry } from "../lib/layout/protocol";
import { layoutPaneIds } from "../lib/layout/workspace-layout";
import {
  crossHostMoveRefusal,
  LOCAL_HOST_ID,
  normalizeHostId,
  parseWorkspaceKey,
} from "../lib/workspace-key";
import { BridgeDisconnectedError, LISTENERS, NOT_MEMBERS, servesItself } from "./client";
import { createHeldCommands } from "./held-commands";
import { onBridgeResync } from "./resync";
import { hostLookups } from "./host-lookups";
import { linearServers, type LinearChoice } from "./linear-servers";
import type { LastKnownStore } from "./last-known";
import { callKey, createLastKnownCache } from "./last-known-cache";
import { servers, viaServer, type ServerEntry, type ServerSet } from "./server-set";

/** Which host a routed call is for. */
export interface HostResolver {
  /**
   * The renderer host id the argument `rule` names points at, or null when
   * the renderer does not know — which the home server answers, as main's
   * `HostRouting` answers what it does not know itself.
   */
  hostOf(rule: RouteRule, args: readonly unknown[]): string | null;
  /**
   * Whether renderer host `hostId` is asleep, so a write for it
   * wakes it first. Absent: nothing is known to sleep.
   */
  asleep?(hostId: string): boolean;
  /**
   * The router began waking `hostId` for a write; `woken` settles once it
   * is done waiting (it never rejects). Absent: nobody is told.
   */
  waking?(hostId: string, woken: Promise<void>): void;
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
  asleep(hostId) {
    return hostLookups().hostStatus?.(hostId) === "sleeping";
  },
  waking(hostId, woken) {
    hostLookups().wakeStarted?.(hostId, woken);
  },
};

/**
 * How long a write for a woken host waits for the host's own bridge to come
 * back before it goes by whichever source there is. Home has
 * already said the host is up by then; this is only the bridge redialling.
 */
const WOKEN_SOURCE_WAIT_MS = 10_000;

/**
 * The namespaces with a merged read, or a watch split across the servers:
 * their listeners fan out.
 */
const FAN_OUT_NAMESPACES: ReadonlySet<string> = new Set([
  ...Object.entries(ROUTES)
    .filter(([, route]) => route === "merge" || route === "split")
    .map(([key]) => key.slice(0, key.lastIndexOf("."))),
  // Routed by host, but each server announces its own host's changes: a
  // phone paired with several hears each of them.
  "automations",
]);

/**
 * The events whose payload is a `Record<WorkspaceKey, …>` of everything one
 * server watches: re-keyed, kept only for the workspaces that
 * server watches, and merged with every other server's last one, since a
 * listener takes each payload as the whole picture.
 */
const KEYED_EVENTS: ReadonlySet<string> = new Set([
  "branches.changed",
  "diffs.changed",
  "diffs.fingerprintsChange",
]);

/**
 * The events that name their host one level down rather than at the top: the
 * field of the payload holding a `{ hostId }`, stamped as a top-level
 * `hostId` is. Without it a phone, which names every host by its room, would
 * hear `files.changed` for host `local` and match none of its panes.
 */
const NESTED_HOST_FIELD: { readonly [W in EventName]?: keyof WireEventArgs<W>[0] & string } = {
  "files.changed": "workspace",
};

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
  /** A `KEYED_EVENTS` listener's last payload from each server; else null. */
  parts: Map<string, Record<string, unknown>> | null;
}

/**
 * A `"split"` namespace's watch: what the page last asked for,
 * and what each server was last sent of it.
 */
interface SplitWatch {
  /** The workspaces of the last `start`, or null after a `stop`. */
  list: unknown[] | null;
  /**
   * Each server's last share, as sent (JSON of its arguments), or null for a
   * `stop`. A server absent here holds nothing of this page's: never sent,
   * away since, or come back on a new connection.
   */
  sent: Map<string, string | null>;
  /** Servers too old to watch (`unavailable:host`): a desktop that lists their host does. */
  refused: Set<string>;
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
 * Run `call`, a `linear.*` call, on behalf of `hostId`: the
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
   * Where each server's last answers outlive the page: the phone's
   * IndexedDB (`./last-known.ts`). Without it they are kept in memory only.
   */
  lastKnown?: LastKnownStore;
}

export function createRouter(
  set: ServerSet,
  resolver: HostResolver = storeResolver,
  options: RouterOptions = {},
): ElectronAPI {
  let members = new Map(set.list().map((entry) => [entry.id, entry.bridge]));
  /** Each server's last answer to each merged read. */
  const lastKnown = createLastKnownCache(options.lastKnown ?? null, (id) => members.has(id));
  /** Each server's panes, by workspace, as its merged layout says. */
  const panesByServer = new Map<string, Map<string, Set<string>>>();
  const fanSubs = new Set<FanSub>();
  const paneSubs = new Set<PaneSub>();
  /** `layout.setPendingCommand` for panes no layout holds yet (`./held-commands.ts`). */
  const heldCommands = createHeldCommands<ServerEntry>({
    send: (target, args) => call(target, "layout", "setPendingCommand", args),
    home: () => set.home(),
  });
  /** Each project's group, from the desktop's last `projects.getAll`. */
  let desktopGroups = new Map<unknown, unknown>();
  /**
   * The project order home's own `projects.getAll` last gave, and the merged
   * order the renderer was given. Home's selected index is into
   * the first; the renderer's is into the second.
   */
  let homeProjectIds: unknown[] | null = null;
  let mergedProjectIds: unknown[] | null = null;
  /**
   * The project selected on the page only, for one home does not hold. It is
   * kept by id, as the merged list's indexes move. Not persisted across a reload (a known limit).
   */
  let pageSelectionId: unknown = null;
  /** The index home's `projects.getSelectedIndex` last gave, for while it is away. */
  let homeSelectedIndex: unknown = null;
  /**
   * The desktop's claims on each workspace, as home last said them: a
   * tab a detached window holds is the desktop's to know, and no host
   * server's layout carries it.
   */
  const homeClaims = new Map<string, unknown>();
  /**
   * The layout each workspace's answerer last gave, for a claim that moved
   * on a workspace home does not answer for: told again with it.
   */
  const lastLayouts = new Map<string, { version: unknown; layout: unknown }>();
  /**
   * Each server's own notification log, as its last `getAll` answer or
   * `notifications.changed` said it (stamped): each event carries one
   * server's whole log, and the listener takes it as everyone's.
   */
  const notificationLogs = new Map<string, unknown[]>();

  // ── sources ──

  function isHome(entry: ServerEntry): boolean {
    return entry.id === set.homeId;
  }

  /**
   * Whether `entry` can be asked now. The desktop's own server always can,
   * and so can a lone server: its own transport queues, retries and refuses
   * as it did when it was the page's only bridge, and a router that refused
   * for it would change that. A phone's home among others is one server of
   * several: away is away.
   */
  function reachable(entry: ServerEntry): boolean {
    if (entry.reachability !== "unreachable") return true;
    return isHome(entry) && (native(entry) || set.list().length === 1);
  }

  /**
   * Whether calls go to home as they are: the desktop's own server alone in
   * the set, whose answers are already in the renderer's form. A phone's
   * server is stamped even alone, so its ids do not change when a
   * second pairing joins.
   */
  function passThrough(): boolean {
    return set.list().length === 1 && native(set.home());
  }

  function lists(entry: ServerEntry, hostId: string): boolean {
    return entry.lists === "all" || entry.lists.has(hostId);
  }

  /** The server answering for `hostId` now, or null: it is away. */
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

  /**
   * The server watching `hostId`'s workspaces for `ns`: the one
   * answering for it, unless that one is too old to watch — then a desktop
   * that lists the host, which polls it as it always has.
   */
  function watcherOf(ns: string, hostId: string): ServerEntry | null {
    const own = answerer(hostId);
    const refused = splits.get(ns)?.refused;
    if (!refused?.has(own.id)) return own;
    for (const entry of set.list()) {
      if (entry.id === own.id || entry.hello.hostServer || refused.has(entry.id)) continue;
      if (lists(entry, hostId) && reachable(entry)) return entry;
    }
    return null;
  }

  // ── stamping ──

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

  /** An event's payload `value` (its argument `at`) with its hosts stamped. */
  function stampEventArg(
    entry: ServerEntry,
    event: { ns: string; event: string } | null,
    value: unknown,
    at: number,
  ): unknown {
    if (native(entry)) return value;
    const stamped = stampRecords(entry, value);
    const field =
      event && at === 0 ? NESTED_HOST_FIELD[`${event.ns}.${event.event}` as EventName] : undefined;
    if (!field || !isPlainObject(stamped)) return stamped;
    const inner = stamped[field];
    const next = stampRecord(entry, inner);
    return next === inner ? stamped : { ...stamped, [field]: next };
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
    // A move's answer names where the tab landed by the server's own key.
    if (ns === "layout" && name === "moveToWorkspace" && isPlainObject(result)) {
      const key = typeof result.workspacePath === "string" ? stampKey(entry, result.workspacePath) : null;
      return key ? { ...result, workspacePath: key } : result;
    }
    if (ns === "automations") {
      return stampRecords(entry, keyAutomationPaths(result, (key) => stampKey(entry, key)));
    }
    return stampRecords(entry, result);
  }

  /**
   * Arguments for `entry` in its own form: a string naming one of its hosts,
   * or keyed on one, at the top level, one level into a plain object and
   * into that object's `workspace` (an automation's) — `toHostArgs`'s reach,
   * which is what main's `HostProxy` rewrites too — and
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
      return rewriteNestedWorkspace(out, value);
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

  /**
   * `record`'s entries about workspaces `entry` watches for `ns`, re-keyed in
   * the renderer's form when `stamp` (they already are when not).
   */
  function watchedEntries(
    entry: ServerEntry,
    ns: string,
    record: Record<string, unknown>,
    stamp: boolean,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      const stamped = stamp ? stampKey(entry, key) : key;
      if (stamped === null) continue;
      if (watcherOf(ns, hostOfKey(stamped, entry))?.id === entry.id) out[stamped] = value;
    }
    return out;
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

  /** Whether two servers' layouts both hold `paneId`. */
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

  // ── waking ──

  /** Each host's wake in flight, so calls that find it asleep share one. */
  const waking = new Map<string, Promise<void>>();

  /** The asleep host a routed `ns.name` would wake, or null. */
  function sleepingTarget(rule: RouteRule, ns: string, name: string, args: unknown[]): string | null {
    if (!resolver.asleep || !wakesHost(ns, name)) return null;
    const hostId = resolver.hostOf(rule, args);
    return hostId !== null && hostId !== LOCAL_HOST_ID && resolver.asleep(hostId) ? hostId : null;
  }

  /**
   * Ask home to wake `hostId`, then wait — bounded — for the host's own
   * bridge, when the page holds one, to be back. Never rejects: a host that
   * did not wake is away, and the call it was for then says so.
   */
  function wake(hostId: string): Promise<void> {
    let pending = waking.get(hostId);
    if (!pending) {
      pending = (async () => {
        try {
          await callHome("hosts", "wake", [hostId]);
        } catch (err) {
          console.warn(`[bridge-router] waking ${hostId} failed:`, err);
          return;
        }
        await directBridgeBack(hostId);
      })().finally(() => waking.delete(hostId));
      waking.set(hostId, pending);
      resolver.waking?.(hostId, pending);
    }
    return pending;
  }

  /**
   * Resolves once the page's own bridge to `hostId` is connected — at once
   * when it holds none — or after `WOKEN_SOURCE_WAIT_MS`.
   */
  function directBridgeBack(hostId: string): Promise<void> {
    const back = (): boolean => {
      const direct = set.get(hostId);
      return !direct || isHome(direct) || direct.reachability === "connected";
    };
    if (back()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, WOKEN_SOURCE_WAIT_MS);
      const off = set.subscribe(() => {
        if (back()) done();
      });
    });
  }

  // ── calls ──

  function call(entry: ServerEntry, ns: string, name: string, args: unknown[]): unknown {
    return memberOf(entry.bridge, ns, name)(...args);
  }

  /** A routed call, after waking its host if it is asleep and the call means it. */
  function routed(rule: RouteRule, ns: string, name: string, args: unknown[]): unknown {
    const asleep = sleepingTarget(rule, ns, name, args);
    if (asleep === null) return routedNow(rule, ns, name, args);
    if (declinesWake(ns, name, args)) return Promise.resolve(asleepAnswer(asleep));
    return wake(asleep).then(() => routedNow(rule, ns, name, args));
  }

  /**
   * What a create or attach that declines to wake answers for a
   * host asleep: the `host-unavailable` failure a pane waits out behind its
   * host's asleep banner, as for a host that is away.
   */
  function asleepAnswer(hostId: string): PtyFailure {
    const name = set.get(hostId)?.hello.name ?? hostId;
    return { ok: false, reason: "host-unavailable", hostId, error: `${name} is asleep` };
  }

  function routedNow(rule: RouteRule, ns: string, name: string, args: unknown[]): unknown {
    const home = set.home();
    if (passThrough()) {
      heldCommands.releaseFor(ns, name, args, home);
      return call(home, ns, name, args);
    }
    if (ns === "layout" && name === "moveToWorkspace") {
      // The server it goes to sees both keys in its own form, where another
      // host's target could pass for one of its own.
      const refusal = crossHostMoveRefusal(String(args[0]), String(args[2]));
      if (refusal) return Promise.resolve({ error: refusal });
    }
    const hostId = resolver.hostOf(rule, args);
    if (hostId === null && ns === "layout" && name === "setPendingCommand") {
      return heldCommands.hold(args);
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
    heldCommands.releaseFor(ns, name, args, target);
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

  /** A delegated call: to the server `linearServerFor` picks. */
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

  /** A host's project, or projects, with the desktop's group on each. */
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
            lastKnown.remember(entry.id, memo, value);
            answers.push({ entry: now, value });
            return;
          } catch (err) {
            if (isHome(entry)) failure = err;
          }
        }
        const remembered = await lastKnown.recall(entry.id, memo);
        if (remembered) answers.push({ entry, value: remembered.value });
      }),
    );
    if (answers.length === 0) throw failure ?? awayError(set.homeId);
    // In set order, home first, whatever order they settled in.
    const order = set.list().map((entry) => entry.id);
    answers.sort((a, b) => order.indexOf(a.entry.id) - order.indexOf(b.entry.id));
    return merge(key, answers);
  }

  function merge(key: string, answers: Answer[]): unknown {
    switch (key) {
      case "projects.getAll": {
        const list = mergeProjects(answers);
        noteProjectOrders(answers, list);
        return list;
      }
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
      case "notifications.getAll":
        for (const { entry, value } of answers) {
          if (Array.isArray(value)) notificationLogs.set(entry.id, value);
        }
        {
          const list = mergedNotifications();
          toldNotifications = JSON.stringify(list);
          return list;
        }
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

  /**
   * Every server's last log, newest first: each record kept from the server
   * answering for its host now, so a desktop's copy of an adopted host's
   * records and the host's own are one.
   */
  /**
   * The bell's listeners, told the merge again when the set changed under it
   * without any server's log changing: a departed server's log gone, or a
   * host's records now kept from another server. Only when it differs from
   * what they last heard. Alone with the desktop, its own events reach them
   * as they are: told once, the desktop's last log, when the others leave.
   */
  let toldNotifications: string | null = null;
  function retellNotifications(): void {
    const alone = passThrough();
    if (alone && toldNotifications === null) return;
    const subs = [...fanSubs].filter(
      (sub) => sub.event.ns === "notifications" && sub.event.event === "changed",
    );
    if (subs.length === 0 || notificationLogs.size === 0) return;
    const list = mergedNotifications();
    const json = JSON.stringify(list);
    if (json === toldNotifications) return;
    // Alone, nothing keeps the logs current: they start again when a second
    // server joins.
    toldNotifications = alone ? null : json;
    if (alone) notificationLogs.clear();
    for (const sub of subs) sub.listener(list);
  }

  function mergedNotifications(): unknown[] {
    const answers: Answer[] = [];
    for (const entry of set.list()) {
      const value = notificationLogs.get(entry.id);
      if (value) answers.push({ entry, value });
    }
    const out = mergeRecords(answers) as unknown[];
    const at = (record: unknown): number => {
      const ms = isPlainObject(record) && typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
      return Number.isFinite(ms) ? ms : 0;
    };
    return out.sort((a, b) => at(b) - at(a));
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
   * desktop's group: a group is desktop state, and a host server's own
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

  /** Home's raw id order and the merged one, for the selected index. */
  function noteProjectOrders(answers: Answer[], list: unknown[]): void {
    const home = answers.find(({ entry }) => isHome(entry));
    const idsOf = (records: unknown): unknown[] =>
      (Array.isArray(records) ? records : []).map((record) =>
        isPlainObject(record) ? record.id : undefined,
      );
    homeProjectIds = home ? idsOf(home.value) : [];
    mergedProjectIds = idsOf(list);
  }

  async function projectOrders(): Promise<{ home: unknown[]; merged: unknown[] }> {
    if (!homeProjectIds || !mergedProjectIds) await merged("projects", "getAll", []);
    return { home: homeProjectIds ?? [], merged: mergedProjectIds ?? [] };
  }

  /** `projects.getSelectedIndex`, home's index translated to the merged list. */
  async function selectedIndex(): Promise<unknown> {
    const answer = await homeIndex();
    const orders = await projectOrders();
    if (pageSelectionId !== null) {
      const at = orders.merged.indexOf(pageSelectionId);
      if (at >= 0) return at;
      pageSelectionId = null;
    }
    if (typeof answer !== "number") return answer;
    const at = orders.merged.indexOf(orders.home[answer]);
    if (at >= 0) return at;
    return orders.merged.length === 0 ? -1 : 0;
  }

  /**
   * Home's selected index, or — home away among other servers — the one it
   * last gave. A phone whose desktop quit still reloads its projects from the
   * hosts it reaches directly; a refusal here would fail that whole reload.
   */
  async function homeIndex(): Promise<unknown> {
    const others = () => set.list().length > 1;
    // Never answered: no index of home's, so the merged list's first.
    const last = () => homeSelectedIndex ?? -1;
    if (!reachable(set.home()) && others()) return last();
    try {
      homeSelectedIndex = await callHome("projects", "getSelectedIndex", []);
      return homeSelectedIndex;
    } catch (err) {
      if (others()) return last();
      throw err;
    }
  }

  /** `projects.select`, the merged index translated to home's. */
  async function selectProject(args: unknown[]): Promise<unknown> {
    const index = args[0];
    const orders = await projectOrders();
    const id = typeof index === "number" ? orders.merged[index] : undefined;
    if (id === undefined) return callHome("projects", "select", args);
    const at = orders.home.indexOf(id);
    if (at < 0) {
      pageSelectionId = id;
      return undefined;
    }
    pageSelectionId = null;
    return callHome("projects", "select", [at, ...args.slice(1)]);
  }

  // ── claims ──

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

  // ── watches split across the servers ──

  /** Each `"split"` namespace's watch, once the page has started or stopped one. */
  const splits = new Map<string, SplitWatch>();

  /**
   * `ns.start(list)` or `ns.stop()`: each server is sent the workspaces it
   * answers for (`watcherOf`), in its own form; one away is skipped and sent
   * its share when it comes back. The desktop's own server alone is handed
   * the call as it is.
   */
  function split(ns: string, name: string, args: unknown[]): unknown {
    let watch = splits.get(ns);
    if (!watch) {
      watch = { list: null, sent: new Map(), refused: new Set() };
      splits.set(ns, watch);
    }
    watch.list = name === "start" && Array.isArray(args[0]) ? args[0] : null;
    if (passThrough()) {
      const home = set.home();
      watch.sent.set(home.id, watch.list ? JSON.stringify(args) : null);
      return call(home, ns, name, args);
    }
    return resplit(ns);
  }

  /** Send each reachable server its share of `ns`'s watch, where it moved. */
  function resplit(ns: string): Promise<void> {
    const watch = splits.get(ns);
    if (!watch) return Promise.resolve();
    const sends: Promise<void>[] = [];
    for (const entry of set.list()) {
      if (!reachable(entry)) {
        watch.sent.delete(entry.id);
        continue;
      }
      const mine = (watch.list ?? []).filter((item) => {
        const hostId = isPlainObject(item) && typeof item.hostId === "string" ? item.hostId : null;
        return watcherOf(ns, normalizeHostId(hostId))?.id === entry.id;
      });
      const args = toServerArgs(entry, onlyKnownHosts(entry, [mine]));
      const was = watch.sent.get(entry.id);
      if ((args[0] as unknown[]).length === 0) {
        // Nothing of this page's to watch there: it lets go of what it had.
        if (was === undefined || was === null) continue;
        watch.sent.set(entry.id, null);
        sends.push(sendWatch(entry, ns, "stop", [], null));
        continue;
      }
      const json = JSON.stringify(args);
      if (json === was) continue;
      watch.sent.set(entry.id, json);
      sends.push(sendWatch(entry, ns, "start", args, json));
    }
    return Promise.all(sends).then(() => undefined);
  }

  /**
   * One server's share. A server too old to watch (`unavailable:host`) is
   * refused from then on, and its share goes to a desktop that lists its
   * host; any other failure is tried again on the next change.
   */
  async function sendWatch(
    entry: ServerEntry,
    ns: string,
    name: string,
    args: unknown[],
    json: string | null,
  ): Promise<void> {
    try {
      await call(entry, ns, name, args);
    } catch (err) {
      const watch = splits.get(ns);
      if (!watch || watch.sent.get(entry.id) !== json) return;
      watch.sent.delete(entry.id);
      if ((err as { code?: unknown } | null)?.code === UNAVAILABLE_HOST_CODE) {
        watch.refused.add(entry.id);
        await resplit(ns);
        return;
      }
      console.warn(`[bridge-router] ${ns}.${name} on ${entry.id} failed:`, err);
    }
  }

  // ── subscriptions ──

  /** `entry`'s event in the renderer's form, or null to drop it. */
  function stampEvent(
    entry: ServerEntry,
    event: { ns: string; event: string },
    args: unknown[],
  ): unknown[] | null {
    const [first, ...rest] = args;
    if (KEYED_EVENTS.has(`${event.ns}.${event.event}`) && isPlainObject(first)) {
      return [watchedEntries(entry, event.ns, first, true), ...rest];
    }
    if (event.ns === "layout" && event.event === "changed" && isPlainObject(first)) {
      const path = first.workspacePath;
      if (typeof path !== "string") return args;
      const key = stampKey(entry, path);
      if (key === null) return null;
      const claimsMoved = holdsClaims(entry) && noteHomeClaims(key, first);
      if (!answersFor(entry, hostOfKey(key, entry))) {
        // A desktop window took or let go of a tab of a workspace another
        // server answers for: that server's layout, with the claims.
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
    if (event.ns === "notifications" && event.event === "changed" && Array.isArray(first)) {
      notificationLogs.set(entry.id, stampRecords(entry, first) as unknown[]);
      const list = mergedNotifications();
      toldNotifications = JSON.stringify(list);
      return [list, ...rest];
    }
    if (event.ns === "agents" && event.event === "updated") {
      const agent = stampRecords(entry, first);
      if (!kept(agent, entry)) return null;
      return agent === first ? args : [agent, ...rest];
    }
    if (event.ns === "automations" && event.event === "changed" && isPlainObject(first)) {
      // Named by its server's id for the host (`local` from the host's own
      // server); kept only from the server answering for that host now, so a
      // desktop's copy of an adopted host's event and the host's own are one.
      const info = stampRecords(entry, first) as Record<string, unknown>;
      if (typeof info.hostId === "string" && !answersFor(entry, info.hostId)) return null;
      return info === first ? args : [info, ...rest];
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
   * its selection hint lands.
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
      if (!out) return;
      if (sub.parts) {
        sub.parts.set(entry.id, out[0] as Record<string, unknown>);
        sub.listener(mergedParts(sub), ...out.slice(1));
        return;
      }
      sub.listener(...out);
    };
    const off = call(entry, sub.ns, sub.name, [...sub.args, deliver]);
    sub.offs.set(entry.id, () => {
      live = false;
      if (typeof off === "function") (off as () => void)();
    });
  }

  /**
   * Every server's last payload of a `KEYED_EVENTS` listener, in set order,
   * each kept to what that server watches now: whose watch moved since it
   * spoke (a host server back, say) is no longer its to say.
   */
  function mergedParts(sub: FanSub): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const entry of set.list()) {
      const part = sub.parts?.get(entry.id);
      if (part) Object.assign(out, watchedEntries(entry, sub.event.ns, part, false));
    }
    return out;
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
      parts: KEYED_EVENTS.has(`${event.ns}.${event.event}`) ? new Map() : null,
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
    return callHome(ns, name, args, event);
  }

  // ── the set changing ──

  set.subscribe(() => {
    const now = new Map(set.list().map((entry) => [entry.id, entry.bridge]));
    for (const [id, bridge] of members) {
      if (now.get(id) === bridge) continue;
      for (const sub of fanSubs) {
        sub.offs.get(id)?.();
        sub.offs.delete(id);
        if (!now.has(id)) sub.parts?.delete(id);
      }
      panesByServer.delete(id);
      if (!now.has(id)) notificationLogs.delete(id);
      // A new connection holds none of this page's watches, and may be a
      // newer server.
      for (const watch of splits.values()) {
        watch.sent.delete(id);
        watch.refused.delete(id);
      }
      // Gone from the set is gone for good: a pairing removed or refused.
      if (!now.has(id)) lastKnown.forget(id);
    }
    const before = members;
    members = now;
    for (const entry of set.list()) {
      if (before.get(entry.id) === entry.bridge) continue;
      for (const sub of fanSubs) openFan(sub, entry);
    }
    rebindPanes();
    // Whose workspaces are whose may have moved: a server away or back.
    for (const ns of splits.keys()) void resplit(ns);
    retellNotifications();
  });

  // A server whose stream came back has let go of what it watched for this
  // page; so has every server, on a refresh or a new home.
  onBridgeResync((serverId) => {
    for (const [ns, watch] of splits) {
      if (serverId === undefined) watch.sent.clear();
      else {
        watch.sent.delete(serverId);
        watch.refused.delete(serverId);
      }
      void resplit(ns);
    }
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
    if (!passThrough()) {
      if (key === "projects.getSelectedIndex") return selectedIndex();
      if (key === "projects.select") return selectProject(args);
    }
    const route = Object.prototype.hasOwnProperty.call(ROUTES, key)
      ? ROUTES[key]
      : "home";
    if (route === "merge") {
      return passThrough() ? call(home, ns, name, args) : merged(ns, name, args);
    }
    if (route === "split") return split(ns, name, args);
    if (typeof route === "object" && route.by === "delegated") {
      return delegated(ns, name, args);
    }
    if (typeof route === "object") return routed(route, ns, name, args);
    return callHome(ns, name, args);
  }

  /**
   * A call home, in home's form: on the phone the page's ids are rooms,
   * so the arguments go out as home knows them and the answer — or each
   * event, for a listener — comes back stamped.
   */
  function callHome(
    ns: string,
    name: string,
    args: unknown[],
    event: { ns: string; event: string } | null = null,
  ): unknown {
    const home = set.home();
    if (native(home)) return call(home, ns, name, args);
    const out = toServerArgs(home, onlyKnownHosts(home, args)).map((arg) =>
      typeof arg === "function"
        ? (...payload: unknown[]) =>
            (arg as Fn)(
              ...payload.map((value, at) =>
                stampEventArg(set.get(home.id) ?? home, event, value, at),
              ),
            )
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
