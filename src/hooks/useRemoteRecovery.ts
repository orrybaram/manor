import { useMountEffect } from "./useMountEffect";
import { recoverHostPanes, windowPaneIds } from "../lib/remote-recovery";
import { useAppStore } from "../store/app-store";
import { useHostStore } from "../store/host-store";
import { remoteHostByPane, useRemotePaneStore } from "../store/remote-pane-store";
import { useToastStore } from "../store/toast-store";

/** This window's panes, as of now — computed once per event (ADR-183). */
const thisWindowsPanes = () => windowPaneIds(useAppStore.getState().workspaceLayouts);

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
        const inThisWindow = thisWindowsPanes();
        void recoverHostPanes(hostId, sessionIds, {
          remoteHostByPane: () => remoteHostByPane(useRemotePaneStore.getState()),
          // A pane still waiting never had a session to lose: the host
          // connecting creates it (below).
          includePane: (paneId) =>
            inThisWindow.has(paneId) &&
            !useRemotePaneStore.getState().panes[paneId]?.awaiting,
          getActiveAgents: () => window.electronAPI.agents.getAll({ status: "active" }),
          markResumed: (agentId) => window.electronAPI.agents.markResumed(agentId),
          buildResumeCommand: (agentId) =>
            window.electronAPI.agents.buildResumeCommand(agentId),
          setPendingPaneCommand: (paneId, command) =>
            useAppStore.getState().setPendingPaneCommand(paneId, command),
          reattach: (paneIds) => useRemotePaneStore.getState().reattach(paneIds),
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
      let inThisWindow: Set<string> | undefined;
      for (const host of hosts) {
        if (host.status !== "connected") {
          connected.delete(host.hostId);
          continue;
        }
        if (connected.has(host.hostId)) continue;
        connected.add(host.hostId);
        const windowPanes = (inThisWindow ??= thisWindowsPanes());
        const remotePanes = useRemotePaneStore.getState();
        const panes = remotePanes.takePanesAwaitingHost(host.hostId, (paneId) =>
          windowPanes.has(paneId),
        );
        if (panes.length > 0) remotePanes.reattach(panes);
      }
    });

    return () => {
      unsubscribe?.();
      unsubscribeHosts();
    };
  });
}
