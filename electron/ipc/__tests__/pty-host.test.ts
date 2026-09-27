import { describe, it, expect, beforeEach, vi } from "vitest";

const handlers: Map<string, (...args: unknown[]) => unknown> = new Map();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { register } from "../pty";

function setup(sessionHosts: Record<string, string>) {
  const backend = {
    pty: {
      createOrAttach: vi.fn().mockResolvedValue({ snapshot: null }),
    },
  };
  const backendRegistry = {
    hostForSession: vi.fn((id: string) => sessionHosts[id]),
  };
  register({ backend, backendRegistry } as never);
  return handlers.get("pty:create")!;
}

describe("pty:create host reporting (ADR-160)", () => {
  beforeEach(() => handlers.clear());

  it("reports the host the session actually runs on", async () => {
    const create = setup({ "pane-a": "box" });
    const result = (await create(null, "pane-a", null, 80, 24)) as { hostId?: string };
    expect(result.hostId).toBe("box");
  });

  it("reports local for a session the registry has not routed remotely", async () => {
    const create = setup({});
    const result = (await create(null, "pane-b", null, 80, 24)) as { hostId?: string };
    expect(result.hostId).toBe("local");
  });
});

describe("pty:create on a remote host that is not connected (ADR-178 §6)", () => {
  beforeEach(() => handlers.clear());

  function failing(opts: {
    sessionHosts?: Record<string, string>;
    pathHost: string;
    status: string | undefined;
  }) {
    const backend = {
      pty: {
        createOrAttach: vi.fn().mockRejectedValue(new Error("Host \"box\" is error")),
      },
    };
    const backendRegistry = {
      hostForSession: vi.fn((id: string) => opts.sessionHosts?.[id]),
      status: vi.fn(() => opts.status),
    };
    const projectManager = { hostIdForPath: vi.fn(() => opts.pathHost) };
    register({ backend, backendRegistry, projectManager } as never);
    return handlers.get("pty:create")!;
  }

  it("reports the awaited host instead of a plain failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const create = failing({ pathHost: "box", status: "reconnecting" });
    const result = await create(null, "pane-a", "/remote/app", 80, 24);
    expect(result).toMatchObject({ ok: false, hostUnavailable: true, hostId: "box" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("prefers the host the session already runs on", async () => {
    const create = failing({
      sessionHosts: { "pane-a": "old-box" },
      pathHost: "box",
      status: "error",
    });
    const result = await create(null, "pane-a", "/remote/app", 80, 24);
    expect(result).toMatchObject({ hostUnavailable: true, hostId: "old-box" });
  });

  it("is a plain failure for a local pane, a connected host or an unknown one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [pathHost, status] of [
      ["local", undefined],
      ["box", "connected"],
      ["box", undefined],
    ] as const) {
      handlers.clear();
      const create = failing({ pathHost, status });
      const result = (await create(null, "pane-a", "/x", 80, 24)) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.hostUnavailable).toBeUndefined();
    }
  });
});
