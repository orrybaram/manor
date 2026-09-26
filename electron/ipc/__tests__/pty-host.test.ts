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
import { HostUnavailableError } from "../../backend/host-view";

function setup(hostId: string) {
  const backend = {
    pty: {
      createOrAttach: vi.fn().mockResolvedValue({ snapshot: null, hostId }),
    },
  };
  register({ backend } as never);
  return handlers.get("pty:create")!;
}

describe("pty:create host reporting (ADR-160)", () => {
  beforeEach(() => handlers.clear());

  it("reports the host the session actually runs on", async () => {
    const create = setup("box");
    const result = (await create(null, "pane-a", null, 80, 24)) as { hostId?: string };
    expect(result.hostId).toBe("box");
  });

  it("reports local for a session on this machine", async () => {
    const create = setup("local");
    const result = (await create(null, "pane-b", null, 80, 24)) as { hostId?: string };
    expect(result.hostId).toBe("local");
  });
});

describe("pty:create on a remote host that is not connected (ADR-178 §6)", () => {
  beforeEach(() => handlers.clear());

  function failing(err: Error) {
    const backend = {
      pty: {
        createOrAttach: vi.fn().mockRejectedValue(err),
      },
    };
    register({ backend } as never);
    return handlers.get("pty:create")!;
  }

  it("reports the awaited host instead of a plain failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const create = failing(new HostUnavailableError("box", "reconnecting"));
    const result = await create(null, "pane-a", "/remote/app", 80, 24);
    expect(result).toMatchObject({ ok: false, hostUnavailable: true, hostId: "box" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("is a plain failure for a broken terminal or a host nobody registered", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const err of [new Error("spawn failed"), new HostUnavailableError("box", "unknown")]) {
      handlers.clear();
      const create = failing(err);
      const result = (await create(null, "pane-a", "/x", 80, 24)) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.hostUnavailable).toBeUndefined();
    }
  });
});
