import { useMountEffect } from "./useMountEffect";
import { onBridgeResync } from "../bridge/resync";
import { servers } from "../bridge/server-set";
import { mountedTerminalPaneIds } from "../lib/terminal-registry";
import { useHostStore } from "../store/host-store";
import { paneRemoteHost, useRemotePaneStore } from "../store/remote-pane-store";

/**
 * Remount every open terminal when the bridge comes back from a drop, or the
 * user asks for a refresh (ADR-220 D3): whatever was printed while the socket
 * was down never arrived, so each pane attaches again and redraws from a
 * fresh snapshot. The remount is the one remote recovery uses (ADR-178 §6),
 * for reason `resync`: the mount only attaches (see `useTerminalLifecycle`).
 *
 * Once per window, not once per pane. A resync names the server whose hello
 * resumed (ADR-228 D1): when that is one host's own server — a desktop
 * window's bridge to it (D4) — only that host's panes missed anything, so
 * only they remount. The desktop's own server never resyncs.
 *
 * A host's bridge also comes back after the host itself was away, and then
 * the host's recovery remounts its panes (`useRemoteRecovery`): a session
 * its daemon lost meanwhile is recreated there, with its agent resumed,
 * where an attach would only find it gone and end the pane. So a host that
 * main saw leave `connected` since its bridge last resumed is left to that.
 */
export function useTerminalResync() {
  useMountEffect(() => {
    const wasAway = new Set<string>();
    const connected = new Set(
      useHostStore
        .getState()
        .hosts.filter((host) => host.status === "connected")
        .map((host) => host.hostId),
    );
    const unsubscribeHosts = useHostStore.subscribe(({ hosts }) => {
      for (const host of hosts) {
        if (host.status === "connected") connected.add(host.hostId);
        else if (connected.delete(host.hostId)) wasAway.add(host.hostId);
      }
    });
    const unsubscribeResync = onBridgeResync((serverId) => {
      const panes = useRemotePaneStore.getState();
      const mounted = mountedTerminalPaneIds();
      if (serverId === undefined || serverId === servers.homeId) {
        panes.reattach(mounted, "resync");
        return;
      }
      if (wasAway.delete(serverId)) return;
      panes.reattach(
        mounted.filter((paneId) => paneRemoteHost(panes, paneId) === serverId),
        "resync",
      );
    });
    return () => {
      unsubscribeHosts();
      unsubscribeResync();
    };
  });
}
