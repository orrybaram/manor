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

function makeDeps() {
  const projectManager = {
    updateProject: vi.fn().mockResolvedValue(null),
    getHosts: vi.fn().mockReturnValue([{ hostId: "box", spec: { kind: "ssh", target: "me@box" } }]),
  };
  return { projectManager, statsStore: { record: vi.fn() } };
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

  it("accepts a registered remote host", () => {
    const deps = makeDeps();
    register(deps as never);
    const handler = handlers.get("projects:update")!;
    handler(null, "p1", { hostId: "box" });
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
