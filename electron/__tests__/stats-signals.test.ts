import { describe, it, expect } from "vitest";

import { isKill, KILL_STATUSES } from "../stats-signals";

describe("stats-signals", () => {
  describe("KILL_STATUSES", () => {
    it("covers exactly the in-flight and waiting statuses", () => {
      expect([...KILL_STATUSES].sort()).toEqual([
        "requires_input",
        "thinking",
        "working",
      ]);
    });
  });

  describe("isKill", () => {
    const cases: Array<{
      status: string;
      lastAgentStatus: string | null;
      expected: boolean;
    }> = [
      { status: "active", lastAgentStatus: "working", expected: true },
      { status: "active", lastAgentStatus: "thinking", expected: true },
      { status: "active", lastAgentStatus: "requires_input", expected: true },
      // Done means done — closing a finished agent is not a kill.
      { status: "active", lastAgentStatus: "responded", expected: false },
      { status: "active", lastAgentStatus: "idle", expected: false },
      { status: "active", lastAgentStatus: null, expected: false },
      // Only live agents can be killed.
      { status: "completed", lastAgentStatus: "working", expected: false },
      { status: "error", lastAgentStatus: "thinking", expected: false },
      { status: "abandoned", lastAgentStatus: "requires_input", expected: false },
    ];

    for (const { status, lastAgentStatus, expected } of cases) {
      it(`${status} + ${lastAgentStatus} → ${expected}`, () => {
        expect(isKill({ status, lastAgentStatus })).toBe(expected);
      });
    }

    it("ignores an unknown last status", () => {
      expect(isKill({ status: "active", lastAgentStatus: "daydreaming" })).toBe(false);
    });
  });
});
