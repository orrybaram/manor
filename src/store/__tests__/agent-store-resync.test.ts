// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";

const agentsApi = {
  getAll: vi.fn().mockResolvedValue([]),
  getActive: vi.fn().mockResolvedValue([]),
  getUnseen: vi.fn().mockResolvedValue({ responded: [], requires_input: [] }),
  consumePruneNotice: vi.fn().mockResolvedValue(0),
  onUpdate: vi.fn(() => () => {}),
};

(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  ...((window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI ?? {}),
  agents: agentsApi,
};


describe("agent-store resync", () => {
  it("re-fetches state but does not consume the prune notice again", async () => {
    const { useAgentStore } = await import("../agent-store");
    const { emitBridgeResync } = await import("../../bridge/resync");
    await vi.waitFor(() => expect(useAgentStore.getState().loaded).toBe(true));
    await vi.waitFor(() => expect(agentsApi.consumePruneNotice).toHaveBeenCalledTimes(1));
    const fetches = agentsApi.getActive.mock.calls.length;

    emitBridgeResync();

    await vi.waitFor(() => expect(agentsApi.getActive.mock.calls.length).toBe(fetches + 1));
    expect(agentsApi.getAll).toHaveBeenCalledTimes(fetches + 1);
    expect(agentsApi.getUnseen).toHaveBeenCalledTimes(fetches + 1);
    expect(agentsApi.consumePruneNotice).toHaveBeenCalledTimes(1);
  });
});
