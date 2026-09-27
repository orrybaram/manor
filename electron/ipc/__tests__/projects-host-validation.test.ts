import { describe, it, expect, beforeEach, vi } from "vitest";

const handlers: Map<string, (...args: unknown[]) => unknown> = new Map();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { register } from "../projects";
import { LOCAL_HOST_ID } from "../../backend/types";
import { HostRecords } from "../../projects/host-records";
import type { StateStore } from "../../projects/state-store";

function makeDeps(opts: { currentHostId?: string; pathExists?: boolean } = {}) {
  // The real host rules, over one registered host "box".
  const hosts = new HostRecords({
    state: {
      projects: [],
      selectedProjectIndex: 0,
      hosts: { box: { spec: { kind: "ssh", target: "me@box" } } },
    },
  } as unknown as StateStore);
  const projectManager = {
    updateProject: vi.fn().mockResolvedValue(null),
    assertKnownHost: (hostId: string) => hosts.assertKnown(hostId),
    assertRemoteHost: (hostId: string) => hosts.assertRemote(hostId),
    getProjectHostId: vi.fn().mockReturnValue(opts.currentHostId ?? LOCAL_HOST_ID),
    switchProjectHost: opts.pathExists === false
      ? vi.fn().mockRejectedValue(new Error("does not exist"))
      : vi.fn().mockResolvedValue({ id: "p1" }),
    moveProjectToHost: vi.fn().mockResolvedValue({ id: "p1" }),
  };
  const backendRegistry = { ensureConnected: vi.fn().mockResolvedValue(undefined) };
  return { projectManager, backendRegistry, statsStore: { record: vi.fn() } };
}

describe("projects:update", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("passes updates straight through", () => {
    const deps = makeDeps();
    register(deps as never);
    const handler = handlers.get("projects:update")!;
    handler(null, "p1", { name: "Renamed" });
    expect(deps.projectManager.updateProject).toHaveBeenCalledWith("p1", {
      name: "Renamed",
    });
  });
});

describe("projects:switchHost (ADR-179)", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("passes an explicit path through", async () => {
    const deps = makeDeps({ currentHostId: "box" });
    register(deps as never);
    await handlers.get("projects:switchHost")!(null, "p1", LOCAL_HOST_ID, "/Users/me/Code/app");
    expect(deps.projectManager.switchProjectHost).toHaveBeenCalledWith(
      "p1",
      LOCAL_HOST_ID,
      "/Users/me/Code/app",
    );
  });

  it("rejects an unknown host", () => {
    const deps = makeDeps();
    register(deps as never);
    expect(() => handlers.get("projects:switchHost")!(null, "p1", "nope")).toThrow(/Unknown host/);
  });
});

describe("projects:moveToHost (ADR-179)", () => {
  beforeEach(() => {
    handlers.clear();
  });

  const opts = { hostId: "box", repoUrl: "https://github.com/org/app.git", remoteDir: "~/code/app" };

  it("connects to the host before moving the project", async () => {
    const deps = makeDeps();
    register(deps as never);
    await handlers.get("projects:moveToHost")!(null, "p1", opts);
    expect(deps.backendRegistry.ensureConnected).toHaveBeenCalledWith("box");
    expect(deps.projectManager.moveProjectToHost).toHaveBeenCalledWith("p1", opts);
  });

  it("rejects the local host and unknown hosts", async () => {
    const deps = makeDeps();
    register(deps as never);
    const handler = handlers.get("projects:moveToHost")!;
    await expect(
      handler(null, "p1", { ...opts, hostId: LOCAL_HOST_ID }) as Promise<unknown>,
    ).rejects.toThrow(/remote host is required/);
    await expect(
      handler(null, "p1", { ...opts, hostId: "nope" }) as Promise<unknown>,
    ).rejects.toThrow(/Unknown host/);
    expect(deps.projectManager.moveProjectToHost).not.toHaveBeenCalled();
  });
});
