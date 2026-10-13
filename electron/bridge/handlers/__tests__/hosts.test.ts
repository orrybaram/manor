import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { localCtx } from "../../method";

const statusListeners: Array<(hosts: unknown[]) => void> = [];
const resumedListeners: Array<(hostId: string, sessionIds: string[]) => void> = [];

import {
  hostsAdd,
  hostsHealthCheck,
  hostsPairDevice,
  hostsResetPairingKeys,
  hostsRevokeDevice,
  hostsRetryConnect,
  hostsServerStatus,
  hostsSetLinearOnHost,
  wireHostBroadcasts,
} from "../hosts";
import {
  addRendererBroadcastSink,
  type RendererBroadcast,
} from "../../../renderer-broadcast";

/**
 * The handlers under test, by their old IPC channel names. There is no
 * `register()` any more (ADR-180 D8): the handler table calls the lifted
 * functions with the one long-lived `HostDeps`, and the two broadcasts are
 * wired once at boot by `wireHostBroadcasts` — which is what `register` does
 * here, besides recording the deps. The first argument stands in for the
 * IPC event and is ignored.
 */
let current: unknown;
function register(deps: unknown): void {
  current = deps;
  wireHostBroadcasts(deps as never);
}
const call =
  (fn: (...args: never[]) => unknown) =>
  (_event: unknown, ...args: unknown[]): unknown =>
    (fn as (...args: unknown[]) => unknown)(localCtx(current as never), ...args);
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>([
  ["hosts:add", call(hostsAdd)],
  ["hosts:retryConnect", call(hostsRetryConnect)],
  ["hosts:healthCheck", call(hostsHealthCheck)],
]);

/** Every renderer broadcast, which is how the host events go out (ADR-180 D5). */
let frames: RendererBroadcast[] = [];
let stopSink: () => void = () => {};
beforeEach(() => {
  frames = [];
  stopSink = addRendererBroadcastSink((frame) => frames.push(frame));
});
afterEach(() => stopSink());

function makeDeps() {
  const backendRegistry = {
    list: vi.fn().mockReturnValue([]),
    register: vi.fn(),
    unregister: vi.fn().mockResolvedValue(undefined),
    connectInBackground: vi.fn(),
    retryNow: vi.fn(),
    onHostResumed: vi.fn((cb: (hostId: string, sessionIds: string[]) => void) => {
      resumedListeners.push(cb);
      return () => {};
    }),
    onHostServerStateChange: vi.fn(() => () => {}),
    setServerFacts: vi.fn(),
    onStatusChange: vi.fn((cb: (hosts: unknown[]) => void) => {
      statusListeners.push(cb);
      return () => {};
    }),
  };
  const projectManager = {
    assertKnownHost: vi.fn((hostId: string) => {
      if (hostId !== "local" && hostId !== "box") throw new Error(`Unknown host "${hostId}".`);
    }),
    saveHost: vi.fn(),
    remoteHostIdsInUse: vi.fn().mockReturnValue([]),
    getHosts: vi.fn().mockReturnValue([]),
  };
  const deps = {
    backendRegistry,
    projectManager,
  };
  return { deps, backendRegistry, projectManager };
}

describe("hosts:add", () => {
  beforeEach(() => {
    statusListeners.length = 0;
  });

  it("rejects an empty target", () => {
    const { deps } = makeDeps();
    register(deps as never);
    const handler = handlers.get("hosts:add")!;
    expect(() => handler(null, "  ")).toThrow();
  });

  it("rejects a target that looks like an ssh flag", () => {
    const { deps } = makeDeps();
    register(deps as never);
    const handler = handlers.get("hosts:add")!;
    expect(() => handler(null, "-oProxyCommand=evil")).toThrow(/Invalid ssh target/);
  });

  it("registers a valid target and starts connecting in the background", () => {
    const { deps, backendRegistry, projectManager } = makeDeps();
    register(deps as never);
    const handler = handlers.get("hosts:add")!;
    const result = handler(null, "me@box.example.com") as {
      hostId: string;
      spec: { kind: string; target: string };
    };

    expect(result.spec).toEqual({ kind: "ssh", target: "me@box.example.com" });
    expect(projectManager.saveHost).toHaveBeenCalledWith(result.hostId, result.spec);
    expect(backendRegistry.register).toHaveBeenCalledWith(result.hostId, result.spec);
    expect(backendRegistry.connectInBackground).toHaveBeenCalledWith(result.hostId);
  });
});

