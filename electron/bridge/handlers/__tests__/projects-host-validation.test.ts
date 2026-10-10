import { describe, it, expect, vi } from "vitest";
import { localCtx } from "../../method";


import {
  projectsAutoJoin,
  projectsKeepSeparate,
  projectsMoveToHost,
  projectsUndoAutoJoin,
  projectsTransfer,
  projectsSwitchHost,
  projectsUpdate,
} from "../projects";

/**
 * The handlers under test, by their old IPC channel names. There is no
 * `register()` any more (ADR-180 D8): the handler table calls the lifted
 * functions with the one long-lived `HostDeps`, so `register` here only
 * records the deps a test built, and each channel calls its function over
 * them. The first argument stands in for the IPC event and is ignored.
 */
let current: unknown;
function register(deps: unknown): void {
  current = deps;
}
const call =
  (fn: (...args: never[]) => unknown) =>
  (_event: unknown, ...args: unknown[]): unknown =>
    (fn as (...args: unknown[]) => unknown)(localCtx(current as never), ...args);
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>([
  ["projects:update", call(projectsUpdate)],
  ["projects:switchHost", call(projectsSwitchHost)],
  ["projects:moveToHost", call(projectsMoveToHost)],
  ["projects:transfer", call(projectsTransfer)],
  ["projects:autoJoin", call(projectsAutoJoin)],
  ["projects:keepSeparate", call(projectsKeepSeparate)],
  ["projects:undoAutoJoin", call(projectsUndoAutoJoin)],
]);
import { LOCAL_HOST_ID } from "../../../backend/types";
import { HostRecords } from "../../../projects/host-records";
import type { StateStore } from "../../../projects/state-store";

/** The project after a move to `hostId`, keeping the workspace at `/srv/app`. */
function moved(hostId: string) {
  return { id: "p1", hostId, workspaces: [{ path: "/srv/app" }] };
}

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
    transferProject: vi.fn().mockResolvedValue({ ok: true, project: moved("box") }),
    getProjectHostId: vi.fn().mockReturnValue(opts.currentHostId ?? LOCAL_HOST_ID),
    switchProjectHost: opts.pathExists === false
      ? vi.fn().mockRejectedValue(new Error("does not exist"))
      : vi.fn().mockImplementation(async (_id: string, hostId: string) => moved(hostId)),
    moveProjectToHost: vi.fn().mockImplementation(async () => moved("box")),
    autoJoin: vi.fn().mockResolvedValue([{ joinedId: "p2", intoId: "p1" }]),
    keepSeparate: vi.fn(),
    undoAutoJoin: vi.fn(),
  };
  const backendRegistry = { ensureConnected: vi.fn().mockResolvedValue(undefined) };
  // The layouts are the server's to move (ADR-179 D1), and it broadcasts the
  // move to every renderer.
  const layoutStore = { moveWorkspaces: vi.fn().mockResolvedValue(undefined) };
  return { projectManager, backendRegistry, layoutStore, statsStore: { record: vi.fn() } };
}

describe("projects:update", () => {
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

  it("rejects an unknown host", async () => {
    const deps = makeDeps();
    register(deps as never);
    await expect(
      handlers.get("projects:switchHost")!(null, "p1", "nope") as Promise<unknown>,
    ).rejects.toThrow(/Unknown host/);
    expect(deps.projectManager.switchProjectHost).not.toHaveBeenCalled();
  });
});

describe("projects:moveToHost (ADR-179)", () => {
  const opts = { hostId: "box", repoUrl: "https://github.com/org/app.git", remoteDir: "~/code/app" };

  it("connects to the host before moving the project", async () => {
    const deps = makeDeps();
    register(deps as never);
    await handlers.get("projects:moveToHost")!(null, "p1", opts);
    expect(deps.backendRegistry.ensureConnected).toHaveBeenCalledWith("box");
    expect(deps.projectManager.moveProjectToHost).toHaveBeenCalledWith("p1", opts);
  });

  it("accepts the local host without connecting, and rejects unknown hosts", async () => {
    const deps = makeDeps({ currentHostId: "box" });
    register(deps as never);
    const handler = handlers.get("projects:moveToHost")!;
    await handler(null, "p1", { ...opts, hostId: LOCAL_HOST_ID });
    expect(deps.projectManager.moveProjectToHost).toHaveBeenCalledTimes(1);
    expect(deps.backendRegistry.ensureConnected).not.toHaveBeenCalled();
    await expect(
      handler(null, "p1", { ...opts, hostId: "nope" }) as Promise<unknown>,
    ).rejects.toThrow(/Unknown host/);
    expect(deps.projectManager.moveProjectToHost).toHaveBeenCalledTimes(1);
  });

  // ADR-191: the workspaces it keeps keep their saved layouts, under their
  // keys on the new host.
  it("moves the kept workspaces' saved layouts to the new host's keys", async () => {
    const deps = makeDeps();
    register(deps as never);
    await handlers.get("projects:moveToHost")!(null, "p1", opts);
    expect(deps.layoutStore.moveWorkspaces).toHaveBeenCalledWith([
      ["/srv/app", "box:/srv/app"],
    ]);
  });
});

