import { describe, expect, it } from "vitest";
import type { AutomationRunView } from "../../../../lib/automation-views";
import { relativeWhen, runStatusText, runWhatText, scheduleNote } from "../automation-text";

function run(over: Partial<AutomationRunView>): AutomationRunView {
  return {
    id: "r",
    automationId: "a",
    scheduledFor: "2026-10-29T09:00:00.000Z",
    firedAt: "2026-10-29T09:00:00.000Z",
    trigger: "schedule",
    outcome: "started",
    status: null,
    ...over,
  };
}

const opts = { local: false, workspaceName: (p: string) => (p === "/w" ? "triage · Oct 29" : null) };

describe("runWhatText", () => {
  it("says why a run was skipped or failed", () => {
    expect(runWhatText(run({ outcome: "skipped", reason: "still-working" }), opts)).toBe(
      "Skipped · previous run still working",
    );
    expect(runWhatText(run({ outcome: "skipped", reason: "missed", missedCount: 3 }), opts)).toBe(
      "Missed 3 scheduled runs",
    );
    expect(runWhatText(run({ outcome: "failed", reason: "project-missing" }), opts)).toBe(
      "Project isn't set up on this host",
    );
    expect(runWhatText(run({ outcome: "failed", reason: "error", detail: "boom" }), opts)).toBe("boom");
  });

  it("names a started run's workspace, and a catch-up's cause", () => {
    expect(runWhatText(run({ workspacePath: "/w" }), opts)).toBe("Opened triage · Oct 29");
    expect(runWhatText(run({ trigger: "manual", workspacePath: "/w" }), opts)).toBe(
      "Run now · triage · Oct 29",
    );
    expect(runWhatText(run({ trigger: "catch-up" }), opts)).toBe("Caught up · host was asleep");
    expect(runWhatText(run({ trigger: "catch-up" }), { ...opts, local: true })).toBe(
      "Caught up · Manor was closed",
    );
  });
});

describe("runStatusText", () => {
  it("follows the run's Agent", () => {
    expect(runStatusText(run({ status: "working" })).label).toBe("Working");
    expect(runStatusText(run({ status: "requires_input" }))).toEqual({ label: "Needs input", tone: "input" });
    expect(runStatusText(run({ status: "idle" })).label).toBe("Exited");
    expect(runStatusText(run({ agentId: "x" })).label).toBe("Exited");
    expect(runStatusText(run({})).label).toBe("Starting");
    expect(runStatusText(run({ outcome: "failed" })).label).toBe("Failed to start");
  });
});

describe("relativeWhen", () => {
  it("says today, tomorrow, a weekday, then a date", () => {
    const now = new Date(2026, 9, 29, 13, 40);
    expect(relativeWhen(new Date(2026, 9, 29, 14, 15).toISOString(), now)).toBe("Today 14:15");
    expect(relativeWhen(new Date(2026, 9, 30, 9, 0).toISOString(), now)).toBe("Tomorrow 09:00");
    expect(relativeWhen(new Date(2026, 10, 2, 9, 0).toISOString(), now)).toBe("Mon 09:00");
    expect(relativeWhen(new Date(2026, 10, 12, 9, 0).toISOString(), now)).toBe("12 Nov 09:00");
  });
});

describe("scheduleNote", () => {
  it("says a local automation needs Manor open, a remote one catches up", () => {
    expect(scheduleNote(true, "This Mac", 720)).toBe("Runs only while Manor is open on this computer");
    expect(scheduleNote(false, "box-1", 720)).toBe(
      "If box-1 is asleep at that time, it runs once when it wakes (within 12 h).",
    );
  });
});
