import { describe, it, expect, vi } from "vitest";


import { ptyCreate, ptyReset } from "../pty";

/**
 * The handlers under test, by their old IPC channel names. There is no
 * `register()` any more (ADR-180 D8): the handler table calls the lifted
 * functions with the one long-lived `IpcDeps`, so `register` here only
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
    (fn as (...args: unknown[]) => unknown)(current, ...args);
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>([
  ["pty:create", call(ptyCreate)],
  ["pty:reset", call(ptyReset)],
]);
import { HostUnavailableError } from "../../../backend/host-view";
import { RoutedBackend } from "../../../backend/routed-backend";
import { SessionOwners } from "../../../backend/session-owners";
import { PathRouter } from "../../../projects/path-router";
import type { BackendRegistry } from "../../../backend/registry";
import type { MachineFacts, WorkspaceBackend } from "../../../backend/types";
import type { PersistedProject } from "../../../projects/types";

/** The unused event slot (see `call`). Viewers are the table's to attach. */
const EVENT = null;

function setup(hostId: string) {
  const backend = {
    pty: {
      createOrAttachWith: vi.fn().mockResolvedValue({ snapshot: null, hostId }),
    },
  };
  register({ backend } as never);
  return handlers.get("pty:create")!;
}

describe("pty:create host reporting (ADR-160)", () => {

  it("reports the host the session actually runs on", async () => {
    const create = setup("box");
    const result = (await create(EVENT, "pane-a", null, 80, 24)) as { hostId?: string };
    expect(result.hostId).toBe("box");
  });

  it("reports local for a session on this machine", async () => {
    const create = setup("local");
    const result = (await create(EVENT, "pane-b", null, 80, 24)) as { hostId?: string };
    expect(result.hostId).toBe("local");
  });
});

describe("pty:create on a remote host that is not connected (ADR-178 §6)", () => {

  function failing(err: Error) {
    const backend = {
      pty: {
        createOrAttachWith: vi.fn().mockRejectedValue(err),
      },
    };
    register({ backend } as never);
    return handlers.get("pty:create")!;
  }

  it("reports the awaited host instead of a plain failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const create = failing(new HostUnavailableError("box", "reconnecting"));
    const result = await create(EVENT, "pane-a", "/remote/app", 80, 24);
    expect(result).toMatchObject({ ok: false, reason: "host-unavailable", hostId: "box" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("is a plain failure for a broken terminal or a host nobody registered", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const err of [new Error("spawn failed"), new HostUnavailableError("box", "unknown")]) {
      const create = failing(err);
      const result = (await create(EVENT, "pane-a", "/x", 80, 24)) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("error");
    }
  });
});

describe("pty:create on the host it was asked for (ADR-191)", () => {

  // The same repo cloned at the same path on this machine and on "box" —
  // same username, same default root — as two projects.
  const SHARED = "/home/me/.manor/worktrees/app/feature";
  const projects = [
    { id: "p-local", name: "app", path: "/home/me/code/app", hostId: "local" },
    { id: "p-box", name: "app", path: "/home/me/code/app", hostId: "box" },
  ] as PersistedProject[];

  /**
   * `pty:create` over a real `RoutedBackend` and `PathRouter`, with a fake
   * backend per host that records the sessions created on it.
   */
  function routed() {
    const created: Record<string, string[]> = { local: [], box: [] };
    const hostBackend = (hostId: string) =>
      ({
        pty: {
          createOrAttach: vi.fn(async (sessionId: string) => {
            created[hostId].push(sessionId);
            return { session: { sessionId }, snapshot: null };
          }),
        },
        facts: {} as MachineFacts,
      }) as unknown as WorkspaceBackend;
    const backends: Record<string, WorkspaceBackend> = {
      local: hostBackend("local"),
      box: hostBackend("box"),
    };
    const sessions = new SessionOwners();
    const registry = {
      sessions,
      get: (hostId: string) => backends[hostId],
    } as unknown as BackendRegistry;
    const router = new PathRouter(() => projects, () => ({}) as MachineFacts);
    router.setWorkspacePaths("p-local", ["/home/me/code/app", SHARED]);
    router.setWorkspacePaths("p-box", ["/home/me/code/app", SHARED]);
    const backend = new RoutedBackend(registry, (p) => router.hostIdForPath(p));
    register({ backend } as never);
    return { create: handlers.get("pty:create")!, created, sessions };
  }

  it("creates a pane of the remote workspace on the remote host", async () => {
    const { create, created } = routed();
    const result = await create(EVENT, "pane-r", SHARED, 80, 24, { hostId: "box" });
    expect(result).toMatchObject({ ok: true, hostId: "box" });
    expect(created).toEqual({ local: [], box: ["pane-r"] });
  });

  it("creates a pane of the local workspace locally", async () => {
    const { create, created } = routed();
    const result = await create(EVENT, "pane-l", SHARED, 80, 24, { hostId: "local" });
    expect(result).toMatchObject({ ok: true, hostId: "local" });
    expect(created).toEqual({ local: ["pane-l"], box: [] });
  });

  it("falls back to the path's host, as before, when no host is named", async () => {
    const { create, created } = routed();
    // Local wins a path both hosts have.
    const result = await create(EVENT, "pane-x", SHARED, 80, 24);
    expect(result).toMatchObject({ ok: true, hostId: "local" });
    expect(created).toEqual({ local: ["pane-x"], box: [] });
  });

  it("attaches an existing session where it runs, whatever host is named", async () => {
    // A pane whose project moved host keeps running where it started.
    const { create, created, sessions } = routed();
    sessions.claim("pane-moved", "box");
    const result = await create(EVENT, "pane-moved", SHARED, 80, 24, { hostId: "local" });
    expect(result).toMatchObject({ ok: true, hostId: "box" });
    expect(created).toEqual({ local: [], box: ["pane-moved"] });
  });

  it("resets a pane onto the host it was asked for", async () => {
    const { created } = routed();
    const reset = handlers.get("pty:reset")!;
    const result = await reset(EVENT, "pane-r", SHARED, 80, 24, { hostId: "box" });
    expect(result).toMatchObject({ ok: true, hostId: "box" });
    expect(created.box).toEqual(["pane-r"]);
  });

  it("rejects a host id that is not a string", async () => {
    const { create } = routed();
    await expect(create(EVENT, "pane-a", SHARED, 80, 24, { hostId: 42 })).rejects.toThrow();
  });
});