describe("hosts:retryConnect", () => {
  beforeEach(() => {
    statusListeners.length = 0;
  });

  it("retries the given host now (the registry decides wake-vs-connect)", () => {
    const { deps, backendRegistry } = makeDeps();
    register(deps as never);
    const handler = handlers.get("hosts:retryConnect")!;
    handler(null, "box");
    expect(backendRegistry.retryNow).toHaveBeenCalledWith("box");
  });
});

describe("hosts:statusChanged broadcast", () => {
  beforeEach(() => {
    statusListeners.length = 0;
  });

  it("pushes every status change to every renderer", () => {
    const { deps, backendRegistry } = makeDeps();
    register(deps as never);

    const hosts = [{ hostId: "box", status: "connected" }];
    for (const listener of statusListeners) listener(hosts);

    expect(frames).toEqual([
      { ns: "hosts", event: "statusChanged", args: [hosts], to: null },
    ]);
    expect(backendRegistry.onStatusChange).toHaveBeenCalledTimes(1);
  });
});

describe("hosts:reconnected broadcast", () => {
  beforeEach(() => {
    resumedListeners.length = 0;
  });

  it("tells every renderer which sessions a resumed host still has", () => {
    const { deps } = makeDeps();
    register(deps as never);

    for (const listener of resumedListeners) listener("box", ["pane-1"]);

    expect(frames).toEqual([
      {
        ns: "hosts",
        event: "reconnected",
        args: [{ hostId: "box", sessionIds: ["pane-1"] }],
        to: null,
      },
    ]);
  });
});

