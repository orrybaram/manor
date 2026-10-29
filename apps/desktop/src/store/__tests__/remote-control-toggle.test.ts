import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RemoteControlStatus } from "../../electron.d";

// The palette's quick switch: no confirm, and a toast for what happened.

function status(over: Partial<RemoteControlStatus> = {}): RemoteControlStatus {
  return {
    enabled: false,
    devices: [],
    relay: { state: "stopped", url: null, error: null },
    relayOrigin: null,
    relayAppUrl: null,
    encryptionAvailable: true,
    relayViewers: 0,
    relayNotice: null,
    startOnLaunch: false,
    ...over,
  };
}

const running = { state: "running", url: "wss://relay", error: null } as const;

const remoteControlApi = {
  getStatus: vi.fn(() => Promise.resolve(status())),
  onStatus: vi.fn(() => () => {}),
  setEnabled: vi.fn((on: boolean) => Promise.resolve(status({ enabled: on }))),
  startRelay: vi.fn(() => Promise.resolve(status({ enabled: true, relay: running }))),
};

(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  ...((window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI ?? {}),
  remoteControl: remoteControlApi,
};

const { useRemoteControlStore } = await import("../remote-control-store");
const { useToastStore } = await import("../toast-store");

describe("remote-control toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
    useRemoteControlStore.setState({ busy: false, error: null });
  });

  it("turns on, relay and all, with no confirm, and says so", async () => {
    useRemoteControlStore.setState({ status: status() });
    await useRemoteControlStore.getState().toggle();
    expect(remoteControlApi.setEnabled).toHaveBeenCalledWith(true);
    expect(remoteControlApi.startRelay).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: "Remote control is on", status: "success" }),
    ]);
  });

  it("turns off when on, and says so", async () => {
    useRemoteControlStore.setState({ status: status({ enabled: true, relay: running }) });
    await useRemoteControlStore.getState().toggle();
    expect(remoteControlApi.setEnabled).toHaveBeenCalledWith(false);
    expect(remoteControlApi.startRelay).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: "Remote control is off", status: "success" }),
    ]);
  });

  it("reports a relay that failed to start as an error", async () => {
    useRemoteControlStore.setState({ status: status() });
    remoteControlApi.startRelay.mockResolvedValueOnce(
      status({ enabled: true, relay: { state: "failed", url: null, error: "refused" } }),
    );
    await useRemoteControlStore.getState().toggle();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: "Couldn't turn on remote control",
        status: "error",
        detail: "refused",
      }),
    ]);
  });

  it("refuses to turn on without encryption, as the settings switch does", async () => {
    useRemoteControlStore.setState({ status: status({ encryptionAvailable: false }) });
    await useRemoteControlStore.getState().toggle();
    expect(remoteControlApi.setEnabled).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: "Couldn't turn on remote control", status: "error" }),
    ]);
  });

  it("does not claim success for an enable that came back off", async () => {
    useRemoteControlStore.setState({ status: status() });
    remoteControlApi.setEnabled.mockResolvedValueOnce(status({ enabled: false }));
    await useRemoteControlStore.getState().toggle();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ status: "error" }),
    ]);
  });

  it("says so when pressed while a change is in flight", async () => {
    useRemoteControlStore.setState({ status: status(), busy: true });
    await useRemoteControlStore.getState().toggle();
    expect(remoteControlApi.setEnabled).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ status: "error" }),
    ]);
  });
});
