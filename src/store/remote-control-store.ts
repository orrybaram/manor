import { create } from "zustand";
import type { RemoteControlStatus, RemotePairResult } from "../electron.d";

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
  startRelay: () => Promise<void>;
  stopRelay: () => Promise<void>;
  resetRelayAddress: () => Promise<void>;
  revoke: (id: string) => Promise<void>;
  pair: (label: string) => Promise<RemotePairResult | null>;
  clearError: () => void;
}

const emptyStatus: RemoteControlStatus = {
  enabled: false,
  devices: [],
  relay: { state: "stopped", url: null, error: null },
  relayOrigin: null,
  encryptionAvailable: true,
  relayViewers: 0,
  relayNotice: null,
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
    startRelay: () =>
      runStatus(() => window.electronAPI.remoteControl.startRelay()),
    stopRelay: () =>
      runStatus(() => window.electronAPI.remoteControl.stopRelay()),
    resetRelayAddress: () =>
      runStatus(() => window.electronAPI.remoteControl.resetRelayAddress()),
    revoke: (id) =>
      runStatus(() => window.electronAPI.remoteControl.revoke(id)),
    pair: (label) => run(() => window.electronAPI.remoteControl.pair(label)),
    clearError: () => set({ error: null }),
  };
});
