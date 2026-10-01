import { create } from "zustand";
import type {
  RemoteCapability,
  RemoteControlStatus,
  RemotePairResult,
} from "../electron.d";

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
  startTunnel: () => Promise<void>;
  stopTunnel: () => Promise<void>;
  revoke: (id: string) => Promise<void>;
  refreshDetection: () => Promise<void>;
  pair: (
    label: string,
    capability: RemoteCapability,
  ) => Promise<RemotePairResult | null>;
  clearError: () => void;
}

const emptyStatus: RemoteControlStatus = {
  enabled: false,
  port: null,
  devices: [],
  tunnel: { state: "stopped", url: null, error: null },
  installed: false,
  tailnet: null,
  encryptionAvailable: true,
  listeners: 0,
};

export const useRemoteControlStore = create<RemoteControlState>((set) => {
  window.electronAPI?.remoteControl
    ?.getStatus()
    .then((status) => set({ status, loaded: true }))
    .catch(() => {});

  window.electronAPI?.remoteControl?.onStatus((status) => set({ status }));

  /** Every mutating call sets busy, clears any previous error, and drops busy again. */
  const run = async <T>(action: () => Promise<T>): Promise<T | null> => {
    set({ busy: true, error: null });
    try {
      return await action();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      set({ busy: false });
    }
  };

  /** The common case: the action's result *is* the new status. */
  const runStatus = async (
    action: () => Promise<RemoteControlStatus>,
  ): Promise<void> => {
    const status = await run(action);
    if (status) set({ status });
  };

  return {
    status: emptyStatus,
    loaded: false,
    busy: false,
    error: null,

    setEnabled: (enabled) =>
      runStatus(() => window.electronAPI.remoteControl.setEnabled(enabled)),
    startTunnel: () =>
      runStatus(() => window.electronAPI.remoteControl.startTunnel()),
    stopTunnel: () =>
      runStatus(() => window.electronAPI.remoteControl.stopTunnel()),
    revoke: (id) =>
      runStatus(() => window.electronAPI.remoteControl.revoke(id)),
    refreshDetection: () =>
      runStatus(() => window.electronAPI.remoteControl.refreshDetection()),
    pair: (label, capability) =>
      run(() => window.electronAPI.remoteControl.pair(label, capability)),
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
