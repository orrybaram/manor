/**
 * The reconnect loop's pre-attempt check (ADR-229 D1): a host whose provider
 * says the box is asleep stops the loop without reporting anything, and the
 * connect that wakes it reports the sessions as reconnected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReconnectSupervisor, type ReconnectTarget } from "../reconnect-supervisor";

function fakeTarget(sessions: string[] = ["pane-a"]) {
  let connected = false;
  const target = {
    connect: vi.fn(async (): Promise<void> => {
      throw new Error("box is down");
    }),
    isConnected: () => connected,
    generation: () => 0,
    wantedSessions: () => sessions,
    giveUp: vi.fn(),
  } satisfies ReconnectTarget;
  return {
    target,
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
}

describe("ReconnectSupervisor beforeAttempt (ADR-229 D1)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops before an attempt it is told not to make, reporting nothing", async () => {
    const { target } = fakeTarget();
    const supervisor = new ReconnectSupervisor(target);
    const listener = { onFailed: vi.fn(), onReconnected: vi.fn(), onLost: vi.fn() };
    supervisor.setListener(listener);
    // The first attempt goes; the box is asleep by the second.
    const beforeAttempt = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    supervisor.setPolicy(() => 1, { beforeAttempt });

    supervisor.connectionLost();
    await vi.waitFor(() => expect(supervisor.reconnecting).toBe(false));

    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(target.connect).toHaveBeenCalledTimes(1);
    expect(listener.onFailed).not.toHaveBeenCalled();
    expect(target.giveUp).not.toHaveBeenCalled();
  });

  it("reports the stopped loop's sessions when a later connect succeeds", async () => {
    const { target } = fakeTarget(["pane-a"]);
    const supervisor = new ReconnectSupervisor(target);
    const onReconnected = vi.fn();
    supervisor.setListener({ onReconnected });
    supervisor.setPolicy(() => 1, { beforeAttempt: async () => false });

    supervisor.connectionLost();
    await vi.waitFor(() => expect(supervisor.reconnecting).toBe(false));
    expect(target.connect).not.toHaveBeenCalled();

    // The wake: a connect outside the loop.
    supervisor.connectedOutsideLoop();
    expect(onReconnected).toHaveBeenCalledWith({ sessionIds: ["pane-a"], attempts: 1 });
  });

  it("goes on attempting when the check rejects", async () => {
    const { target, setConnected } = fakeTarget();
    target.connect.mockImplementationOnce(async () => {
      setConnected(true);
    });
    const supervisor = new ReconnectSupervisor(target);
    const onReconnected = vi.fn();
    supervisor.setListener({ onReconnected });
    supervisor.setPolicy(() => 1, {
      beforeAttempt: async () => {
        throw new Error("status unavailable");
      },
    });

    supervisor.connectionLost();
    await vi.waitFor(() => expect(onReconnected).toHaveBeenCalled());
    expect(target.connect).toHaveBeenCalledTimes(1);
  });
});
