import { describe, expect, it } from "vitest";
import {
  LANE_START,
  advanceLane,
  dirtySentence,
  failureBody,
  laneView,
  refusalSentence,
  stepLabel,
  type LaneProgress,
} from "../workspace-host-move-view";
import type { WorkspaceMoveStep } from "../../electron";

const STEPS: WorkspaceMoveStep[] = [
  { id: "push" },
  { id: "setUp" },
  { id: "create" },
  { id: "setupScript" },
  { id: "restore" },
  { id: "agents", detail: "claude" },
  { id: "removeSource" },
];

function lane(...events: Parameters<typeof advanceLane>[1][]): LaneProgress {
  return events.reduce(advanceLane, LANE_START);
}

describe("stepLabel", () => {
  it("names each step, with the hosts where it says them", () => {
    expect(STEPS.map((s) => stepLabel(s, "devbox", "This machine"))).toEqual([
      "Pushing branch",
      "Setting up on devbox",
      "Creating workspace",
      "Running start script",
      "Restoring tabs",
      "Starting Claude",
      "Removing from This machine",
    ]);
  });

  it("starts agents by their detail, or 'agents' without one", () => {
    expect(stepLabel({ id: "agents", detail: "2 codex agents" }, "b", "a")).toBe(
      "Starting 2 Codex agents",
    );
    expect(stepLabel({ id: "agents" }, "b", "a")).toBe("Starting agents");
  });
});

describe("refusalSentence", () => {
  it("leaves dirty to its own block", () => {
    expect(refusalSentence({ code: "dirty", files: [] }, "devbox", "This machine")).toBeNull();
  });

  it("has one sentence for each other refusal", () => {
    for (const code of [
      "no-origin",
      "main-workspace",
      "same-host",
      "detached",
      "target-cannot-fast-forward",
      "target-main-on-branch",
    ] as const) {
      expect(refusalSentence({ code }, "devbox", "This machine")).toMatch(/\.$/);
    }
    expect(refusalSentence({ code: "target-dirty", files: [] }, "devbox", "x")).toContain(
      "devbox",
    );
  });
});

describe("dirtySentence", () => {
  it("counts the files", () => {
    expect(dirtySentence(3)).toBe("Commit or discard 3 changed files first.");
    expect(dirtySentence(1)).toBe("Commit or discard 1 changed file first.");
  });
});

describe("failureBody", () => {
  it("names the step and both hosts", () => {
    expect(failureBody("create", STEPS, "devbox", "This machine")).toBe(
      "Creating workspace on devbox failed. Nothing changed on This machine.",
    );
  });

  it("doesn't name the target twice for the set up", () => {
    expect(failureBody("setUp", STEPS, "devbox", "This machine")).toBe(
      "Setting up on devbox failed. Nothing changed on This machine.",
    );
  });

  it("says the workspace is ready when only the removal failed", () => {
    expect(failureBody("removeSource", STEPS, "devbox", "This machine")).toBe(
      "The workspace is ready on devbox, but removing it from This machine failed.",
    );
  });

  it("falls back to the move itself with no step", () => {
    expect(failureBody(null, [], "devbox", "This machine")).toBe(
      "Moving to devbox failed. Nothing changed on This machine.",
    );
  });
});

describe("laneView", () => {
  it("is empty before the plan", () => {
    expect(laneView(LANE_START)).toMatchObject({ fill: 0, current: null, count: null });
  });

  it("fills one segment per step and counts k of N", () => {
    const running = lane(
      { type: "plan", steps: STEPS },
      { type: "step", index: 0, status: "running" },
      { type: "step", index: 0, status: "done" },
      { type: "step", index: 1, status: "running" },
    );
    expect(laneView(running)).toMatchObject({
      fill: 1 / 7,
      current: { id: "setUp" },
      count: "2 of 7",
      targetLit: false,
      sourceDim: false,
    });
  });

  it("lights the target from create and dims the source while it is removed", () => {
    const creating = lane({ type: "plan", steps: STEPS }, { type: "step", index: 2, status: "running" });
    expect(laneView(creating).targetLit).toBe(true);
    const removing = lane({ type: "plan", steps: STEPS }, { type: "step", index: 6, status: "running" });
    expect(laneView(removing)).toMatchObject({ targetLit: true, sourceDim: true, count: "7 of 7" });
  });

  it("never moves backwards", () => {
    const later = lane(
      { type: "plan", steps: STEPS },
      { type: "step", index: 3, status: "running" },
      { type: "step", index: 2, status: "done" },
    );
    expect(laneView(later).current?.id).toBe("setupScript");
  });

  it("is full on success", () => {
    const done = { ...lane({ type: "plan", steps: STEPS }), succeeded: true };
    expect(laneView(done)).toMatchObject({ fill: 1, current: null, targetLit: true });
  });
});
