/**
 * Every Manor server this page can reach (ADR-228 D1): one entry per server,
 * each with its own bridge, its reachability and what its hello said.
 *
 * `./router.ts` builds `window.electronAPI` over this set; nothing else
 * calls a server's bridge directly. The set starts with the **home** server
 * alone — the desktop's own main process, or the phone's pairing — and a
 * server that joins later is one `add(id, transport)`:
 *
 * ```ts
 * const hooks = servers.hooks(hostId);
 * servers.add(hostId, createHostPipeTransport(api, hostId, hooks), {
 *   capabilities: ["viewer-bridge"],
 * });
 * ```
 *
 * `hooks(id)` records the transport's hellos and reachability on the entry,
 * and emits the resync on a resumed hello (D1, "resync is per server").
 *
 * **Facts outlive the bridge.** What a hello said, the room and the
 * reachability are kept by id whether or not a bridge has been added for
 * it yet, so a hello that lands while `add` is still on its way — or a test
 * that records one with no bridge at all — is not lost.
 *
 * This replaces the singletons `./connection.ts` and `./install-web.ts` held
 * (the room, `isHostServer`, the outcome and the reachability). Both keep
 * their exports as selectors over the home entry here.
 */

import { useCallback, useSyncExternalStore } from "react";

import { LOCAL_HOST_ID } from "../lib/workspace-key";
import { createBridge, type BridgeTransport } from "./client";
import { emitBridgeResync } from "./resync";
import type { ElectronAPI } from "../electron";

/**
 * Whether a server can be reached right now. `unknown` until the first hello
 * or refusal; `unreachable` on a close its pipe lists as "not there right
 * now" (the dial keeps retrying), `connected` on the next hello.
 */
export type Reachability = "unknown" | "connected" | "unreachable";

/** What a server has said about this page's credentials, once it has. */
export type BridgeOutcome = "unauthorized" | "key-mismatch";

/** What a server's hello says about it. */
export interface ServerHello {
  /** The server's name for its host (ADR-225 D7), or null. */
  name: string | null;
  /** True when a host server answered, not a desktop (ADR-226). */
  hostServer: boolean;
  /** Its app version (ADR-206 D4), or null from an older server. */
  version: string | null;
  /** What it can do beyond the bridge, e.g. `viewer-bridge` (D3). */
  capabilities: readonly string[];
}

/**
 * Which hosts a server answers for besides its own (D3, source 2): `"all"`
 * for a desktop whose `HostRouting` serves every host it lists, or the set
 * of renderer host ids it lists.
 */
export type ServerLists = "all" | ReadonlySet<string>;

/** One server in the set. A new object on every change, for React. */
export interface ServerEntry {
  /** Its renderer host id (D2): `local` for the desktop's own server. */
  readonly id: string;
  readonly bridge: ElectronAPI;
  readonly transport: BridgeTransport;
  readonly reachability: Reachability;
  readonly hello: ServerHello;
  /** The relay room it is dialled through, or null (the desktop's own). */
  readonly roomId: string | null;
  readonly outcome: BridgeOutcome | null;
  readonly lists: ServerLists;
}

/** What the transport tells the set: hand these to `createWsTransport`. */
export interface ServerHooks {
  onHello(reply: HelloFacts & { resumed: boolean }): void;
  onStatus(status: "connected" | "unreachable"): void;
}

/** The parts of a hello reply the set records. */
export interface HelloFacts {
  hostName: string | null;
  hostServer: boolean;
  appVersion?: string | null;
}

export interface AddOptions {
  /** Make this the page's home server (D1). The first one added is anyway. */
  home?: boolean;
  lists?: "all" | Iterable<string>;
  roomId?: string | null;
  capabilities?: readonly string[];
}

export interface ServerSet {
  /** The home server's id, whether or not it has been added yet. */
  readonly homeId: string;
  /** Add (or replace) the server `id`, over `transport`. */
  add(id: string, transport: BridgeTransport, options?: AddOptions): ServerEntry;
  /** Drop server `id`. The home server cannot be removed. */
  remove(id: string): void;
  /** The home server. Throws before one is added: the router needs one. */
  home(): ServerEntry;
  get(id: string): ServerEntry | undefined;
  /** Every server, home first, then in the order they were added. */
  list(): readonly ServerEntry[];
  /** The facts kept for `id`, whether or not it has a bridge yet. */
  facts(id: string): ServerFacts;
  hooks(id: string): ServerHooks;
  recordHello(id: string, hello: HelloFacts): void;
  setReachability(id: string, reachability: Reachability): void;
  /** The first outcome sticks: a transport stops on it. */
  setOutcome(id: string, outcome: BridgeOutcome): void;
  setRoom(id: string, roomId: string | null): void;
  setLists(id: string, lists: "all" | Iterable<string>): void;
  /** Any change: a server added or removed, or any of its facts. */
  subscribe(cb: () => void): () => void;
}

/** What the set knows about a server apart from its bridge. */
export interface ServerFacts {
  readonly reachability: Reachability;
  readonly hello: ServerHello;
  readonly roomId: string | null;
  readonly outcome: BridgeOutcome | null;
  readonly lists: ServerLists;
}

const NO_HELLO: ServerHello = {
  name: null,
  hostServer: false,
  version: null,
  capabilities: [],
};

