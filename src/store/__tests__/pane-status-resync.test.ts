/**
 * Agent status on a bridge resync (ADR-220 D2): `getPaneStatuses` is re-read
 * and replaces what the store held, unless a live status landed while the
 * read was in flight.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { PaneAgentStatusUpdate } from "../../electron";

type StatusListener = (update: PaneAgentStatusUpdate) => void;

const listeners: StatusListener[] = [];
const getPaneStatuses = vi.fn<() => Promise<PaneAgentStatusUpdate[]>>();

function push(update: PaneAgentStatusUpdate): void {
  for (const cb of listeners) cb(update);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("agent status resync", () => {
  let useAppStore: typeof import("../app-store").useAppStore;
  let emitBridgeResync: typeof import("../../bridge/resync").emitBridgeResync;

  beforeAll(async () => {
    const agents = (
      window as unknown as { electronAPI: { agents: Record<string, unknown> } }
    ).electronAPI.agents;
    agents.getPaneStatuses = getPaneStatuses;
    agents.onStatus = (cb: StatusListener) => {
      listeners.push(cb);
      return () => {};
    };
    getPaneStatuses.mockResolvedValue([]);
    ({ useAppStore } = await import("../app-store"));
    ({ emitBridgeResync } = await import("../../bridge/resync"));
    await flush();
  });

  beforeEach(() => {
    useAppStore.setState({
      paneAgentStatus: { p1: { status: "working", kind: "claude" } },
    } as never);
  });

  it("replaces a stale held status with the server's", async () => {
    getPaneStatuses.mockResolvedValueOnce([
      { paneId: "p1", status: "requires_input", kind: "claude", reason: "hook" },
    ]);
    await emitBridgeResync();
    expect(useAppStore.getState().paneAgentStatus.p1?.status).toBe(
      "requires_input",
    );
  });

  it("keeps a status pushed while the read was in flight", async () => {
    let answer: (updates: PaneAgentStatusUpdate[]) => void = () => {};
    getPaneStatuses.mockReturnValueOnce(
      new Promise((resolve) => (answer = resolve)),
    );
    const resynced = emitBridgeResync();
    push({ paneId: "p1", status: "idle", kind: "claude", reason: "hook" });
    answer([{ paneId: "p1", status: "requires_input", kind: "claude", reason: "hook" }]);
    await resynced;
    expect(useAppStore.getState().paneAgentStatus.p1?.status).toBe("idle");
  });

  it("a push for one pane does not drop the read for the others", async () => {
    useAppStore.setState({
      paneAgentStatus: {
        p1: { status: "working", kind: "claude" },
        p2: { status: "working", kind: "claude" },
      },
    } as never);
    let answer: (updates: PaneAgentStatusUpdate[]) => void = () => {};
    getPaneStatuses.mockReturnValueOnce(
      new Promise((resolve) => (answer = resolve)),
    );
    const resynced = emitBridgeResync();
    push({ paneId: "p1", status: "idle", kind: "claude", reason: "hook" });
    answer([
      { paneId: "p1", status: "requires_input", kind: "claude", reason: "hook" },
      { paneId: "p2", status: "requires_input", kind: "claude", reason: "hook" },
    ]);
    await resynced;
    const held = useAppStore.getState().paneAgentStatus;
    expect(held.p1?.status).toBe("idle");
    expect(held.p2?.status).toBe("requires_input");
  });
});
