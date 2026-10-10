import { memberHostName } from "../lib/hosts";
import { useHostStore } from "./host-store";
import { addErrorToast, useToastStore } from "./toast-store";

/**
 * Same-origin projects on different hosts join on their own (ADR-214). Main
 * does the joining (`projects.autoJoin`); this shows what it did, with an
 * Undo, and decides when to ask: at the first project load, when a host
 * first connects, and after an add or clone.
 */

/** One join main made: `joinedId` is the newcomer, `intoId` what it joined. */
interface JoinedPair {
  joinedId: string;
  intoId: string;
}

/** What auto-join needs of the project store, passed in to avoid an import cycle. */
export interface AutoJoinDeps {
  /** The loaded projects, for the names and hosts the toasts show. */
  getProjects: () => readonly { id: string; name: string; hostId: string }[];
  /** Load the project list again, after main joined or unjoined projects. */
  reload: () => Promise<void>;
}

/** A batch this large or larger gets one summary toast instead of one each. */
const SUMMARY_FROM = 3;
const TOAST_MS = 12_000;

let batchCounter = 0;

/** Stops the current session's host watch; see `startAutoJoin`. */
let stopWatchingHosts: (() => void) | null = null;

/** "manor on wsl-box", from the projects as loaded. */
function describe(deps: AutoJoinDeps, id: string): string | null {
  const project = deps.getProjects().find((p) => p.id === id);
  if (!project) return null;
  const hosts = useHostStore.getState().hosts;
  return `${project.name} on ${memberHostName(project.hostId, hosts)}`;
}

/** Revert every pair of a batch: unlink, restore the newcomer, dismiss. */
async function undoPairs(deps: AutoJoinDeps, pairs: readonly JoinedPair[]): Promise<void> {
  for (const { joinedId, intoId } of pairs) {
    try {
      await window.electronAPI.projects.undoAutoJoin(joinedId, intoId);
    } catch (err) {
      addErrorToast(`auto-join-undo-${joinedId}`, "Couldn't undo the join", err);
    }
  }
  await deps.reload();
}

/**
 * Ask main to join every same-origin pair, reload the projects if any
 * joined, and toast the result: one toast per pair, or a summary for a
 * batch of three or more. Safe to call at any time and concurrently; a
 * failed call shows nothing.
 */
export async function runAutoJoin(deps: AutoJoinDeps): Promise<void> {
  let pairs: JoinedPair[];
  try {
    pairs = await window.electronAPI.projects.autoJoin();
  } catch {
    return;
  }
  if (pairs.length === 0) return;
  // Named before the reload, while each project still has its own name.
  const before = pairs.map((p) => [describe(deps, p.joinedId), describe(deps, p.intoId)] as const);
  await deps.reload();

  const { addToast, removeToast } = useToastStore.getState();
  const batch = ++batchCounter;
  const toast = (id: string, message: string, undo: readonly JoinedPair[]) =>
    addToast({
      id,
      message,
      status: "info",
      duration: TOAST_MS,
      action: {
        label: "Undo",
        onClick: () => {
          removeToast(id);
          void undoPairs(deps, undo);
        },
      },
    });

  if (pairs.length >= SUMMARY_FROM) {
    toast(`auto-join-${batch}`, `Joined ${pairs.length} projects across hosts`, pairs);
    return;
  }
  pairs.forEach((pair, i) => {
    const joined = before[i][0] ?? describe(deps, pair.joinedId);
    const into = before[i][1] ?? describe(deps, pair.intoId);
    toast(
      `auto-join-${batch}-${pair.joinedId}`,
      joined && into ? `Joined ${joined} with ${into}` : "Joined projects across hosts",
      [pair],
    );
  });
}

/** Hosts the host store reports as connected right now. */
function connectedHostIds(): Set<string> {
  return new Set(
    useHostStore
      .getState()
      .hosts.filter((h) => h.status === "connected")
      .map((h) => h.hostId),
  );
}

/**
 * Start this session's auto-joining, once the projects first load: join
 * what already shares an `origin` now, and again the first time each remote
 * host connects (a host that isn't connected can't report its checkouts'
 * `origin`). A host is asked once, not after every reconnect.
 */
export function startAutoJoin(deps: AutoJoinDeps): Promise<void> {
  stopWatchingHosts?.();
  const seen = connectedHostIds();
  stopWatchingHosts = useHostStore.subscribe(({ hosts }) => {
    for (const host of hosts) {
      if (host.status !== "connected" || seen.has(host.hostId)) continue;
      seen.add(host.hostId);
      void runAutoJoin(deps);
    }
  });
  return runAutoJoin(deps);
}