const NO_FACTS: ServerFacts = {
  reachability: "unknown",
  hello: NO_HELLO,
  roomId: null,
  outcome: null,
  lists: new Set(),
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function toLists(lists: "all" | Iterable<string>): ServerLists {
  return lists === "all" ? "all" : new Set(lists);
}

export function createServerSet(
  options: { homeId?: string } = {},
): ServerSet {
  let homeId = options.homeId ?? LOCAL_HOST_ID;
  const facts = new Map<string, ServerFacts>();
  const transports = new Map<string, { transport: BridgeTransport; bridge: ElectronAPI }>();
  /** Insertion order; `list()` puts home first. */
  const order: string[] = [];
  const entries = new Map<string, ServerEntry>();
  let listed: readonly ServerEntry[] = [];
  const listeners = new Set<() => void>();

  function factsOf(id: string): ServerFacts {
    return facts.get(id) ?? NO_FACTS;
  }

  /** Rebuild `id`'s entry (if it has a bridge) and the list, then notify. */
  function changed(id: string | null): void {
    if (id !== null) {
      const held = transports.get(id);
      if (held) entries.set(id, { id, ...held, ...factsOf(id) });
      else entries.delete(id);
    }
    listed = [
      ...order.filter((x) => x === homeId),
      ...order.filter((x) => x !== homeId),
    ].flatMap((x) => entries.get(x) ?? []);
    for (const cb of [...listeners]) cb();
  }

  function update(id: string, next: Partial<ServerFacts>): void {
    facts.set(id, { ...factsOf(id), ...next });
    changed(id);
  }

  const set: ServerSet = {
    get homeId() {
      return homeId;
    },

    add(id, transport, opts = {}) {
      if (opts.home || order.length === 0) homeId = id;
      transports.set(id, { transport, bridge: createBridge(transport) });
      if (!order.includes(id)) order.push(id);
      const next: { -readonly [K in keyof ServerFacts]?: ServerFacts[K] } = {};
      if (opts.lists !== undefined) next.lists = toLists(opts.lists);
      if (opts.roomId !== undefined) next.roomId = opts.roomId;
      if (opts.capabilities !== undefined) {
        next.hello = { ...factsOf(id).hello, capabilities: [...opts.capabilities] };
      }
      update(id, next);
      return entries.get(id) as ServerEntry;
    },

    remove(id) {
      if (id === homeId || !transports.has(id)) return;
      transports.delete(id);
      order.splice(order.indexOf(id), 1);
      facts.delete(id);
      changed(id);
    },

    home() {
      const entry = entries.get(homeId);
      if (!entry) throw new Error("The page has no home server yet");
      return entry;
    },

    get(id) {
      return entries.get(id);
    },

    list() {
      return listed;
    },

    facts: factsOf,

    hooks(id) {
      return {
        onHello: (reply) => {
          set.recordHello(id, reply);
          set.setReachability(id, "connected");
          // The first hello is the cold start the stores' boot fetches
          // cover; a resumed one may have missed pushes (ADR-220 D1).
          if (reply.resumed) void emitBridgeResync(id);
        },
        onStatus: (status) => set.setReachability(id, status),
      };
    },

    recordHello(id, hello) {
      const was = factsOf(id).hello;
      const next: ServerHello = {
        name: hello.hostName?.trim() || null,
        hostServer: hello.hostServer,
        version: hello.appVersion === undefined ? was.version : hello.appVersion,
        capabilities: was.capabilities,
      };
      if (
        next.name === was.name &&
        next.hostServer === was.hostServer &&
        next.version === was.version
      ) {
        return;
      }
      update(id, { hello: next });
    },

    setReachability(id, reachability) {
      if (factsOf(id).reachability === reachability) return;
      update(id, { reachability });
    },

    setOutcome(id, outcome) {
      if (factsOf(id).outcome !== null) return;
      update(id, { outcome });
    },

    setRoom(id, roomId) {
      if (factsOf(id).roomId === roomId) return;
      update(id, { roomId });
    },

    setLists(id, lists) {
      const was = factsOf(id).lists;
      const next = toLists(lists);
      if (
        was === next ||
        (was !== "all" && next !== "all" && sameList([...was], [...next]))
      ) {
        return;
      }
      update(id, { lists: next });
    },

    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
  return set;
}

/** This page's servers: what `install-desktop.ts` / `install-web.ts` fill. */
export const servers: ServerSet = createServerSet();

/** Every server the page holds, home first, live. */
export function useServers(): readonly ServerEntry[] {
  return useSyncExternalStore(servers.subscribe, servers.list, servers.list);
}

/**
 * How this page's own bridge to `hostId`'s server is doing, or undefined
 * when it holds none — a host reached only through another server (D3).
 */
export function directReachability(hostId: string): Reachability | undefined {
  return servers.get(hostId)?.reachability;
}

/**
 * Resolves once this page's own bridge to `hostId`'s server is connected —
 * or the page holds none, or `timeoutMs` has passed. What a remount for a
 * host that just came back waits on, so its panes attach over that bridge
 * (D5) rather than through the home server while it is still redialling.
 */
export function whenDirectSettled(hostId: string, timeoutMs = 5_000): Promise<void> {
  const settled = (): boolean => {
    const reachability = directReachability(hostId);
    return reachability === undefined || reachability === "connected";
  };
  if (settled()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const off = servers.subscribe(() => {
      if (settled()) done();
    });
  });
}

/** `directReachability`, live. */
export function useDirectReachability(
  hostId: string | null | undefined,
): Reachability | undefined {
  const read = useCallback(
    (): Reachability | undefined => (hostId ? directReachability(hostId) : undefined),
    [hostId],
  );
  const subscribe = useCallback(
    (cb: () => void) => subscribeSelected(servers, read, cb),
    [read],
  );
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * A value derived from `set`, recomputed on every change but only reported
 * when it is a different value: a reachability selector should not wake on
 * a hello's version.
 */
export function subscribeSelected<T>(
  set: ServerSet,
  select: () => T,
  cb: () => void,
): () => void {
  let last = select();
  return set.subscribe(() => {
    const next = select();
    if (Object.is(next, last)) return;
    last = next;
    cb();
  });
}
