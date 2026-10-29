/**
 * What a recorded run writes in its server's notification log: a run that
 * started its agent ran, one that could not failed to start, a skipped one
 * says nothing.
 */

import { describe, expect, it } from "vitest";

import { runNotification } from "../notify";

const TRIAGE = { id: "auto-1", name: "Morning triage", agentKind: "claude" as const };

describe("runNotification", () => {
  it("says a started run ran, and where its agent started", () => {
    expect(runNotification(TRIAGE, { outcome: "started" }, "Morning triage · Oct 29 09:00")).toEqual({
      kind: "automation-ran",
      title: "Morning triage ran",
      body: "Started Claude in Morning triage · Oct 29 09:00",
      target: { type: "automation", automationId: "auto-1" },
    });
    expect(runNotification({ ...TRIAGE, agentKind: "codex" }, { outcome: "started" }, null)?.body).toBe(
      "Started Codex",
    );
  });

  it("says a failed run failed to start, with why", () => {
    expect(
      runNotification(TRIAGE, { outcome: "failed", detail: "The project isn't set up on this host" }, null),
    ).toEqual({
      kind: "automation-failed",
      title: "Morning triage failed to start",
      body: "The project isn't set up on this host",
      target: { type: "automation", automationId: "auto-1" },
    });
  });

  it("says nothing for a skipped run", () => {
    expect(runNotification(TRIAGE, { outcome: "skipped", detail: "missed" }, null)).toBeNull();
  });
});
