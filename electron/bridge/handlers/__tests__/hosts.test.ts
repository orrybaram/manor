import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { localCtx } from "../../method";

const statusListeners: Array<(hosts: unknown[]) => void> = [];
const resumedListeners: Array<(hostId: string, sessionIds: string[]) => void> = [];

import {
  hostsAdd,
  hostsHealthCheck,
  hostsRetryConnect,
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
