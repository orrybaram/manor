import { create } from "zustand";
import type { RemoteControlStatus, TunnelKind } from "../electron.d";

/**
 * Live mirror of the main process's remote-control state (ADR-161).
 *
 * Shared between the settings panel and the persistent exposure indicator on
 * purpose: those two must never disagree about whether this machine is
 * currently reachable, and the way to guarantee that is one subscription and
 * one shape, pushed from main.
 */
interface RemoteControlState {
  status: RemoteControlStatus;
  loaded: boolean;
  busy: boolean;
  error: string | null;
  setEnabled: (enabled: boolean) => Promise<void>;
  startTunnel: (kind?: TunnelKind) => Promise<void>;
  stopTunnel: () => Promise<void>;
  revoke: (id: string) => Promise<void>;
  refreshDetection: () => Promise<void>;
  clearError: () => void;
}

const emptyStatus: RemoteControlStatus = {
  enabled: false,
  port: null,
  devices: [],
  tunnel: { state: "stopped", kind: null, url: null, error: null },
  detected: { tailscale: false, cloudflared: false },
  encryptionAvailable: true,
  listeners: 0,
};

export const useRemoteControlStore = create<RemoteControlState>((set) => {
  window.electronAPI?.remoteControl
    ?.getStatus()
    .then((status) => set({ status, loaded: true }))
    .catch(() => {});

  window.electronAPI?.remoteControl?.onStatus((status) => set({ status }));

  /** Every mutating call is the same shape: busy, then status or error. */
  const run = async (
    action: () => Promise<RemoteControlStatus>,
  ): Promise<void> => {
    set({ busy: true, error: null });
    try {
      set({ status: await action() });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  };

  return {
    status: emptyStatus,
    loaded: false,
    busy: false,
    error: null,

    setEnabled: (enabled) =>
      run(() => window.electronAPI.remoteControl.setEnabled(enabled)),
    startTunnel: (kind) =>
      run(() => window.electronAPI.remoteControl.startTunnel(kind)),
    stopTunnel: () => run(() => window.electronAPI.remoteControl.stopTunnel()),
    revoke: (id) => run(() => window.electronAPI.remoteControl.revoke(id)),
    refreshDetection: () =>
      run(() => window.electronAPI.remoteControl.refreshDetection()),
    clearError: () => set({ error: null }),
  };
});

/** True while this machine is reachable from outside, or trying to be. */
export function selectExposed(state: RemoteControlState): boolean {
  return (
    state.status.tunnel.state === "running" ||
    state.status.tunnel.state === "starting"
  );
}
