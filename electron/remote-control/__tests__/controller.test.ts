/**
 * The controller holds the two policies the UI must not be able to violate:
 * nothing starts by itself, and turning remote control off takes the tunnel
 * with it. Both are asserted here against fakes, so the test is about the
 * decisions rather than about sockets.
 *
 * The runtime (listener + tunnel manager) loads lazily (ADR-205 §3), so the
 * second half covers what happens before it loads and what happens when calls
 * race the load — above all, that shutdown never leaves anything running.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  RemoteControlController,
  type RemoteControlRuntime,
} from "../controller";
import type { Capability, RemoteDeviceStore } from "../devices";
import type { PushManager } from "../push";
import type { RelayConnector } from "../relay/connector";
import type { RelayIdentityStore } from "../relay/identity";
import { parseFragment } from "../../../src/bridge/web-pairing";
import { base64urlEncode } from "../../../src/lib/relay-crypto";
import type { TailnetInfo, TunnelStatus } from "../tunnel";

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
  const serverState = { running: false, port: 0, listeners: 0 };
  const server = {
    get running() {
      return serverState.running;
    },
    get serverPort() {
      return serverState.port;
    },
    get listenerCount() {
      return serverState.listeners;
    },
    closeDevice: vi.fn((id: string) => order.push(`close:${id}`)),
    start: vi.fn(async () => {
      serverState.running = true;
      serverState.port = 51234;
      return { port: 51234 };
    }),
    stop: vi.fn(async () => {
      serverState.running = false;
      serverState.port = 0;
    }),
  };

  let tunnelStatus: TunnelStatus = {
    state: "stopped",
    url: null,
    error: null,
  };
  const tunnelListeners: Array<(s: TunnelStatus) => void> = [];
  const tunnel = {
    get status() {
      return tunnelStatus;
    },
    onStatus: (cb: (s: TunnelStatus) => void) => {
      tunnelListeners.push(cb);
      return () => {};
    },
    tailnet: vi.fn(
      async (): Promise<TailnetInfo | null> => ({
        account: "me@example.com",
        peers: [],
      }),
    ),
    detect: vi.fn(async () => true),
    start: vi.fn(async () => {
      tunnelStatus = {
        state: "running",
        url: "https://studio.tail1234.ts.net",
        error: null,
      };
      for (const cb of tunnelListeners) cb(tunnelStatus);
      return { url: tunnelStatus.url! };
    }),
    stop: vi.fn(async () => {
      tunnelStatus = { state: "stopped", url: null, error: null };
      for (const cb of tunnelListeners) cb(tunnelStatus);
    }),
  };

  const order: string[] = [];
  server.stop.mockImplementation(async () => {
    order.push("server");
    serverState.running = false;
    serverState.port = 0;
  });

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
    capability: Capability;
    via?: string;
    relayRoom?: string | null;
  }> = [];
  const deviceStore = {
    pair: vi.fn(
      (
        label: string,
        capability: Capability,
        via = "tailscale",
        relayRoom: string | null = null,
      ) => {
        const device = {
          id: `dev-${paired.length + 1}`,
          label,
          capability,
          via,
          relayRoom,
          createdAt: 0,
          lastSeenAt: null,
        };
        paired.push(device);
        return { device, rawToken: "raw-token-value" };
      },
    ),
    revoke: vi.fn((id: string) => {
      order.push(`revoke:${id}`);
      const i = paired.findIndex((d) => d.id === id);
      if (i >= 0) paired.splice(i, 1);
    }),
    list: () => [...paired],
    idsVia: (via: string) =>
      paired.filter((d) => d.via === via).map((d) => d.id),
    idsInOtherRelayRooms: (roomId: string) =>
      paired
        .filter(
          (d) => d.via === "relay" && d.relayRoom && d.relayRoom !== roomId,
        )
        .map((d) => d.id),
  };

  const runtime = {
    server,
    tunnel,
    relay: relay as unknown as RelayConnector,
    relayIdentity: identity as unknown as RelayIdentityStore,
  } as unknown as RemoteControlRuntime;
  // With `gateLoad`, the load hangs until the test calls `releaseLoad()`, so a
  // test can act while it is in flight.
  const gate = deferred<void>();
  const loadRuntime = vi.fn(async () => {
    if (options.gateLoad) await gate.promise;
    return runtime;
  });
  const which = vi.fn(
    async (bin: string): Promise<string | null> => `/usr/bin/${bin}`,
  );
  const push = { notify: vi.fn(async () => 1) };

  const controller = new RemoteControlController(
    loadRuntime,
    deviceStore as unknown as RemoteDeviceStore,
    which,
    () => true,
    push as unknown as PushManager,
    "1.2.3",
  );
  return {
    controller,
    server,
    tunnel,
    deviceStore,
    loadRuntime,
    which,
    push,
    releaseLoad: () => gate.resolve(),
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

  it("starts disabled with no tunnel", () => {
    expect(f.controller.status()).toMatchObject({
      enabled: false,
      port: null,
      tunnel: { state: "stopped" },
    });
    expect(f.server.start).not.toHaveBeenCalled();
    expect(f.tunnel.start).not.toHaveBeenCalled();
  });

  it("enabling starts the listener but never the tunnel", async () => {
    const status = await f.controller.setEnabled(true);
    expect(status.enabled).toBe(true);
    expect(status.port).toBe(51234);
    expect(f.tunnel.start).not.toHaveBeenCalled();
    expect(status.tunnel.state).toBe("stopped");
  });

  it("enabling probes for tunnel tools without installing anything", async () => {
    const status = await f.controller.setEnabled(true);
    expect(f.which).toHaveBeenCalledWith("tailscale");
    expect(status.installed).toBe(true);
  });

  it("disabling stops the tunnel before the listener", async () => {
    await f.controller.setEnabled(true);
    await f.controller.startTunnel();
    const order: string[] = [];
    f.tunnel.stop.mockImplementation(async () => {
      order.push("tunnel");
    });
    f.server.stop.mockImplementation(async () => {
      order.push("server");
    });

    await f.controller.setEnabled(false);
    expect(order).toEqual(["tunnel", "server"]);
  });

  it("refuses to start a tunnel while disabled", async () => {
    await expect(f.controller.startTunnel()).rejects.toThrow(
      /Enable remote control/,
    );
    expect(f.tunnel.start).not.toHaveBeenCalled();
  });

  it("starts tailscale and points the tunnel at the listener's port", async () => {
    await f.controller.setEnabled(true);
    const status = await f.controller.startTunnel();
    expect(f.tunnel.start).toHaveBeenCalledWith(51234);
    expect(status.tunnel).toMatchObject({
      state: "running",
      url: "https://studio.tail1234.ts.net",
    });
  });

  it("does not report a cancelled start as an error", async () => {
    await f.controller.setEnabled(true);
    f.tunnel.start.mockRejectedValueOnce(
      Object.assign(new Error("Tunnel start was cancelled"), {
        cancelled: true,
      }),
    );
    await expect(f.controller.startTunnel()).resolves.toMatchObject({
      tunnel: { state: "stopped" },
    });
  });

  it("still throws a real start failure", async () => {
    await f.controller.setEnabled(true);
    f.tunnel.start.mockRejectedValueOnce(new Error("boom"));
    await expect(f.controller.startTunnel()).rejects.toThrow("boom");
  });

  it("reports the tailnet while the tunnel runs, and forgets it after", async () => {
    await f.controller.setEnabled(true);
    expect(f.controller.status().tailnet).toBeNull();
    await f.controller.startTunnel();
    await vi.waitFor(() =>
      expect(f.controller.status().tailnet).toEqual({
        account: "me@example.com",
        peers: [],
      }),
    );
    await f.controller.stopTunnel();
    expect(f.controller.status().tailnet).toBeNull();
  });

  it("notices a phone joining the tailnet", async () => {
    vi.useFakeTimers();
    try {
      await f.controller.setEnabled(true);
      await f.controller.startTunnel();
      await vi.advanceTimersByTimeAsync(0);
      f.tunnel.tailnet.mockResolvedValue({
        account: "me@example.com",
        peers: [{ name: "iphone", os: "iOS", online: true }],
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.controller.status().tailnet?.peers).toHaveLength(1);
      await f.controller.stopTunnel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains itself when tailscale is not installed", async () => {
    await f.controller.setEnabled(true);
    f.tunnel.detect.mockResolvedValueOnce(false);
    await expect(f.controller.startTunnel()).rejects.toThrow(/not installed/);
  });

  it("builds a pairing URL from the live tunnel", async () => {
    await f.controller.setEnabled(true);
    await f.controller.startTunnel();
    const result = f.controller.pair("Orry's phone", "read");
    expect(result.pairingUrl).toBe(
      "https://studio.tail1234.ts.net/#raw-token-value",
    );
    expect(result.device.capability).toBe("read");
  });

  it("sends a full-capability device to the web app, not the phone client", async () => {
    await f.controller.setEnabled(true);
    await f.controller.startTunnel();
    expect(f.controller.pair("PC browser", "full").pairingUrl).toBe(
      "https://studio.tail1234.ts.net/app#raw-token-value",
    );
    expect(f.controller.pair("phone", "send").pairingUrl).toBe(
      "https://studio.tail1234.ts.net/#raw-token-value",
    );
  });

  it("pairs without a tunnel but has no URL to offer", async () => {
    await f.controller.setEnabled(true);
    expect(f.controller.pair("phone", "read").pairingUrl).toBeNull();
  });

  it("names the page even without a tunnel, so the loopback link is right", async () => {
    // The pairing dialog builds the no-tunnel link itself, from the port and
    // this field. Without it the dialog guessed, and guessed `/` for every
    // tier — so a `full` device testing over loopback was sent to the phone
    // client instead of the web app.
    await f.controller.setEnabled(true);
    expect(f.controller.pair("PC browser", "full").page).toBe("/app");
    expect(f.controller.pair("phone", "send").page).toBe("/");
    expect(f.controller.pair("watcher", "read").page).toBe("/");
  });

  it("notifies listeners on every state change", async () => {
    const seen: boolean[] = [];
    f.controller.onChange((s) => seen.push(s.enabled));
    await f.controller.setEnabled(true);
    f.controller.pair("phone", "read");
    f.controller.revoke("dev-1");
    await f.controller.setEnabled(false);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it("reflects a tunnel that died on its own", async () => {
    await f.controller.setEnabled(true);
    await f.controller.startTunnel();
    const seen: string[] = [];
    f.controller.onChange((s) => seen.push(s.tunnel.state));
    await f.tunnel.stop();
    expect(seen).toContain("stopped");
  });

  it("shutdown stops both, in that order", async () => {
    await f.controller.setEnabled(true);
    await f.controller.startTunnel();
    await f.controller.shutdown();
    expect(f.tunnel.stop).toHaveBeenCalled();
    expect(f.server.stop).toHaveBeenCalled();
    expect(f.controller.status().enabled).toBe(false);
  });

  it("revoke closes the revoked device's connections", async () => {
    // A connection needs the listener or the relay, so the runtime.
    await f.controller.setEnabled(true);
    f.controller.pair("a", "full");
    f.controller.pair("b", "full");
    f.controller.revoke("dev-1");
    expect(f.server.closeDevice).toHaveBeenCalledTimes(1);
    expect(f.server.closeDevice).toHaveBeenCalledWith("dev-1");
  });

  it("surfaces an unavailable keychain rather than hiding it", () => {
    const c = new RemoteControlController(
      async () => {
        throw new Error("not loaded in this test");
      },
      { list: () => [] } as unknown as RemoteDeviceStore,
      async () => null,
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

    it("disabling stops the relay before the listener", async () => {
      await f.controller.setEnabled(true);
      await f.controller.startRelay();
      f.order.length = 0;
      await f.controller.setEnabled(false);
      expect(f.order).toEqual(["relay", "server"]);
      expect(f.controller.status().relay.state).toBe("stopped");
    });

    it("a Start relay racing a disable cannot outlive it", async () => {
      await f.controller.setEnabled(true);
      // Hold the disable inside `tunnel.stop`, where the listener is still up.
      let release!: () => void;
      f.tunnel.stop.mockImplementationOnce(
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      const disabling = f.controller.setEnabled(false);
      const starting = f.controller.startRelay();
      await Promise.resolve();
      release();
      await disabling;
      await expect(starting).rejects.toThrow(/Enable remote control/);
      expect(f.relay.start).not.toHaveBeenCalled();
      expect(f.controller.status().relay.state).toBe("stopped");
    });

    it("refuses to start a tunnel while a disable is in flight", async () => {
      await f.controller.setEnabled(true);
      let release!: () => void;
      f.tunnel.stop.mockImplementationOnce(
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      const disabling = f.controller.setEnabled(false);
      // Let the disable reach `tunnel.stop`.
      await new Promise((r) => setTimeout(r, 0));
      await expect(f.controller.startTunnel()).rejects.toThrow(
        /Enable remote control/,
      );
      release();
      await disabling;
      expect(f.tunnel.start).not.toHaveBeenCalled();
    });

    it("shutdown stops the relay before the listener", async () => {
      await f.controller.setEnabled(true);
      await f.controller.startRelay();
      f.order.length = 0;
      await f.controller.shutdown();
      expect(f.order).toEqual(["relay", "server"]);
    });

    it("refuses a relay pairing below full", async () => {
      await f.controller.setEnabled(true);
      expect(() => f.controller.pair("p", "read", "relay")).toThrow(
        /Everything/,
      );
      expect(() => f.controller.pair("p", "send", "relay")).toThrow(
        /Everything/,
      );
      expect(f.deviceStore.pair).not.toHaveBeenCalled();
    });

    it("builds a relay link the browser's parser accepts", async () => {
      await f.controller.setEnabled(true);
      const result = f.controller.pair("browser", "full", "relay");
      expect(result.pairingUrl).toBe(
        `https://relay.example.test/app/1.2.3/#relay=${ROOM}.${KEY}&t=raw-token-value`,
      );
      expect(f.deviceStore.pair).toHaveBeenCalledWith(
        "browser",
        "full",
        "relay",
        ROOM,
      );
      const hash = result.pairingUrl!.slice(result.pairingUrl!.indexOf("#"));
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

    it("reset revokes only relay devices and stops the relay", async () => {
      await f.controller.setEnabled(true);
      f.controller.pair("ts", "full");
      f.controller.pair("rl", "full", "relay");
      await f.controller.startRelay();
      const status = await f.controller.resetRelayAddress();
      expect(f.relay.stop).toHaveBeenCalled();
      expect(f.identity.reset).toHaveBeenCalled();
      expect(status.relay.state).toBe("stopped");
      expect(status.devices.map((d) => d.label)).toEqual(["ts"]);
    });

    it("reset closes relay devices while the relay is still up, then stops it", async () => {
      await f.controller.setEnabled(true);
      f.controller.pair("ts", "full");
      f.controller.pair("rl1", "full", "relay");
      f.controller.pair("rl2", "full", "relay");
      await f.controller.startRelay();
      f.order.length = 0;
      await f.controller.resetRelayAddress();
      // 4401 has to travel through the live relay; after `stop` it cannot.
      expect(f.order).toEqual([
        "revoke:dev-2",
        "close:dev-2",
        "revoke:dev-3",
        "close:dev-3",
        "relay",
        "identity",
      ]);
    });

    describe("an identity that changed underneath the devices", () => {
      it("revokes relay devices paired to the old room when the relay starts", async () => {
        await f.controller.setEnabled(true);
        f.controller.pair("ts", "full");
        f.controller.pair("rl", "full", "relay");
        // The identity file could not be read; the store made a new room.
        f.identityState.roomId = "another-room-entirely";
        const status = await f.controller.startRelay();
        expect(status.devices.map((d) => d.label)).toEqual(["ts"]);
        expect(f.server.closeDevice).toHaveBeenCalledWith("dev-2");
        expect(status.relayNotice).toMatch(/couldn't be read.*1 device/);
      });

      it("says nothing when the room is the one the devices were paired to", async () => {
        await f.controller.setEnabled(true);
        f.controller.pair("rl", "full", "relay");
        const status = await f.controller.startRelay();
        expect(status.devices).toHaveLength(1);
        expect(status.relayNotice).toBeNull();
      });

      it("a reset clears the notice", async () => {
        await f.controller.setEnabled(true);
        f.controller.pair("rl", "full", "relay");
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

  it("reports disabled, no port, no listeners and a stopped tunnel", () => {
    expect(f.controller.status()).toEqual({
      enabled: false,
      port: null,
      devices: [],
      tunnel: { state: "stopped", url: null, error: null },
      installed: false,
      tailnet: null,
      encryptionAvailable: true,
      listeners: 0,
      relay: { state: "stopped", url: null, error: null },
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
    expect(f.server.start).toHaveBeenCalledTimes(1);

    await f.controller.setEnabled(true);
    expect(f.loadRuntime).toHaveBeenCalledTimes(1);
  });

  it("subscribes to tunnel status once loaded", async () => {
    await f.controller.setEnabled(true);
    const seen: string[] = [];
    f.controller.onChange((s) => seen.push(s.tunnel.state));
    await f.controller.startTunnel();
    expect(seen).toContain("running");
  });

  it("does not load to disable, stop a tunnel or the relay, or shut down", async () => {
    const status = await f.controller.setEnabled(false);
    await f.controller.stopTunnel();
    await f.controller.stopRelay();
    f.controller.killTunnelNow();
    await f.controller.shutdown();
    expect(status.enabled).toBe(false);
    expect(f.loadRuntime).not.toHaveBeenCalled();
    expect(f.tunnel.stop).not.toHaveBeenCalled();
    expect(f.server.stop).not.toHaveBeenCalled();
    expect(f.relay.stop).not.toHaveBeenCalled();
  });

  it("refuses a relay pairing until the runtime is loaded", () => {
    expect(() => f.controller.pair("p", "full", "relay")).toThrow(
      /Enable remote control/,
    );
    expect(f.deviceStore.pair).not.toHaveBeenCalled();
    expect(f.loadRuntime).not.toHaveBeenCalled();
  });

  it("revoking with the runtime never loaded closes nothing and loads nothing", () => {
    f.controller.pair("a", "full");
    f.controller.revoke("dev-1");
    expect(f.server.closeDevice).not.toHaveBeenCalled();
    expect(f.loadRuntime).not.toHaveBeenCalled();
  });

  it("detects tunnel tools without loading", async () => {
    f.which.mockImplementation(async (bin: string) =>
      bin === "tailscale" ? "/usr/local/bin/tailscale" : null,
    );
    const status = await f.controller.refreshDetection();
    expect(status.installed).toBe(true);
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

  it("publishes an agent status to the listener once loaded", async () => {
    const publishStatus = vi.fn();
    (f.server as unknown as { publishStatus: typeof publishStatus }).publishStatus =
      publishStatus;
    await f.controller.setEnabled(true);
    f.controller.onAgentStatus(AGENT, "working", "idle", { notify: true });
    expect(publishStatus).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", status: "idle" }),
    );
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
    expect(f.controller.status().tunnel.state).toBe("stopped");
    expect(f.server.start).not.toHaveBeenCalled();
    expect(f.tunnel.start).not.toHaveBeenCalled();
  });

  it("shutdown during an in-flight tunnel start leaves no tunnel", async () => {
    const f = fakes({ gateLoad: true });
    const enabling = f.controller.setEnabled(true);
    f.releaseLoad();
    await enabling;

    // Hold the PATH probe open so shutdown lands before the spawn.
    const probe = deferred<boolean>();
    f.tunnel.detect.mockReturnValueOnce(probe.promise);
    const starting = f.controller.startTunnel();
    const shuttingDown = f.controller.shutdown();
    probe.resolve(true);

    await expect(starting).rejects.toThrow();
    await shuttingDown;
    expect(f.tunnel.start).not.toHaveBeenCalled();
    expect(f.controller.status()).toMatchObject({
      enabled: false,
      tunnel: { state: "stopped" },
    });
  });

  it("shutdown while the listener is binding stops it once bound", async () => {
    const f = fakes();
    const bound = deferred<void>();
    const realStart = f.server.start.getMockImplementation()!;
    f.server.start.mockImplementationOnce(async () => {
      await bound.promise;
      return realStart();
    });
    const enabling = f.controller.setEnabled(true);
    // Let the load settle so `start()` is the pending step.
    await vi.waitFor(() => expect(f.server.start).toHaveBeenCalled());
    const shuttingDown = f.controller.shutdown();
    bound.resolve();
    await Promise.all([enabling, shuttingDown]);
    expect(f.controller.status().enabled).toBe(false);
  });

  it("nothing starts after shutdown", async () => {
    const f = fakes();
    await f.controller.shutdown();
    const status = await f.controller.setEnabled(true);
    expect(status.enabled).toBe(false);
    await expect(f.controller.startTunnel()).rejects.toThrow();
    expect(f.loadRuntime).not.toHaveBeenCalled();
  });

  it("an enable overtaken by a disable does not leave the listener up", async () => {
    const f = fakes({ gateLoad: true });
    const enabling = f.controller.setEnabled(true);
    const disabling = f.controller.setEnabled(false);
    f.releaseLoad();
    await Promise.all([enabling, disabling]);
    expect(f.controller.status().enabled).toBe(false);
  });
});
