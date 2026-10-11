import { useMountEffect } from "./useMountEffect";
import { onBridgeResync } from "../bridge/resync";
import { mountedTerminalPaneIds } from "../lib/terminal-registry";
import { useRemotePaneStore } from "../store/remote-pane-store";

/**
 * Remount every open terminal when the bridge comes back from a drop, or the
 * user asks for a refresh (ADR-220 D3): whatever was printed while the socket
 * was down never arrived, so each pane attaches again and redraws from a
 * fresh snapshot. The remount is the one remote recovery uses (ADR-178 §6),
 * for reason `resync`: the mount only attaches (see `useTerminalLifecycle`).
 *
 * Once per window, not once per pane. The desktop never resyncs, so there
 * this subscribes and nothing more.
 */
export function useTerminalResync() {
  useMountEffect(() =>
    onBridgeResync(() => {
      useRemotePaneStore.getState().reattach(mountedTerminalPaneIds(), "resync");
    }),
  );
}
