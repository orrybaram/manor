import { create } from "zustand";
import { liveValue } from "../bridge/resync";
import type { RemoteControlStatus, RemotePairResult } from "../electron.d";
import { isOn } from "../components/settings/remote-control-status";
import { useToastStore } from "./toast-store";

/**
 * Live mirror of the main process's remote-control state.
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
  /**
   * The palette's quick switch: on if it reads as off, off if on, with no
   * confirm either way, and a toast to say which — the palette has closed
   * by the time it lands, so nothing else would.
   */
  toggle: () => Promise<void>;
  resetRelayAddress: () => Promise<void>;
  /** "Turn on when Manor opens"; leaves remote control as it is now. */
  setStartOnLaunch: (on: boolean) => Promise<void>;
  revoke: (id: string) => Promise<void>;
  /**
   * Pair a device, turning remote control on first if it is off, so the link
   * handed over reaches this machine straight away.
   */
  pair: (label: string) => Promise<RemotePairResult | null>;
  /** A fresh single-use link for a device that has not opened its link yet. */
  reissue: (id: string) => Promise<RemotePairResult | null>;
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
  startOnLaunch: false,
};

export const useRemoteControlStore = create<RemoteControlState>((set, get) => {
  if (window.electronAPI?.remoteControl) {
    liveValue(
      () => window.electronAPI.remoteControl.getStatus(),
      (cb) => window.electronAPI.remoteControl.onStatus(cb),
      (status) => set({ status, loaded: true }),
    );
  }

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
    toggle: async () => {
      const turningOn = !isOn(get().status);
      // What the settings switch would refuse, or is still busy with, is
      // said rather than silently skipped: the palette has already closed.
      const refused = get().busy
        ? "Remote control is still changing. Try again in a moment."
        : turningOn && !get().status.encryptionAvailable
          ? "This computer can't encrypt stored secrets, so remote control stays off."
          : null;
      if (!refused) {
        await (turningOn
          ? runStatus(turnOn)
          : runStatus(() => window.electronAPI.remoteControl.setEnabled(false)));
      }
      const { error, status } = get();
      // An enable overtaken by a quit or a disable comes back off with no
      // error; it is still a failure to turn on.
      const failed =
        refused ??
        error ??
        (turningOn && !isOn(status)
          ? status.relay.error ?? "Remote control didn't turn on."
          : turningOn && status.relay.state === "failed"
            ? status.relay.error ?? "The relay connection failed."
            : null);
      useToastStore.getState().addToast(
        failed
          ? {
              id: "remote-control-toggle",
              message: turningOn
                ? "Couldn't turn on remote control"
                : "Couldn't turn off remote control",
              status: "error",
              detail: failed,
            }
          : {
              id: "remote-control-toggle",
              message: turningOn ? "Remote control is on" : "Remote control is off",
              status: "success",
              detail: turningOn
                ? "Paired devices can reach this computer through the relay."
                : undefined,
            },
      );
    },
    resetRelayAddress: () =>
      runStatus(() => window.electronAPI.remoteControl.resetRelayAddress()),
    setStartOnLaunch: (on) =>
      runStatus(() => window.electronAPI.remoteControl.setStartOnLaunch(on)),
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
    reissue: (id) =>
      run(async () => {
        const api = window.electronAPI.remoteControl;
        const result = await api.reissue(id);
        const { relay } = get().status;
        if (relay.state === "stopped" || relay.state === "failed") {
          set({ status: await api.startRelay() });
        }
        return result;
      }),
    clearError: () => set({ error: null }),
  };
});
