import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostIdleStop } from "../host-idle-stop";

type Viewing = { desktop: boolean; device: boolean; forwarded: boolean };

describe("HostIdleStop", () => {
  const MIN = 60_000;
  let stop: ReturnType<typeof vi.fn<(hostId: string) => Promise<void>>>;
  let state: {
    minutes: number | undefined;
    providerBusy: boolean;
    sleeping: boolean;
    /** The box's view; `idleSince` is on the box's clock, `skewMs` ahead of ours. */
    status: { busy?: boolean; idleSince?: number | null; desktopViewing?: boolean; viewing?: Viewing } | null;
    skewMs: number;
  };
  /** What the server reports: how long it has been idle, measured on the box. */
  function report(): { busy?: boolean; idleForMs?: number | null; desktopViewing?: boolean; viewing?: Viewing } | null {
    if (!state.status) return null;
    const { idleSince, ...rest } = state.status;
    if (idleSince === undefined) return rest;
    return { ...rest, idleForMs: idleSince === null ? null : Date.now() + state.skewMs - idleSince };
  }
  let idle: HostIdleStop;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    stop = vi.fn(async (_hostId: string) => {});
    state = {
      minutes: 10,
      providerBusy: false,
      sleeping: false,
      status: { busy: false, idleSince: Date.now(), desktopViewing: false },
      skewMs: 0,
    };
    idle = new HostIdleStop({
      minutes: () => state.minutes,
      status: async () => report(),
      providerBusy: () => state.providerBusy,
      isSleeping: () => state.sleeping,
      stop,
      recheckMs: MIN,
      log: { warn: vi.fn() },
    });
  });
  afterEach(() => {
    idle.dispose();
    vi.useRealTimers();
  });

  it("stops once idle long enough, unmounted and not busy", async () => {
    idle.idle("h", Date.now());
    await vi.advanceTimersByTimeAsync(10 * MIN - 1);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stop).toHaveBeenCalledWith("h");
  });

  it("waits while a phone is watching, and stops once nobody is", async () => {
    const viewing = { desktop: false, device: true, forwarded: false };
    state.status = { busy: false, idleSince: Date.now(), desktopViewing: false, viewing };
    idle.idle("h", Date.now());
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(stop).not.toHaveBeenCalled();
    state.status = { busy: false, idleSince: 0, desktopViewing: false, viewing: { ...viewing, device: false } };
    await vi.advanceTimersByTimeAsync(MIN);
    expect(stop).toHaveBeenCalledWith("h");
  });

  it("waits while a forwarded viewer is watching", async () => {
    const viewing = { desktop: false, device: false, forwarded: true };
    state.status = { busy: false, idleSince: Date.now(), desktopViewing: false, viewing };
    idle.idle("h", Date.now());
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(stop).not.toHaveBeenCalled();
    state.status = { busy: false, idleSince: 0, desktopViewing: false, viewing: { ...viewing, forwarded: false } };
    await vi.advanceTimersByTimeAsync(MIN);
    expect(stop).toHaveBeenCalledWith("h");
  });

  it("treats an older status with no viewing as desktopViewing alone", async () => {
    state.status = { busy: false, idleSince: Date.now(), desktopViewing: false };
    idle.idle("h", Date.now());
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(stop).toHaveBeenCalledWith("h");
  });

  it("waits while a window has a pane of the host mounted", async () => {
    state.status = { busy: false, idleSince: Date.now(), desktopViewing: true };
    idle.idle("h", Date.now());
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(stop).not.toHaveBeenCalled();
    state.status = { ...state.status, desktopViewing: false };
    await vi.advanceTimersByTimeAsync(MIN);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("a busy flip cancels it", async () => {
    idle.idle("h", Date.now());
    await vi.advanceTimersByTimeAsync(5 * MIN);
    idle.busy("h");
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(stop).not.toHaveBeenCalled();
  });

  it("a busy flip while the status is being read cancels it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new HostIdleStop({
      minutes: () => 10,
      status: async () => {
        await gate;
        return report();
      },
      providerBusy: () => false,
      isSleeping: () => false,
      stop,
    });
    slow.idle("h", Date.now());
    await vi.advanceTimersByTimeAsync(10 * MIN);
    slow.busy("h");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not stop a busy provider, a busy host or a sleeping one", async () => {
    state.providerBusy = true;
    idle.idle("h", Date.now());
    await vi.advanceTimersByTimeAsync(10 * MIN);
    state.providerBusy = false;
    state.sleeping = true;
    idle.idle("h", Date.now());
    await vi.advanceTimersByTimeAsync(10 * MIN);
    state.sleeping = false;
    state.status = { busy: true, idleSince: null, desktopViewing: false };
    idle.idle("h", Date.now());
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(stop).not.toHaveBeenCalled();
  });

  it("does nothing for a host with no idleStopMinutes, or an older server", async () => {
    state.minutes = undefined;
    idle.idle("h", Date.now());
    await vi.advanceTimersByTimeAsync(60 * MIN);
    state.minutes = 10;
    state.status = {};
    idle.idle("h", Date.now());
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(stop).not.toHaveBeenCalled();
  });

  it("counts the idleness the box measured, whatever its clock says", async () => {
    // The box's clock runs an hour ahead; it has been idle for 9 minutes.
    state.skewMs = 60 * MIN;
    state.status = { busy: false, idleSince: Date.now() + 60 * MIN - 9 * MIN, desktopViewing: false };
    idle.idle("h", Date.now() - 9 * MIN);
    await vi.advanceTimersByTimeAsync(MIN - 1);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("counts the idleness from the server's report", async () => {
    state.status = { busy: false, idleSince: Date.now() - 9 * MIN, desktopViewing: false };
    idle.idle("h", Date.now() - 9 * MIN);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
