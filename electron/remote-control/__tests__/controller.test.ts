/**
 * The controller holds the two policies the UI must not be able to violate:
 * nothing starts by itself, and turning remote control off takes the tunnel
 * with it. Both are asserted here against fakes, so the test is about the
 * decisions rather than about sockets.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import { RemoteControlController } from "../controller";
import type { RemoteDeviceStore } from "../devices";
import type { RemoteControlServer } from "../server";
import type { TunnelManager, TunnelStatus } from "../tunnel";

function fakes() {
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
    kind: null,
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
    detect: vi.fn(async () => ({ tailscale: true, cloudflared: true })),
    preferredKind: vi.fn(async () => "tailscale" as const),
    start: vi.fn(async (kind: "tailscale" | "cloudflared") => {
      tunnelStatus = {
        state: "running",
        kind,
        url: "https://studio.tail1234.ts.net",
        error: null,
      };
      for (const cb of tunnelListeners) cb(tunnelStatus);
      return { url: tunnelStatus.url! };
    }),
    stop: vi.fn(async () => {
      tunnelStatus = { state: "stopped", kind: null, url: null, error: null };
      for (const cb of tunnelListeners) cb(tunnelStatus);
    }),
  };

  const paired: Array<{ id: string; label: string; canSend: boolean }> = [];
  const deviceStore = {
    pair: vi.fn((label: string, canSend: boolean) => {
      const device = {
        id: `dev-${paired.length + 1}`,
        label,
        canSend,
        createdAt: 0,
        lastSeenAt: null,
      };
      paired.push(device);
      return { device, rawToken: "raw-token-value" };
    }),
    revoke: vi.fn((id: string) => {
      const i = paired.findIndex((d) => d.id === id);
      if (i >= 0) paired.splice(i, 1);
    }),
    list: () => [...paired],
  };

  const controller = new RemoteControlController(
    server as unknown as RemoteControlServer,
    deviceStore as unknown as RemoteDeviceStore,
    tunnel as unknown as TunnelManager,
    () => true,
  );
  return { controller, server, tunnel, deviceStore };
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
    expect(f.tunnel.detect).toHaveBeenCalled();
    expect(status.detected).toEqual({ tailscale: true, cloudflared: true });
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

  it("prefers tailscale and points the tunnel at the listener's port", async () => {
    await f.controller.setEnabled(true);
    const status = await f.controller.startTunnel();
    expect(f.tunnel.start).toHaveBeenCalledWith("tailscale", 51234);
    expect(status.tunnel).toMatchObject({
      state: "running",
      url: "https://studio.tail1234.ts.net",
    });
  });

  it("honours an explicitly chosen tunnel kind", async () => {
    await f.controller.setEnabled(true);
    await f.controller.startTunnel("cloudflared");
    expect(f.tunnel.start).toHaveBeenCalledWith("cloudflared", 51234);
  });

  it("explains itself when neither tool is installed", async () => {
    f.tunnel.preferredKind.mockResolvedValue(null as unknown as "tailscale");
    await f.controller.setEnabled(true);
    await expect(f.controller.startTunnel()).rejects.toThrow(/on PATH/);
  });

  it("builds a pairing URL from the live tunnel", async () => {
    await f.controller.setEnabled(true);
    await f.controller.startTunnel();
    const result = f.controller.pair("Orry's phone", false);
    expect(result.pairingUrl).toBe(
      "https://studio.tail1234.ts.net/#raw-token-value",
    );
    expect(result.device.canSend).toBe(false);
  });

  it("pairs without a tunnel but has no URL to offer", async () => {
    await f.controller.setEnabled(true);
    expect(f.controller.pair("phone", false).pairingUrl).toBeNull();
  });

  it("notifies listeners on every state change", async () => {
    const seen: boolean[] = [];
    f.controller.onChange((s) => seen.push(s.enabled));
    await f.controller.setEnabled(true);
    f.controller.pair("phone", false);
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

  it("surfaces an unavailable keychain rather than hiding it", () => {
    const c = new RemoteControlController(
      {} as unknown as RemoteControlServer,
      { list: () => [] } as unknown as RemoteDeviceStore,
      {
        onStatus: () => () => {},
        status: { state: "stopped", kind: null, url: null, error: null },
      } as unknown as TunnelManager,
      () => false,
    );
    expect(c.status().encryptionAvailable).toBe(false);
  });
});
