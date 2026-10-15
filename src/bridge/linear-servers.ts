/**
 * Which server answers a Linear call (ADR-228 D10).
 *
 * Linear is user-delegated: its calls are tied to no path, and the token
 * lives on the desktop, or on a host the user turned it on for (ADR-227 D7).
 * For a call made on behalf of host H the choice is the first of:
 *
 * 1. H's own server, if it reports Linear connected;
 * 2. the desktop that lists H, if it is reachable and has Linear connected;
 * 3. neither: a stated refusal, "Linear isn't turned on for wsl-box, and
 *    This Mac is away". A server that is away is named as away, since what
 *    it has is not known; when every one named is, they are named together:
 *    "wsl-box and This Mac are both away".
 *
 * With no host in mind (browsing in `TasksView`) it is home first, then any
 * server with Linear.
 *
 * Each server's `linear.isConnected()` is cached here, and asked again when
 * its hello lands (it becomes reachable) and on `hosts.pairingChanged`. A
 * server never asked is asked once, on the call that needs the answer.
 * Each server also pushes `linear.connectionChanged` (ADR-230 D8), which sets
 * its entry directly; the asks above stay for servers too old to push it.
 */

import { LOCAL_HOST_ID } from "../lib/workspace-key";
import { serverHostName, type ServerEntry, type ServerSet } from "./server-set";

/** The server to use, or why there is none. */
export type LinearChoice =
  | { server: ServerEntry; refusal?: undefined }
  | { server?: undefined; refusal: string };

export interface LinearServers {
  /** The server for a call on behalf of `hostId`, or null for no host. */
  choose(hostId: string | null): Promise<LinearChoice>;
  /** Whether any reachable server has Linear connected, asking those unknown. */
  anyConnected(): Promise<boolean>;
  /** Why no server has Linear, in a sentence; for a view with no host. */
  whyNone(): string;
  /** Ask every reachable server again. */
  refreshAll(): Promise<void>;
  /** The cache changed. */
  subscribe(cb: () => void): () => void;
}

const instances = new WeakMap<ServerSet, LinearServers>();

/** `set`'s Linear choices; made on first use, so a page that never asks pays nothing. */
export function linearServers(set: ServerSet): LinearServers {
  let made = instances.get(set);
  if (!made) {
    made = createLinearServers(set);
    instances.set(set, made);
  }
  return made;
}

