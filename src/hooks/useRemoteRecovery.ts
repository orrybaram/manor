import { useMountEffect } from "./useMountEffect";
import { recoverHostPanes } from "../lib/remote-recovery";
import { useAppStore } from "../store/app-store";
import { usePaneHostStore } from "../store/pane-host-store";
import { usePaneReattachStore } from "../store/pane-reattach-store";
import { useToastStore } from "../store/toast-store";

/**
 * Recover this window's panes on a remote host each time it comes back from
 * a drop (ADR-178 §6; see `lib/remote-recovery`).
 */
export function useRemoteRecovery() {
  useMountEffect(() => {
    const unsubscribe = window.electronAPI?.hosts?.onReconnected?.(
      ({ hostId, sessionIds }) => {
        void recoverHostPanes(hostId, sessionIds, {
          remoteHostByPane: () => usePaneHostStore.getState().remoteHostByPane,
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
            }),
        });
      },
    );
    return () => unsubscribe?.();
  });
}
