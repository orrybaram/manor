import { describe, it, expect, beforeEach, vi } from "vitest";

const handlers: Map<string, (...args: unknown[]) => unknown> = new Map();
const statusListeners: Array<(hosts: unknown[]) => void> = [];

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { register } from "../hosts";
import { LOCAL_HOST_ID } from "../../backend/types";

function makeDeps() {
  const backendRegistry = {
    list: vi.fn().mockReturnValue([]),
    register: vi.fn(),
    unregister: vi.fn().mockResolvedValue(undefined),
    connectInBackground: vi.fn(),
    onStatusChange: vi.fn((cb: (hosts: unknown[]) => void) => {
      statusListeners.push(cb);
      return () => {};
    }),
  };
  const projectManager = {
    saveHost: vi.fn(),
    removeHost: vi.fn(),
    remoteHostIdsInUse: vi.fn().mockReturnValue([]),
    getHosts: vi.fn().mockReturnValue([]),
  };
  const deps = {
    backendRegistry,
    projectManager,
    getRendererWindows: () => [],
  };
  return { deps, backendRegistry, projectManager };
}

describe("hosts:add", () => {
  beforeEach(() => {
    handlers.clear();
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

describe("hosts:remove", () => {
  beforeEach(() => {
    handlers.clear();
    statusListeners.length = 0;
  });

  it("refuses to remove the local host", async () => {
    const { deps } = makeDeps();
    register(deps as never);
    const handler = handlers.get("hosts:remove")!;
    await expect(handler(null, LOCAL_HOST_ID)).rejects.toThrow(/cannot be removed/);
  });

  it("refuses to remove a host a project still uses", async () => {
    const { deps, projectManager } = makeDeps();
    projectManager.remoteHostIdsInUse.mockReturnValue(["box"]);
    register(deps as never);
    const handler = handlers.get("hosts:remove")!;
    await expect(handler(null, "box")).rejects.toThrow(/still used by a project/);
  });

  it("unregisters and forgets a host nothing uses", async () => {
    const { deps, backendRegistry, projectManager } = makeDeps();
    register(deps as never);
    const handler = handlers.get("hosts:remove")!;
    await handler(null, "box");

    expect(backendRegistry.unregister).toHaveBeenCalledWith("box");
    expect(projectManager.removeHost).toHaveBeenCalledWith("box");
  });
  it("forgets the host before awaiting the registry disconnect", async () => {
    const { deps, backendRegistry, projectManager } = makeDeps();
    let finishUnregister!: () => void;
    backendRegistry.unregister.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishUnregister = resolve)),
    );
    register(deps as never);
    const handler = handlers.get("hosts:remove")!;
    const removing = handler(null, "box") as Promise<void>;

    // Still disconnecting, but the host is already gone from persistence —
    // a concurrent projects:update can no longer point a project at it.
    expect(projectManager.removeHost).toHaveBeenCalledWith("box");
    finishUnregister();
    await removing;
    expect(backendRegistry.unregister).toHaveBeenCalledWith("box");
  });
});

describe("hosts:retryConnect", () => {
  beforeEach(() => {
    handlers.clear();
    statusListeners.length = 0;
  });

  it("kicks off a background connect for the given host", () => {
    const { deps, backendRegistry } = makeDeps();
    register(deps as never);
    const handler = handlers.get("hosts:retryConnect")!;
    handler(null, "box");
    expect(backendRegistry.connectInBackground).toHaveBeenCalledWith("box");
  });
});

describe("hosts:statusChanged broadcast", () => {
  beforeEach(() => {
    handlers.clear();
    statusListeners.length = 0;
  });

  it("pushes every status change to every live renderer window", () => {
    const send = vi.fn();
    const win = { webContents: { mainFrame: {}, send } };
    const { deps, backendRegistry } = makeDeps();
    deps.getRendererWindows = () => [win as never];
    register(deps as never);

    const hosts = [{ hostId: "box", status: "connected" }];
    for (const listener of statusListeners) listener(hosts);

    expect(send).toHaveBeenCalledWith("hosts:statusChanged", hosts);
    expect(backendRegistry.onStatusChange).toHaveBeenCalledTimes(1);
  });
});
