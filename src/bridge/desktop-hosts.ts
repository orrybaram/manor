/**
 * A desktop window's host servers in its server set (ADR-228 D4): one entry
 * per remote host that takes this window's own viewer stream, each over its
 * own `hostPipe` (`./transports/host-pipe.ts`).
 *
 * The list comes from the home server's `hosts.list` and
 * `hosts.onStatusChanged`, which carry each host's connection status and,
 * from its server's last status, `viewerBridge` (ticket 2), and whether this
 * desktop has adopted it (`adopted`). A host joins the set when it is
 * connected, says `viewerBridge` and is adopted — main's own check before it
 * opens a stream (`electron/ipc/host-pipe.ts`) — so a transport is never left
 * dialling a host main will always turn away. Until the first status read
 * `viewerBridge` is absent, which counts as "not yet"; adoption finishing is
 * a status change, which adds it then.
 *
 * Once in, a host stays while it is listed, says `viewerBridge` and is
 * adopted:
 *
 * - **Away** (`reconnecting`, `error`, …). Main closes the stream, the
 *   transport reports `unreachable` and dials again with backoff, and the
 *   router falls back to main's `HostRouting` for the host meanwhile (D6),
 *   which serves its cache. When the host is `connected` again this dials at
 *   once instead of waiting out the backoff; the resumed hello resyncs.
 * - **Gone** (removed, or its server no longer takes a viewer stream: an
 *   older server after a reinstall, or no server at all). The entry leaves
 *   the set and its transport stops; the host is main's again (D3).
 *
 * A host without `viewerBridge` never gets an entry and is reached through
 * main's `HostRouting`, as in slice 2.
 *
 * Imports no store (`install-desktop.ts` says why): only types, the set and
 * the transport.
 */

import type { HostStatusInfo } from "../store/host-store";
import { LOCAL_HOST_ID } from "../lib/workspace-key";
import { liveValue } from "./resync";
import type { ServerSet } from "./server-set";
import { createHostPipeTransport, type HostPipeApi } from "./transports/host-pipe";
import type { WsBridgeTransport } from "./transports/ws";

/** What the set's hosts are read from: the home server's `hosts`. */
export interface HostsSource {
  list(): Promise<HostStatusInfo[]>;
  onStatusChanged(cb: (hosts: HostStatusInfo[]) => void): () => void;
}

export interface DesktopHostsOptions {
  set: ServerSet;
  /** `window.manorHost.native.hostPipe`, or a fake of it. */
  pipes: HostPipeApi;
  hosts: HostsSource;
  /** Stand-in for `createHostPipeTransport`, for tests. */
  transport?: (hostId: string) => WsBridgeTransport;
}

/** Whether main would open a stream to `host` while it is connected. */
function streamable(host: HostStatusInfo): boolean {
  return host.viewerBridge === true && host.adopted === true;
}

/** Whether a window may hold its own bridge to `host` now (D3, D4). */
export function takesViewerStream(host: HostStatusInfo): boolean {
  return host.hostId !== LOCAL_HOST_ID && host.status === "connected" && streamable(host);
}

/**
 * Keep `set` holding a server per host that takes a viewer stream. Returns
 * the stop, which takes every such server out again.
 */
export function watchDesktopHosts(options: DesktopHostsOptions): () => void {
  const { set, pipes, hosts } = options;
  const transports = new Map<string, WsBridgeTransport>();

  const makeTransport =
    options.transport ??
    ((hostId: string) => createHostPipeTransport(pipes, hostId, set.hooks(hostId)));

  function add(hostId: string): void {
    const transport = makeTransport(hostId);
    transports.set(hostId, transport);
    set.add(hostId, transport, { capabilities: ["viewer-bridge"] });
  }

  function remove(hostId: string): void {
    const transport = transports.get(hostId);
    if (!transport) return;
    transports.delete(hostId);
    set.remove(hostId);
    transport.close();
  }

  function apply(list: readonly HostStatusInfo[]): void {
    const listed = new Set<string>();
    for (const host of list) {
      if (host.hostId === LOCAL_HOST_ID) continue;
      listed.add(host.hostId);
      const transport = transports.get(host.hostId);
      if (!transport) {
        if (takesViewerStream(host)) add(host.hostId);
        continue;
      }
      if (!streamable(host)) {
        remove(host.hostId);
        continue;
      }
      // Back from a drop: dial now, not when the backoff says.
      if (
        host.status === "connected" &&
        set.facts(host.hostId).reachability === "unreachable"
      ) {
        void transport.probeNow();
      }
    }
    for (const hostId of [...transports.keys()]) {
      if (!listed.has(hostId)) remove(hostId);
    }
  }

  const stop = liveValue(
    () => hosts.list(),
    (cb) => hosts.onStatusChanged(cb),
    apply,
  );
  return () => {
    stop();
    for (const hostId of [...transports.keys()]) remove(hostId);
  };
}
