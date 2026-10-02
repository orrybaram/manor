/**
 * The controller holds the two policies the UI must not be able to violate:
 * nothing starts by itself, and turning remote control off takes the relay
 * with it. Both are asserted here against fakes, so the test is about the
 * decisions rather than about sockets.
 *
 * The runtime (gate + relay) loads lazily (ADR-205 §3), so the second half
 * covers what happens before it loads and what happens when calls race the
 * load — above all, that shutdown never leaves anything running.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  RemoteControlController,
  type RemoteControlRuntime,
} from "../controller";
import type { RemoteDeviceStore } from "../devices";
import type { PushManager } from "../push";
import type { RelayConnector } from "../relay/connector";
import type { RelayIdentityStore } from "../relay/identity";
import { parseFragment } from "../../../src/bridge/web-pairing";
import { base64urlEncode } from "../../../src/lib/relay-crypto";

const ROOM = "AbCdEfGhIjKlMnOpQr_-01";
const KEY = base64urlEncode(new Uint8Array(32).fill(9));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakes(options: { gateLoad?: boolean } = {}) {
  const order: string[] = [];
  const seenListeners: Array<() => void> = [];
  const gate = {
    open: vi.fn(),
    close: vi.fn(() => order.push("gate")),
    closeDevice: vi.fn((id: string) => order.push(`close:${id}`)),
    onDeviceSeen: vi.fn((cb: () => void) => {
      seenListeners.push(cb);
      return () => {};
    }),
    /** Test hook: a hello was accepted. */
    seen: () => seenListeners.forEach((cb) => cb()),
  };

  let relayStatus: { state: string; url: string | null; error: null } = {
    state: "stopped",
    url: null,
    error: null,
  };
  const relayListeners: Array<(s: unknown) => void> = [];
  const relay = {
    get status() {
      return relayStatus;
    },
    origin: "https://relay.example.test",
    onStatus: (cb: (s: unknown) => void) => {
      relayListeners.push(cb);
      return () => {};
    },
    start: vi.fn(() => {
      relayStatus = {
        state: "running",
        url: "https://relay.example.test",
        error: null,
      };
      for (const cb of relayListeners) cb(relayStatus);
    }),
    stop: vi.fn(() => {
      order.push("relay");
      relayStatus = { state: "stopped", url: null, error: null };
      for (const cb of relayListeners) cb(relayStatus);
    }),
  };
  const identityState = { roomId: ROOM };
  const identity = {
    describe: () => ({
      roomId: identityState.roomId,
      x25519Pub: KEY,
    }),
    reset: vi.fn(() => {
      order.push("identity");
      return { roomId: "new", x25519Pub: "new" };
    }),
  };

  const paired: Array<{
    id: string;
    label: string;
    relayRoom: string;
  }> = [];
  let minted = 0;
  const deviceStore = {
    pair: vi.fn((label: string, relayRoom: string) => {
      minted += 1;
      const device = {
        id: `dev-${minted}`,
        label,
        relayRoom,
        createdAt: 0,
        lastSeenAt: null,
      };
      paired.push(device);
      return { device, rawToken: "raw-token-value" };
    }),
    revoke: vi.fn((id: string) => {
      order.push(`revoke:${id}`);
      const i = paired.findIndex((d) => d.id === id);
      if (i >= 0) paired.splice(i, 1);
    }),
    list: () => [...paired],
    ids: () => paired.map((d) => d.id),
    idsInOtherRelayRooms: (roomId: string) =>
      paired.filter((d) => d.relayRoom !== roomId).map((d) => d.id),
  };

  const runtime = {
    gate,
    relay: relay as unknown as RelayConnector,
    relayIdentity: identity as unknown as RelayIdentityStore,
  } as unknown as RemoteControlRuntime;
  // With `gateLoad`, the load hangs until the test calls `releaseLoad()`, so a
  // test can act while it is in flight.
  const held = deferred<void>();
  const loadRuntime = vi.fn(async () => {
    if (options.gateLoad) await held.promise;
    return runtime;
  });
  const push = { notify: vi.fn(async () => 1) };

  const controller = new RemoteControlController(
    loadRuntime,
    deviceStore as unknown as RemoteDeviceStore,
    () => true,
    push as unknown as PushManager,
    "1.2.3",
  );
  return {
    controller,
    gate,
    deviceStore,
    loadRuntime,
    push,
    releaseLoad: () => held.resolve(),
    relay,
    identity,
    identityState,
    order,
  };
}

