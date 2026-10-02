import { create } from "zustand";
import type { RemoteControlStatus, RemotePairResult } from "../electron.d";

/**
 * Live mirror of the main process's remote-control state (ADR-161).
 *
 * Shared between the settings panel and the persistent exposure indicator on
 * purpose: those two must never disagree about whether this machine is
 * currently reachable, and the way to guarantee that is one subscription and
 * one shape, pushed from main.
 *
 * The UI has one control: on means the relay is running (or trying to). The
 * main process still keeps enabling and starting the relay as two calls — the
 * agent-facing enable route must not make this machine reachable on its own —
 * so `turnOn` makes both, in order.
 */
interface RemoteControlState {
  status: RemoteControlStatus;
  loaded: boolean;
  busy: boolean;
  error: string | null;
  /** Enable remote control and start the relay. */
  turnOn: () => Promise<void>;
  /** Disable remote control; the main process stops the relay with it. */
  turnOff: () => Promise<void>;
  resetRelayAddress: () => Promise<void>;
  revoke: (id: string) => Promise<void>;
  /**
   * Pair a device, turning remote control on first if it is off, so the link
   * handed over reaches this machine straight away.
   */
  pair: (label: string) => Promise<RemotePairResult | null>;
  clearError: () => void;
}

const emptyStatus: RemoteControlStatus = {
  enabled: false,
  devices: [],
  relay: { state: "stopped", url: null, error: null },
  relayOrigin: null,
  relayAppUrl: null,
  encryptionAvailable: true,
  relayViewers: 0,
  relayNotice: null,
};

export const useRemoteControlStore = create<RemoteControlState>((set, get) => {
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

  /** Enable, then start the relay; a relay already up is left alone. */
  const turnOn = async (): Promise<RemoteControlStatus> => {
    const api = window.electronAPI.remoteControl;
    const status = await api.setEnabled(true);
    if (!status.enabled) return status;
    if (status.relay.state === "running" || status.relay.state === "starting") {
      return status;
    }
    return api.startRelay();
  };

  return {
    status: emptyStatus,
    loaded: false,
    busy: false,
    error: null,

    turnOn: () => runStatus(turnOn),
    turnOff: () =>
      runStatus(() => window.electronAPI.remoteControl.setEnabled(false)),
    resetRelayAddress: () =>
      runStatus(() => window.electronAPI.remoteControl.resetRelayAddress()),
    revoke: (id) =>
      runStatus(() => window.electronAPI.remoteControl.revoke(id)),
    pair: (label) =>
      run(async () => {
        const api = window.electronAPI.remoteControl;
        // Pairing needs the runtime, which enabling loads.
        if (!get().status.enabled) set({ status: await api.setEnabled(true) });
        const result = await api.pair(label);
        const { relay } = get().status;
        if (relay.state === "stopped" || relay.state === "failed") {
          set({ status: await api.startRelay() });
        }
        return result;
      }),
    clearError: () => set({ error: null }),
  };
});
