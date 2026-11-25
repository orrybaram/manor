import { describe, it, expect } from "vitest";
import {
  lanePriority,
  laneSegments,
  liveSessions,
} from "../agent-activity-store";
import type {
  AgentActivityEntry,
  AgentActivityTransition,
  AgentStatus,
} from "../../electron.d";

function entry(...transitions: [AgentStatus, number][]): AgentActivityEntry {
  return {
    meta: { name: null, projectId: null, workspacePath: null, hostId: "local" },
    transitions: transitions.map(([status, at]) => ({ status, at })),
  };
}

const t = (...list: [AgentStatus, number][]): AgentActivityTransition[] =>
  entry(...list).transitions;

describe("laneSegments", () => {
  const all = [{ start: 0, end: 100 }];

  it("clips to the window, merges equal neighbours, drops idle and responded", () => {
    const segs = laneSegments(
      t(
        ["working", 0],
        ["thinking", 20],
        ["working", 30],
        ["idle", 50],
        ["responded", 60],
        ["requires_input", 70],
      ),
      10,
      100,
      all,
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
      laneSegments(t(["working", 0], ["working", 10]), 0, 20, all),
    ).toEqual([{ status: "working", from: 0, to: 20 }]);
  });

  it("never crosses a closed-app gap", () => {
    const segs = laneSegments(t(["working", 0]), 0, 100, [
      { start: 0, end: 30 },
      { start: 60, end: 100 },
    ]);
    expect(segs).toEqual([
      { status: "working", from: 0, to: 30 },
      { status: "working", from: 60, to: 100 },
    ]);
  });
});

describe("liveSessions", () => {
  it("extends the running session to the renderer's now", () => {
    const sessions = [
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ];
    expect(liveSessions(sessions, 50)).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 50 },
    ]);
    // So a long working turn keeps growing to now.
    expect(
      laneSegments(
        [{ status: "working", at: 25 }],
        0,
        50,
        liveSessions(sessions, 50),
      ),
    ).toEqual([{ status: "working", from: 25, to: 50 }]);
  });

  it("leaves sessions alone when the last already reaches now", () => {
    const sessions = [{ start: 0, end: 60 }];
    expect(liveSessions(sessions, 50)).toBe(sessions);
    expect(liveSessions([], 50)).toEqual([]);
  });
});

describe("lanePriority", () => {
  it("orders needs-you, then active, then most recent, dropping inactive", () => {
    const agents = {
      old: entry(["working", 10], ["idle", 20]),
      recent: entry(["working", 30], ["responded", 60]),
      active: entry(["working", 40]),
      waiting: entry(["requires_input", 50]),
      quiet: entry(["responded", 50]),
      before: entry(["working", 0], ["idle", 5]),
    };
    expect(lanePriority(agents, 10, 100)).toEqual([
      "waiting",
      "active",
      "recent",
      "old",
    ]);
  });
});
