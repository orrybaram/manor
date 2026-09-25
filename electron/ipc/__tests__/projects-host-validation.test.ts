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

function makeDeps(opts: { currentHostId?: string; pathExists?: boolean } = {}) {
  const projectManager = {
    updateProject: vi.fn().mockResolvedValue(null),
    getHosts: vi.fn().mockReturnValue([{ hostId: "box", spec: { kind: "ssh", target: "me@box" } }]),
    getProjectHostId: vi.fn().mockReturnValue(opts.currentHostId ?? LOCAL_HOST_ID),
    getProjectPath: vi.fn().mockReturnValue("/Users/me/Code/app"),
    pathExistsOnHost: vi.fn().mockResolvedValue(opts.pathExists ?? true),
    moveProjectToHost: vi.fn().mockResolvedValue({ id: "p1" }),
  };
  const backendRegistry = { ensureConnected: vi.fn().mockResolvedValue(undefined) };
  return { projectManager, backendRegistry, statsStore: { record: vi.fn() } };
}

describe("projects:update hostId validation", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("accepts the local host", () => {
    const deps = makeDeps();
    register(deps as never);
    const handler = handlers.get("projects:update")!;
    handler(null, "p1", { hostId: LOCAL_HOST_ID });
    expect(deps.projectManager.updateProject).toHaveBeenCalledWith("p1", {
      hostId: LOCAL_HOST_ID,
    });
  });

  it("accepts a registered remote host", async () => {
    const deps = makeDeps();
    register(deps as never);
    const handler = handlers.get("projects:update")!;
    await handler(null, "p1", { hostId: "box" });
    expect(deps.projectManager.updateProject).toHaveBeenCalledWith("p1", {
      hostId: "box",
    });
  });

  it("rejects a host id nobody registered", () => {
    const deps = makeDeps();
    register(deps as never);
    const handler = handlers.get("projects:update")!;
    expect(() => handler(null, "p1", { hostId: "no-such-host" })).toThrow(
      /Unknown host/,
    );
    expect(deps.projectManager.updateProject).not.toHaveBeenCalled();
  });

  it("leaves other updates untouched when hostId is absent", () => {
    const deps = makeDeps();
    register(deps as never);
    const handler = handlers.get("projects:update")!;
    handler(null, "p1", { name: "Renamed" });
    expect(deps.projectManager.updateProject).toHaveBeenCalledWith("p1", {
      name: "Renamed",
    });
  });
});

describe("projects:update host-switch guard (ADR-179)", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("connects to the target host and checks the path there before switching", async () => {
    const deps = makeDeps();
    register(deps as never);
    await handlers.get("projects:update")!(null, "p1", { hostId: "box" });
    expect(deps.backendRegistry.ensureConnected).toHaveBeenCalledWith("box");
    expect(deps.projectManager.pathExistsOnHost).toHaveBeenCalledWith(
      "box",
      "/Users/me/Code/app",
    );
    expect(deps.projectManager.updateProject).toHaveBeenCalled();
  });

  it("refuses a switch to a host where the project path does not exist", async () => {
    const deps = makeDeps({ pathExists: false });
    register(deps as never);
    await expect(
      handlers.get("projects:update")!(null, "p1", { hostId: "box" }) as Promise<unknown>,
    ).rejects.toThrow(
      'Project path "/Users/me/Code/app" does not exist on me@box. Clone it onto the host instead.',
    );
    expect(deps.projectManager.updateProject).not.toHaveBeenCalled();
  });

  it('names the local machine "this Mac" when switching back to local', async () => {
    const deps = makeDeps({ currentHostId: "box", pathExists: false });
    register(deps as never);
    await expect(
      handlers.get("projects:update")!(null, "p1", { hostId: LOCAL_HOST_ID }) as Promise<unknown>,
    ).rejects.toThrow(/does not exist on this Mac/);
    expect(deps.backendRegistry.ensureConnected).not.toHaveBeenCalled();
    expect(deps.projectManager.updateProject).not.toHaveBeenCalled();
  });

  it("skips the check when the host does not change", async () => {
    const deps = makeDeps({ currentHostId: "box", pathExists: false });
    register(deps as never);
    await handlers.get("projects:update")!(null, "p1", { hostId: "box" });
    expect(deps.projectManager.pathExistsOnHost).not.toHaveBeenCalled();
    expect(deps.projectManager.updateProject).toHaveBeenCalled();
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