describe("RemoteControlController", () => {
  let f: ReturnType<typeof fakes>;

  beforeEach(() => {
    f = fakes();
  });

  it("starts disabled with no relay", () => {
    expect(f.controller.status()).toMatchObject({
      enabled: false,
      relay: { state: "stopped" },
    });
    expect(f.gate.open).not.toHaveBeenCalled();
    expect(f.relay.start).not.toHaveBeenCalled();
  });

  it("enabling loads the runtime and opens nothing to the network", async () => {
    const status = await f.controller.setEnabled(true);
    expect(status.enabled).toBe(true);
    expect(status).not.toHaveProperty("port");
    expect(f.gate.open).toHaveBeenCalledTimes(1);
    expect(f.relay.start).not.toHaveBeenCalled();
  });

  it("notifies listeners on every state change", async () => {
    const seen: boolean[] = [];
    f.controller.onChange((s) => seen.push(s.enabled));
    await f.controller.setEnabled(true);
    f.controller.pair("phone");
    f.controller.revoke("dev-1");
    await f.controller.setEnabled(false);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it("revoke closes the revoked device's connections", async () => {
    // A connection needs the relay, so the runtime.
    await f.controller.setEnabled(true);
    f.controller.pair("a");
    f.controller.pair("b");
    f.controller.revoke("dev-1");
    expect(f.gate.closeDevice).toHaveBeenCalledTimes(1);
    expect(f.gate.closeDevice).toHaveBeenCalledWith("dev-1");
  });

  it("surfaces an unavailable keychain rather than hiding it", () => {
    const c = new RemoteControlController(
      async () => {
        throw new Error("not loaded in this test");
      },
      { list: () => [] } as unknown as RemoteDeviceStore,
      () => false,
    );
    expect(c.status().encryptionAvailable).toBe(false);
  });

  describe("relay (ADR-206)", () => {
    it("is never started by enabling", async () => {
      await f.controller.setEnabled(true);
      expect(f.relay.start).not.toHaveBeenCalled();
      expect(f.controller.status().relay.state).toBe("stopped");
    });

    it("requires remote control to be enabled", async () => {
      await expect(f.controller.startRelay()).rejects.toThrow(
        /Enable remote control/,
      );
      expect(f.relay.start).not.toHaveBeenCalled();
    });

    it("pushes relay status changes", async () => {
      await f.controller.setEnabled(true);
      const seen: string[] = [];
      f.controller.onChange((s) => seen.push(s.relay.state));
      await f.controller.startRelay();
      expect(seen).toContain("running");
    });

    it("pushes a fresh status when a device says hello", async () => {
      await f.controller.setEnabled(true);
      const listener = vi.fn();
      f.controller.onChange(listener);
      f.gate.seen();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("disabling stops the relay before closing the gate", async () => {
      await f.controller.setEnabled(true);
      await f.controller.startRelay();
      f.order.length = 0;
      await f.controller.setEnabled(false);
      expect(f.order).toEqual(["relay", "gate"]);
      expect(f.controller.status().relay.state).toBe("stopped");
      expect(f.controller.status().enabled).toBe(false);
    });

    it("a Start relay racing a disable cannot outlive it", async () => {
      await f.controller.setEnabled(true);
      // Both are in flight at once: the disable has dropped its intent but
      // not yet turned anything off when the relay start is queued.
      const disabling = f.controller.setEnabled(false);
      const starting = f.controller.startRelay();
      await disabling;
      await expect(starting).rejects.toThrow(/Enable remote control/);
      expect(f.relay.start).not.toHaveBeenCalled();
      expect(f.controller.status().relay.state).toBe("stopped");
    });

    it("shutdown stops the relay before closing the gate", async () => {
      await f.controller.setEnabled(true);
      await f.controller.startRelay();
      f.order.length = 0;
      await f.controller.shutdown();
      expect(f.order).toEqual(["relay", "gate"]);
    });

    it("refuses to pair while the relay address is not configured", async () => {
      await f.controller.setEnabled(true);
      expect(f.controller.status().relayOrigin).toBe(
        "https://relay.example.test",
      );
      expect(f.controller.status().relayAppUrl).toBe(
        "https://relay.example.test/app/1.2.3/",
      );
      (f.relay as { origin: string | null }).origin = null;
      expect(f.controller.status().relayOrigin).toBeNull();
      expect(f.controller.status().relayAppUrl).toBeNull();
      expect(() => f.controller.pair("p")).toThrow(/not configured/);
      expect(f.deviceStore.pair).not.toHaveBeenCalled();
    });

    it("builds a relay link the browser's parser accepts", async () => {
      await f.controller.setEnabled(true);
      const result = f.controller.pair("browser");
      expect(result.pairingUrl).toBe(
        `https://relay.example.test/app/1.2.3/#relay=${ROOM}.${KEY}&t=raw-token-value`,
      );
      expect(f.deviceStore.pair).toHaveBeenCalledWith("browser", ROOM);
      const hash = result.pairingUrl.slice(result.pairingUrl.indexOf("#"));
      expect(parseFragment(hash)).toEqual({
        kind: "relay",
        relay: { roomId: ROOM, serverKey: KEY, token: "raw-token-value" },
      });
    });

    it("reports how many viewers came through the relay", async () => {
      expect(f.controller.status().relayViewers).toBe(0);
      await f.controller.setEnabled(true);
      expect(f.controller.status().relayViewers).toBe(0);
      (f.relay as unknown as { channelCount: number }).channelCount = 2;
      expect(f.controller.status().relayViewers).toBe(2);
    });

    it("reset revokes every device and stops the relay", async () => {
      await f.controller.setEnabled(true);
      f.controller.pair("a");
      f.controller.pair("b");
      await f.controller.startRelay();
      const status = await f.controller.resetRelayAddress();
      expect(f.relay.stop).toHaveBeenCalled();
      expect(f.identity.reset).toHaveBeenCalled();
      expect(status.relay.state).toBe("stopped");
      expect(status.devices).toEqual([]);
    });

    it("reset closes devices while the relay is still up, then stops it", async () => {
      await f.controller.setEnabled(true);
      f.controller.pair("rl1");
      f.controller.pair("rl2");
      await f.controller.startRelay();
      f.order.length = 0;
      await f.controller.resetRelayAddress();
      // 4401 has to travel through the live relay; after `stop` it cannot.
      expect(f.order).toEqual([
        "revoke:dev-1",
        "close:dev-1",
        "revoke:dev-2",
        "close:dev-2",
        "relay",
        "identity",
      ]);
    });

    describe("an identity that changed underneath the devices", () => {
      it("revokes devices paired to the old room when the relay starts", async () => {
        await f.controller.setEnabled(true);
        f.controller.pair("old");
        // Already on the room the identity is about to become.
        f.deviceStore.pair("current", "another-room-entirely");
        // The identity file could not be read; the store made a new room.
        f.identityState.roomId = "another-room-entirely";
        const status = await f.controller.startRelay();
        expect(status.devices.map((d) => d.label)).toEqual(["current"]);
        expect(f.gate.closeDevice).toHaveBeenCalledWith("dev-1");
        expect(status.relayNotice).toMatch(/couldn't be read.*1 device/);
      });

      it("says nothing when the room is the one the devices were paired to", async () => {
        await f.controller.setEnabled(true);
        f.controller.pair("rl");
        const status = await f.controller.startRelay();
        expect(status.devices).toHaveLength(1);
        expect(status.relayNotice).toBeNull();
      });

      it("a reset clears the notice", async () => {
        await f.controller.setEnabled(true);
        f.controller.pair("rl");
        f.identityState.roomId = "another-room-entirely";
        await f.controller.startRelay();
        const status = await f.controller.resetRelayAddress();
        expect(status.relayNotice).toBeNull();
      });
    });
  });
});

const AGENT = { id: "agent-1", name: "fix it", projectName: "manor" };

describe("RemoteControlController before the runtime loads", () => {
  let f: ReturnType<typeof fakes>;

  beforeEach(() => {
    f = fakes();
  });

  it("reports disabled, no viewers and a stopped relay", () => {
    expect(f.controller.status()).toEqual({
      enabled: false,
      devices: [],
      encryptionAvailable: true,
      relay: { state: "stopped", url: null, error: null },
      relayOrigin: null,
      relayAppUrl: null,
      relayViewers: 0,
      relayNotice: null,
    });
    expect(f.loadRuntime).not.toHaveBeenCalled();
  });

  it("loads once when enabled, even when enabled concurrently", async () => {
    const [a, b] = await Promise.all([
      f.controller.setEnabled(true),
      f.controller.setEnabled(true),
    ]);
    expect(a.enabled).toBe(true);
    expect(b.enabled).toBe(true);
    expect(f.loadRuntime).toHaveBeenCalledTimes(1);
    expect(f.gate.open).toHaveBeenCalledTimes(1);

    await f.controller.setEnabled(true);
    expect(f.loadRuntime).toHaveBeenCalledTimes(1);
  });

  it("does not load to disable, stop the relay, or shut down", async () => {
    const status = await f.controller.setEnabled(false);
    await f.controller.stopRelay();
    await f.controller.shutdown();
    expect(status.enabled).toBe(false);
    expect(f.loadRuntime).not.toHaveBeenCalled();
    expect(f.gate.close).not.toHaveBeenCalled();
    expect(f.relay.stop).not.toHaveBeenCalled();
  });

  it("refuses to pair until the runtime is loaded", () => {
    expect(() => f.controller.pair("p")).toThrow(/Enable remote control/);
    expect(f.deviceStore.pair).not.toHaveBeenCalled();
    expect(f.loadRuntime).not.toHaveBeenCalled();
  });

  it("revoking with the runtime never loaded closes nothing and loads nothing", () => {
    f.deviceStore.pair("a", ROOM);
    f.controller.revoke("dev-1");
    expect(f.gate.closeDevice).not.toHaveBeenCalled();
    expect(f.loadRuntime).not.toHaveBeenCalled();
  });

  it("still pushes an agent status without loading", () => {
    expect(() =>
      f.controller.onAgentStatus(AGENT, "working", "requires_input", {
        notify: true,
      }),
    ).not.toThrow();
    expect(f.push.notify).toHaveBeenCalledTimes(1);
    expect(f.loadRuntime).not.toHaveBeenCalled();
  });

  it("does not push a status that is not worth one", async () => {
    await f.controller.setEnabled(true);
    f.controller.onAgentStatus(AGENT, "working", "idle", { notify: true });
    expect(f.push.notify).not.toHaveBeenCalled();
  });

  it("lets a failed load be retried", async () => {
    f.loadRuntime.mockRejectedValueOnce(new Error("chunk missing"));
    await expect(f.controller.setEnabled(true)).rejects.toThrow(/chunk/);
    expect(f.controller.status().enabled).toBe(false);
    const status = await f.controller.setEnabled(true);
    expect(status.enabled).toBe(true);
    expect(f.loadRuntime).toHaveBeenCalledTimes(2);
  });
});

describe("RemoteControlController racing the runtime load", () => {
  it("shutdown during an in-flight load leaves nothing running", async () => {
    const f = fakes({ gateLoad: true });
    const enabling = f.controller.setEnabled(true);
    const shuttingDown = f.controller.shutdown();
    f.releaseLoad();
    await Promise.all([enabling, shuttingDown]);

    expect(f.controller.status().enabled).toBe(false);
    expect(f.controller.status().relay.state).toBe("stopped");
    expect(f.gate.open).not.toHaveBeenCalled();
    expect(f.relay.start).not.toHaveBeenCalled();
  });

  it("nothing starts after shutdown", async () => {
    const f = fakes();
    await f.controller.shutdown();
    const status = await f.controller.setEnabled(true);
    expect(status.enabled).toBe(false);
    await expect(f.controller.startRelay()).rejects.toThrow();
    expect(f.loadRuntime).not.toHaveBeenCalled();
  });

  it("an enable overtaken by a disable does not leave remote control on", async () => {
    const f = fakes({ gateLoad: true });
    const enabling = f.controller.setEnabled(true);
    const disabling = f.controller.setEnabled(false);
    f.releaseLoad();
    await Promise.all([enabling, disabling]);
    expect(f.controller.status().enabled).toBe(false);
    expect(f.gate.open).not.toHaveBeenCalled();
  });
});
