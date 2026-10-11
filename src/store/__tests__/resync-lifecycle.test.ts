// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";

const activityApi = {
  get: vi.fn().mockResolvedValue({ agents: {}, sessions: [] }),
  onChanged: vi.fn(() => () => {}),
};
const portsApi = {
  updateWorkspaces: vi.fn(),
  updateWorkspaceMetadata: vi.fn(),
  startScanner: vi.fn(),
  stopScanner: vi.fn(),
  scanNow: vi.fn().mockResolvedValue([]),
  onChange: vi.fn(() => () => {}),
};

(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  ...((window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI ?? {}),
  agentActivity: activityApi,
  ports: portsApi,
};

describe("lifecycle-scoped resync", () => {
  it("agent-activity refetches only while sync is running", async () => {
    const { startAgentActivitySync } = await import("../agent-activity-store");
    const { emitBridgeResync } = await import("../../bridge/resync");
    emitBridgeResync();
    expect(activityApi.get).not.toHaveBeenCalled();

    const stop = startAgentActivitySync();
    await vi.waitFor(() => expect(activityApi.get).toHaveBeenCalledTimes(1));
    emitBridgeResync();
    await vi.waitFor(() => expect(activityApi.get).toHaveBeenCalledTimes(2));

    stop();
    emitBridgeResync();
    await Promise.resolve();
    expect(activityApi.get).toHaveBeenCalledTimes(2);
  });

  it("ports rescans only while the scanner is held", async () => {
    const { acquirePortsScanner } = await import("../ports-store");
    const { emitBridgeResync } = await import("../../bridge/resync");
    emitBridgeResync();
    expect(portsApi.scanNow).not.toHaveBeenCalled();

    const release = acquirePortsScanner();
    emitBridgeResync();
    await vi.waitFor(() => expect(portsApi.scanNow).toHaveBeenCalledTimes(1));

    release();
    emitBridgeResync();
    await Promise.resolve();
    expect(portsApi.scanNow).toHaveBeenCalledTimes(1);
  });
});