describe("projects:transfer (ADR-213)", () => {
  const opts = { projectId: "p1", hostId: "box", mode: "copy" as const };

  it("connects to a remote host, then transfers", async () => {
    const deps = makeDeps();
    register(deps as never);
    const res = await handlers.get("projects:transfer")!(null, opts);
    expect(deps.backendRegistry.ensureConnected).toHaveBeenCalledWith("box");
    expect(deps.projectManager.transferProject).toHaveBeenCalledWith("p1", "box", "copy", undefined);
    expect(res).toMatchObject({ ok: true });
  });

  it("passes overrides through", async () => {
    const deps = makeDeps();
    register(deps as never);
    await handlers.get("projects:transfer")!(null, {
      ...opts,
      mode: "move",
      repoUrl: "u",
      targetDir: "~/d",
    });
    expect(deps.projectManager.transferProject).toHaveBeenCalledWith("p1", "box", "move", {
      repoUrl: "u",
      targetDir: "~/d",
    });
  });

  it("does not connect for the local host", async () => {
    const deps = makeDeps();
    register(deps as never);
    await handlers.get("projects:transfer")!(null, { ...opts, hostId: LOCAL_HOST_ID });
    expect(deps.backendRegistry.ensureConnected).not.toHaveBeenCalled();
    expect(deps.projectManager.transferProject).toHaveBeenCalled();
  });

  it("validates its input", async () => {
    const deps = makeDeps();
    register(deps as never);
    const handler = handlers.get("projects:transfer")!;
    await expect(handler(null, { ...opts, projectId: 1 }) as Promise<unknown>).rejects.toThrow();
    await expect(handler(null, { ...opts, mode: "swap" }) as Promise<unknown>).rejects.toThrow(/mode/);
    await expect(handler(null, { ...opts, repoUrl: 5 }) as Promise<unknown>).rejects.toThrow();
    await expect(handler(null, { ...opts, hostId: "nope" }) as Promise<unknown>).rejects.toThrow(/Unknown host/);
    expect(deps.projectManager.transferProject).not.toHaveBeenCalled();
  });
});

describe("projects:switchHost layouts (ADR-191)", () => {
  it("moves the kept workspaces' saved layouts back to local keys", async () => {
    const deps = makeDeps({ currentHostId: "box" });
    register(deps as never);
    await handlers.get("projects:switchHost")!(null, "p1", LOCAL_HOST_ID);
    expect(deps.layoutStore.moveWorkspaces).toHaveBeenCalledWith([
      ["box:/srv/app", "/srv/app"],
    ]);
  });
});

describe("projects:autoJoin / keepSeparate (ADR-214)", () => {
  it("returns the pairs autoJoin joined", async () => {
    const deps = makeDeps();
    register(deps as never);
    expect(await handlers.get("projects:autoJoin")!(null)).toEqual([
      { joinedId: "p2", intoId: "p1" },
    ]);
    expect(deps.projectManager.autoJoin).toHaveBeenCalledTimes(1);
  });

  it("passes keepSeparate's project through, and rejects a non-string", () => {
    const deps = makeDeps();
    register(deps as never);
    const handler = handlers.get("projects:keepSeparate")!;
    handler(null, "p1");
    expect(deps.projectManager.keepSeparate).toHaveBeenCalledWith("p1");
    expect(() => handler(null, 7)).toThrow(/projectId/);
    expect(deps.projectManager.keepSeparate).toHaveBeenCalledTimes(1);
  });
});

describe("projects:undoAutoJoin (ADR-214)", () => {
  it("passes the pair through, and rejects a non-string", () => {
    const deps = makeDeps();
    register(deps as never);
    const handler = handlers.get("projects:undoAutoJoin")!;
    handler(null, "p2", "p1");
    expect(deps.projectManager.undoAutoJoin).toHaveBeenCalledWith("p2", "p1");
    expect(() => handler(null, 7, "p1")).toThrow(/joinedId/);
    expect(() => handler(null, "p2", null)).toThrow(/intoId/);
    expect(deps.projectManager.undoAutoJoin).toHaveBeenCalledTimes(1);
  });
});
