import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAppStore } from "../app-store";
import {
  ACTIVITY_WINDOW_MS,
  laneSegments,
  lanePriority,
  startAgentActivityRecorder,
  useAgentActivityStore,
} from "../agent-activity-store";
import type { AgentStatus, PaneAgentStatus } from "../../electron.d";

function setStatuses(map: Record<string, AgentStatus>) {
  const out: Record<string, PaneAgentStatus> = {};
  for (const [id, status] of Object.entries(map)) {
    out[id] = { status, reason: "t", kind: "claude" } as PaneAgentStatus;
  }
  useAppStore.setState({ paneAgentStatus: out });
}

describe("laneSegments", () => {
  it("clips to the window, merges equal neighbours, drops idle", () => {
    const segs = laneSegments(
      [
        { status: "working", at: 0 },
        { status: "thinking", at: 20 },
        { status: "working", at: 30 },
        { status: "idle", at: 50 },
        { status: "requires_input", at: 70 },
      ],
      10,
      100,
    );
    expect(segs).toEqual([
      { status: "working", from: 10, to: 20 },
      { status: "thinking", from: 20, to: 30 },
      { status: "working", from: 30, to: 50 },
      { status: "requires_input", from: 70, to: 100 },
    ]);
  });

  it("merges adjacent equal statuses", () => {
    expect(
      laneSegments(
        [
          { status: "working", at: 0 },
          { status: "working", at: 10 },
        ],
        0,
        20,
      ),
    ).toEqual([{ status: "working", from: 0, to: 20 }]);
  });
});

describe("lanePriority", () => {
  it("orders needs-you, then active, then most recent", () => {
    const order = lanePriority({
      old: [{ status: "idle", at: 1 }],
      recent: [{ status: "responded", at: 9 }],
      busy: [{ status: "working", at: 5 }],
      stuck: [{ status: "error", at: 2 }],
    });
    expect(order).toEqual(["stuck", "busy", "recent", "old"]);
  });
});

describe("recorder", () => {
  let stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    useAppStore.setState({ paneAgentStatus: {} });
    stop = startAgentActivityRecorder();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("records first status and changes only", () => {
    setStatuses({ p1: "working" });
    setStatuses({ p1: "working" });
    vi.advanceTimersByTime(1000);
    setStatuses({ p1: "requires_input" });
    expect(
      useAgentActivityStore.getState().transitions.p1.map((t) => t.status),
    ).toEqual(["working", "requires_input"]);
  });

  it("guards against double start", () => {
    expect(startAgentActivityRecorder()).toBe(stop);
  });

  it("samples immediately and every 5 minutes", () => {
    setStatuses({ a: "working", b: "thinking", c: "error", d: "idle" });
    expect(useAgentActivityStore.getState().samples).toHaveLength(1);
    vi.advanceTimersByTime(5 * 60 * 1000);
    const samples = useAgentActivityStore.getState().samples;
    expect(samples).toHaveLength(2);
    expect(samples[1]).toMatchObject({ waiting: 1, working: 2 });
  });

  it("prunes old data but keeps the transition preceding the window", () => {
    setStatuses({ p1: "working" });
    vi.advanceTimersByTime(ACTIVITY_WINDOW_MS + 60_000);
    setStatuses({ p1: "requires_input" });
    const t = useAgentActivityStore.getState().transitions.p1;
    expect(t.map((x) => x.status)).toEqual(["working", "requires_input"]);
    vi.advanceTimersByTime(ACTIVITY_WINDOW_MS + 5 * 60 * 1000);
    const later = useAgentActivityStore.getState();
    expect(later.transitions.p1).toHaveLength(1);
    expect(later.transitions.p1[0].status).toBe("requires_input");
    const cutoff = Date.now() - ACTIVITY_WINDOW_MS - 5 * 60 * 1000;
    expect(later.samples.every((s) => s.at >= cutoff)).toBe(true);
  });

  it("caps entries per pane at 200", () => {
    for (let i = 0; i < 300; i++) {
      setStatuses({ p1: i % 2 ? "working" : "requires_input" });
    }
    expect(useAgentActivityStore.getState().transitions.p1).toHaveLength(200);
  });
});
