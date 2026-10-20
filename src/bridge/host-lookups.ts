/**
 * Where the renderer's own stores say a project, pane or agent lives: what
 * the router (`./router.ts`) reads to find the host a routed
 * call is for — and whether that host is asleep.
 *
 * The stores provide these, the router reads them, and neither imports the
 * other. That direction is forced: the router is built before any store
 * module is evaluated (`install-desktop.ts` says why), so it cannot import a
 * store — doing so would evaluate the store against a `window.electronAPI`
 * that does not exist yet. Until a store has provided its lookup, the answer
 * is "unknown", and an unknown host is the home server's, which is the only
 * server there is that early.
 *
 * Imports nothing.
 */

/** A renderer host id, or null/undefined for "not known here". */
type Lookup = (id: string) => string | null | undefined;

export interface HostLookups {
  /** A project id → its `hostId` (`project-store`). */
  project?: Lookup;
  /** A pane id → the workspace key whose layout holds it (`app-store`). */
  paneWorkspace?: Lookup;
  /** A pane id → the remote host its session runs on (`remote-pane-store`). */
  paneHost?: Lookup;
  /** An agent id → its `hostId` (`agent-store`). */
  agent?: Lookup;
  /**
   * A renderer host id → its connection status, e.g. `sleeping`
   * (`host-store`). Not a host id: the one lookup that answers something else.
   */
  hostStatus?: Lookup;
  /**
   * The router began waking `hostId` for a write; `woken`
   * settles when it is done waiting, woken or not — for the "Waking <host>…"
   * toast (`host-store`).
   */
  wakeStarted?: (hostId: string, woken: Promise<void>) => void;
}

const lookups: HostLookups = {};

/** Called once by each store, at module scope, after its `create()`. */
export function provideHostLookups(more: HostLookups): void {
  Object.assign(lookups, more);
}

/** The lookups provided so far. */
export function hostLookups(): Readonly<HostLookups> {
  return lookups;
}
