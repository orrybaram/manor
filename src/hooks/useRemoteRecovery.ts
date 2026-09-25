import { useMountEffect } from "./useMountEffect";
import { recoverHostPanes, windowPaneIds } from "../lib/remote-recovery";
import { useAppStore } from "../store/app-store";
import { useHostStore } from "../store/host-store";
import {
  isAwaitingHost,
  takePanesAwaitingHost,
  usePaneHostStore,
} from "../store/pane-host-store";
import { usePaneReattachStore } from "../store/pane-reattach-store";
import { useToastStore } from "../store/toast-store";

const inThisWindow = (paneId: string) =>
  windowPaneIds(useAppStore.getState().workspaceLayouts).has(paneId);

/**
 * Recover this window's panes on a remote host each time it comes back from
 * a drop (ADR-178 §6; see `lib/remote-recovery`), and create the panes that
 * were waiting for a host that was away when they opened — the app launched
 * while it was down, or a pane opened on it since — once it connects.
 */
export function useRemoteRecovery() {
  useMountEffect(() => {
    const unsubscribe = window.electronAPI?.hosts?.onReconnected?.(
      ({ hostId, sessionIds }) => {
        void recoverHostPanes(hostId, sessionIds, {
          remoteHostByPane: () => usePaneHostStore.getState().remoteHostByPane,
          // A pane still waiting never had a session to lose: the host
          // connecting creates it (below).
          includePane: (paneId) => inThisWindow(paneId) && !isAwaitingHost(paneId),
          getActiveAgents: () => window.electronAPI.agents.getAll({ status: "active" }),
          markResumed: (agentId) => window.electronAPI.agents.markResumed(agentId),
          buildResumeCommand: (agentId) =>
            window.electronAPI.agents.buildResumeCommand(agentId),
          setPendingPaneCommand: (paneId, command) =>
            useAppStore.getState().setPendingPaneCommand(paneId, command),
          reattach: (paneIds) => usePaneReattachStore.getState().reattach(paneIds),
          notify: (message) =>
            useToastStore.getState().addToast({
              id: `host-restarted-${hostId}`,
              message,
              status: "success",
              // Lands as the user comes back to the laptop — give them time
              // to see it.
              duration: 10_000,
            }),
        });
      },
    );

    // A waiting pane remounts once its host connects, and its mount creates
    // the session as on relaunch (ADR-144): a fresh shell in its cwd that
    // resumes the pane's agent, or the session itself if the host kept it.
    const connected = new Set(
      useHostStore
        .getState()
        .hosts.filter((h) => h.status === "connected")
        .map((h) => h.hostId),
    );
    const unsubscribeHosts = useHostStore.subscribe(({ hosts }) => {
      for (const host of hosts) {
        if (host.status !== "connected") {
          connected.delete(host.hostId);
          continue;
        }
        if (connected.has(host.hostId)) continue;
        connected.add(host.hostId);
        const panes = takePanesAwaitingHost(host.hostId, inThisWindow);
        if (panes.length > 0) usePaneReattachStore.getState().reattach(panes);
      }
    });

    return () => {
      unsubscribe?.();
      unsubscribeHosts();
    };
  });
}
