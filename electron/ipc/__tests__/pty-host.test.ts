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