describe("hosts:healthCheck", () => {

  it("refuses a host that is not registered, before touching any backend", async () => {
    const { deps, backendRegistry } = makeDeps();
    const get = vi.fn();
    Object.assign(backendRegistry, { get });
    register(deps as never);
    await expect(
      handlers.get("hosts:healthCheck")!(null, "nope", "/srv/app") as Promise<unknown>,
    ).rejects.toThrow(/Unknown host/);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("hosts phone access", () => {
  function withServer(state: string) {
    const { deps, backendRegistry } = makeDeps();
    const client = {
      status: vi.fn().mockResolvedValue({ pushEndpoints: ["https://p"], devices: 1 }),
      pair: vi.fn().mockResolvedValue({ pairingUrl: "https://relay/app/1/#x" }),
      listDevices: vi.fn().mockResolvedValue([]),
      revoke: vi.fn().mockResolvedValue([]),
      resetIdentity: vi.fn().mockResolvedValue({ devices: 0 }),
      setLinearToken: vi.fn().mockImplementation(async (t: string | null) => t !== null),
    };
    const server = {
      state,
      api: {
        hostServer: {
          status: client.status,
          resetIdentity: client.resetIdentity,
          setLinearToken: client.setLinearToken,
        },
        remoteControl: {
          pair: client.pair,
          listDevices: client.listDevices,
          revoke: client.revoke,
        },
      },
    };
    Object.assign(backendRegistry, {
      hostServer: vi.fn((id: string) => (id === "box" ? server : undefined)),
    });
    const hostServerSync = { pairingChanged: vi.fn().mockResolvedValue(undefined) };
    const linearManager = { getToken: vi.fn().mockReturnValue("lin_key") };
    return {
      ctx: localCtx({ ...deps, hostServerSync, linearManager } as never),
      backendRegistry,
      client,
      hostServerSync,
      linearManager,
    };
  }

  it("sends the desktop's Linear key to the host, or deletes the copy", async () => {
    const { ctx, client } = withServer("connected");
    await expect(hostsSetLinearOnHost(ctx, "box", true)).resolves.toBe(true);
    expect(client.setLinearToken).toHaveBeenLastCalledWith("lin_key");
    await expect(hostsSetLinearOnHost(ctx, "box", false)).resolves.toBe(false);
    expect(client.setLinearToken).toHaveBeenLastCalledWith(null);
  });

  it("will not turn Linear on without a key here, or on a dropped host", async () => {
    const { ctx, client, linearManager } = withServer("connected");
    linearManager.getToken.mockReturnValue(null);
    await expect(hostsSetLinearOnHost(ctx, "box", true)).rejects.toThrow(/Connect Linear/);
    const dropped = withServer("disconnected");
    await expect(hostsSetLinearOnHost(dropped.ctx, "box", true)).rejects.toThrow(/Phone access/);
    expect(client.setLinearToken).not.toHaveBeenCalled();
    expect(dropped.client.setLinearToken).not.toHaveBeenCalled();
  });

  it("reports an unknown host plainly", async () => {
    const { ctx } = withServer("connected");
    await expect(hostsServerStatus(ctx, "nope")).rejects.toThrow(/Unknown remote host/);
    await expect(hostsPairDevice(ctx, "nope")).rejects.toThrow(/Unknown remote host/);
  });

  it("returns the state without a status while unsupported", async () => {
    const { ctx, client } = withServer("unsupported");
    await expect(hostsServerStatus(ctx, "box")).resolves.toEqual({
      state: "unsupported",
      status: null,
      devices: [],
    });
    expect(client.status).not.toHaveBeenCalled();
  });

  it("refuses to pair, list, revoke or reset on an unsupported or dropped host", async () => {
    for (const state of ["unsupported", "disconnected"]) {
      const { ctx, client } = withServer(state);
      await expect(hostsPairDevice(ctx, "box", "p")).rejects.toThrow(/Phone access/);
      await expect(hostsRevokeDevice(ctx, "box", "d")).rejects.toThrow(/Phone access/);
      await expect(hostsResetPairingKeys(ctx, "box")).rejects.toThrow(/Phone access/);
      expect(client.pair).not.toHaveBeenCalled();
    }
  });

  it("reads a status without touching the endpoint cache", async () => {
    const { ctx, client, hostServerSync } = withServer("connected");
    const view = await hostsServerStatus(ctx, "box");
    expect(view.status?.devices).toBe(1);
    expect(view.devices).toEqual([]);
    expect(client.listDevices).toHaveBeenCalledTimes(1);
    expect(hostServerSync.pairingChanged).not.toHaveBeenCalled();
  });

  it("records the status's room and capability for hosts.list; an older host has no viewer bridge (ADR-228)", async () => {
    const { ctx, client, backendRegistry: registry } = withServer("connected");
    // An older host: no `capabilities`, no top-level `roomId`.
    client.status.mockResolvedValueOnce({ devices: 0, relay: { roomId: "room-old" } });
    await hostsServerStatus(ctx, "box");
    expect(registry.setServerFacts).toHaveBeenLastCalledWith("box", {
      roomId: "room-old",
      viewerBridge: false,
    });
    client.status.mockResolvedValueOnce({
      devices: 0,
      roomId: "room-new",
      capabilities: ["viewer-bridge"],
      relay: { roomId: "room-new" },
    });
    await hostsServerStatus(ctx, "box");
    expect(registry.setServerFacts).toHaveBeenLastCalledWith("box", {
      roomId: "room-new",
      viewerBridge: true,
    });
  });

  it("tells the sync the pairing changed after pair, revoke and reset", async () => {
    const { ctx, client, hostServerSync } = withServer("connected");
    await hostsPairDevice(ctx, "box", "  my phone ");
    expect(client.pair).toHaveBeenCalledWith("my phone");
    await hostsRevokeDevice(ctx, "box", "d1");
    await hostsResetPairingKeys(ctx, "box");
    expect(hostServerSync.pairingChanged).toHaveBeenCalledTimes(3);
    expect(hostServerSync.pairingChanged).toHaveBeenCalledWith("box");
  });
});