export function createLinearServers(set: ServerSet): LinearServers {
  /** Each server's last `isConnected`. */
  const connected = new Map<string, boolean>();
  const asking = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  /** Reachability each server had when last looked at, to see a hello land. */
  const seen = new Map<string, string>();

  function isHome(entry: ServerEntry): boolean {
    return entry.id === set.homeId;
  }

  /** As the router sees it: a lone or native home is always asked. */
  function reachable(entry: ServerEntry): boolean {
    if (entry.reachability !== "unreachable") return true;
    return isHome(entry) && (entry.id === LOCAL_HOST_ID || set.list().length === 1);
  }

  function lists(entry: ServerEntry, hostId: string): boolean {
    return entry.lists === "all" || entry.lists.has(hostId);
  }

  function changed(): void {
    for (const cb of [...listeners]) cb();
  }

  function ask(entry: ServerEntry): Promise<void> {
    const running = asking.get(entry.id);
    if (running) return running;
    const run = (async () => {
      let answer = false;
      try {
        answer = (await entry.bridge.linear.isConnected()) === true;
      } catch {
        // A server that refuses (not turned on) or fails has no Linear.
      }
      if (connected.get(entry.id) !== answer) {
        connected.set(entry.id, answer);
        changed();
      }
    })().finally(() => asking.delete(entry.id));
    asking.set(entry.id, run);
    return run;
  }

  /** The cache holds an answer for every reachable server in `entries`. */
  async function known(entries: readonly ServerEntry[]): Promise<void> {
    await Promise.all(
      entries.filter((e) => reachable(e) && !connected.has(e.id)).map(ask),
    );
  }

  function has(entry: ServerEntry): boolean {
    return reachable(entry) && connected.get(entry.id) === true;
  }

  /** What this page calls `entry`'s machine. */
  function nameOf(entry: ServerEntry): string {
    const given = serverHostName(entry.id === set.homeId ? null : entry.id);
    if (given) return given;
    if (entry.id === LOCAL_HOST_ID) return "This Mac";
    return entry.hello.name ?? entry.id;
  }

  /** Why `entry` cannot answer: "Linear isn't turned on for x", or x is away. */
  function lack(entry: ServerEntry): Reason {
    if (!reachable(entry)) return { away: nameOf(entry) };
    // A desktop holds the token itself; a host server was opted in.
    return !entry.hello.hostServer
      ? `Linear isn't connected on ${nameOf(entry)}`
      : `Linear isn't turned on for ${nameOf(entry)}`;
  }

  /** The server of `hostId` itself: its own bridge, or the home server's machine. */
  function ownServer(hostId: string): ServerEntry | undefined {
    return set.get(hostId) ?? (hostId === LOCAL_HOST_ID ? set.home() : undefined);
  }

  /** The desktops that list `hostId` but are not its server. */
  function listers(hostId: string, own: ServerEntry | undefined): ServerEntry[] {
    return set
      .list()
      .filter((e) => e !== own && !e.hello.hostServer && lists(e, hostId));
  }

  const api: LinearServers = {
    async choose(hostId) {
      if (hostId === null) {
        await known(set.list());
        const all = set.list();
        const pick = [set.home(), ...all].find(has);
        return pick ? { server: pick } : { refusal: api.whyNone() };
      }
      const own = ownServer(hostId);
      const via = listers(hostId, own);
      await known([...(own ? [own] : []), ...via]);
      if (own && has(own)) return { server: own };
      const lister = via.find(has);
      if (lister) return { server: lister };
      const reasons: Reason[] = [
        ...(own ? [lack(own)] : [`Linear isn't turned on for ${serverHostName(hostId) ?? hostId}`]),
        ...via.map((e) => lack(e)),
      ];
      return { refusal: join(reasons) };
    },

    async anyConnected() {
      await known(set.list());
      return set.list().some(has);
    },

    whyNone() {
      const all = set.list();
      const home = set.home();
      const reasons: Reason[] = [lack(home)];
      const others = all.filter((e) => e !== home);
      const away = others.filter((e) => !reachable(e));
      for (const e of away) reasons.push(lack(e));
      if (others.some(reachable)) reasons.push("no host has it turned on");
      return join(reasons);
    },

    async refreshAll() {
      await Promise.all(set.list().filter(reachable).map(ask));
    },

    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };

  /** Each server's `linear.onConnectionChanged` subscription, by id, and the bridge it was made on. */
  const pushes = new Map<string, { bridge: ServerEntry["bridge"]; off: () => void }>();

  function followPush(entry: ServerEntry): void {
    if (pushes.get(entry.id)?.bridge === entry.bridge) return;
    pushes.get(entry.id)?.off();
    try {
      const off = entry.bridge.linear.onConnectionChanged((now) => {
        if (connected.get(entry.id) !== now) {
          connected.set(entry.id, now);
          changed();
        }
      });
      pushes.set(entry.id, { bridge: entry.bridge, off });
    } catch {
      // A transport that serves no such event has the hello and pairing asks.
      pushes.delete(entry.id);
    }
  }

  /** The home's `hosts.pairingChanged` subscription: a pairing changed, so whether a host has Linear on may have too. */
  let pairing: { bridge: ServerEntry["bridge"]; off: () => void } | null = null;

  function followPairing(): void {
    try {
      const bridge = set.home().bridge;
      if (pairing?.bridge === bridge) return;
      pairing?.off();
      pairing = null;
      const off = bridge.hosts.onPairingChanged(() => {
        connected.clear();
        void api.refreshAll();
      });
      pairing = { bridge, off };
    } catch {
      // A transport that serves no host events has nothing to refresh on.
    }
  }

  // A server's hello makes it reachable: ask it again then. Servers joining
  // and leaving are followed here too.
  set.subscribe(() => {
    const now = set.list();
    for (const id of [...seen.keys()]) {
      if (!now.some((e) => e.id === id)) {
        seen.delete(id);
        pushes.get(id)?.off();
        pushes.delete(id);
        if (connected.delete(id)) changed();
      }
    }
    for (const entry of now) {
      const before = seen.get(entry.id);
      seen.set(entry.id, entry.reachability);
      followPush(entry);
      if (entry.reachability === "connected" && before !== "connected" && before !== undefined) {
        void ask(entry);
      }
    }
    followPairing();
  });
  for (const entry of set.list()) {
    seen.set(entry.id, entry.reachability);
    followPush(entry);
  }
  followPairing();

  return api;
}

/** One clause of a refusal: a sentence, or a server that is away, by name. */
type Reason = string | { away: string };

/**
 * The clauses as one sentence. Servers all away are named together ("x and y
 * are both away"); otherwise each says its own ("x is away").
 */
function join(reasons: Reason[]): string {
  const away = reasons.flatMap((r) => (typeof r === "string" ? [] : [r.away]));
  if (away.length > 1 && away.length === reasons.length) {
    return `${list(away)} are ${away.length === 2 ? "both" : "all"} away`;
  }
  const clauses = reasons.map((r) => (typeof r === "string" ? r : `${r.away} is away`));
  return clauses.length <= 1
    ? (clauses[0] ?? "")
    : `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

/** "a and b", "a, b and c". */
function list(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
