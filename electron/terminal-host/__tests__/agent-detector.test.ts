import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentDetector } from "../agent-detector";
import type { AgentState, AgentStatus } from "../types";

describe("AgentDetector", () => {
  let detector: AgentDetector;
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new AgentDetector();
    onChange = vi.fn();
    detector.onStatusChange = onChange;
  });

  afterEach(() => {
    detector.dispose();
    vi.useRealTimers();
  });

  // ── 1. Initial state ──

  describe("initial state", () => {
    it("starts in idle with null kind and null processName", () => {
      const state = detector.getState();
      expect(state.status).toBe("idle");
      expect(state.kind).toBeNull();
      expect(state.processName).toBeNull();
    });

    it("getState() returns the expected AgentState shape", () => {
      const state = detector.getState();
      expect(state).toEqual({
        kind: null,
        status: "idle",
        processName: null,
        since: expect.any(Number),
      });
    });
  });

  // ── 2. Agent detection via updateForegroundProcess() ──

  describe("agent detection via updateForegroundProcess()", () => {
    it('recognizes "claude" as kind: "claude"', () => {
      detector.updateForegroundProcess("claude");
      expect(detector.getState().kind).toBe("claude");
    });

    it('recognizes "opencode" as kind: "opencode"', () => {
      detector.updateForegroundProcess("opencode");
      expect(detector.getState().kind).toBe("opencode");
    });

    it('recognizes "codex" as kind: "codex"', () => {
      detector.updateForegroundProcess("codex");
      expect(detector.getState().kind).toBe("codex");
    });

    it("stays idle when agent first detected (no dot until hook fires)", () => {
      detector.updateForegroundProcess("claude");
      expect(detector.getState().status).toBe("idle");
    });

    it("reports null kind for unknown processes", () => {
      for (const proc of ["vim", "git", "python"]) {
        detector.updateForegroundProcess(proc);
        expect(detector.getState().kind).toBeNull();
      }
    });

    it("handles path basenames: /usr/local/bin/claude -> claude", () => {
      detector.updateForegroundProcess("/usr/local/bin/claude");
      expect(detector.getState().kind).toBe("claude");
      expect(detector.getState().processName).toBe("/usr/local/bin/claude");
    });

    it('case-insensitive: "Claude" matches', () => {
      detector.updateForegroundProcess("Claude");
      expect(detector.getState().kind).toBe("claude");
    });

    it("null/empty name when no previous agent stays idle", () => {
      detector.updateForegroundProcess(null);
      expect(detector.getState().status).toBe("idle");
      expect(detector.getState().kind).toBeNull();

      detector.updateForegroundProcess("");
      expect(detector.getState().status).toBe("idle");
    });
  });

  // ── 3. Hook-driven transitions via setStatus() ──

  describe("hook-driven transitions via setStatus()", () => {
    it('after agent detected: setStatus("thinking") -> status thinking', () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      expect(detector.getState().status).toBe("thinking");
    });

    it("thinking -> requires_input via setStatus", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.setStatus("requires_input");
      expect(detector.getState().status).toBe("requires_input");
    });

    it("requires_input -> thinking (permission granted)", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.setStatus("requires_input");
      detector.setStatus("thinking");
      expect(detector.getState().status).toBe("thinking");
    });

    it("setStatus(thinking) when already thinking does not fire callback (dedup)", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      onChange.mockClear();

      detector.setStatus("thinking");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("setStatus ignored when no agent kind set", () => {
      detector.setStatus("thinking");
      expect(detector.getState().status).toBe("idle");
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  // ── 4. Agent exit (foreground process disappears) ──

  describe("agent exit", () => {
    it('agent thinking, FG becomes null -> "complete"', () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      onChange.mockClear();

      detector.updateForegroundProcess(null);
      expect(detector.getState().status).toBe("complete");
    });

    it('agent requires_input, FG becomes null -> "complete"', () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.setStatus("requires_input");
      onChange.mockClear();

      detector.updateForegroundProcess(null);
      expect(detector.getState().status).toBe("complete");
    });

    it("agent idle, FG becomes null -> stays idle (no complete flash)", () => {
      detector.updateForegroundProcess("claude");
      // still idle, no hook fired
      onChange.mockClear();

      detector.updateForegroundProcess(null);
      expect(detector.getState().status).toBe("idle");
      // Should not have transitioned through complete
      const completeCalls = onChange.mock.calls.filter(
        ([s]: [AgentState]) => s.status === "complete"
      );
      expect(completeCalls).toHaveLength(0);
    });

    it("complete -> idle after COMPLETE_CLEAR_MS (3000ms)", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.updateForegroundProcess(null);
      expect(detector.getState().status).toBe("complete");

      vi.advanceTimersByTime(2999);
      expect(detector.getState().status).toBe("complete");

      vi.advanceTimersByTime(1);
      expect(detector.getState().status).toBe("idle");
    });
  });

  // ── 5. Callback behavior ──

  describe("callback behavior", () => {
    it("onStatusChange fires on every actual transition", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      expect(onChange).toHaveBeenCalledTimes(1);

      detector.setStatus("requires_input");
      expect(onChange).toHaveBeenCalledTimes(2);
    });

    it("receives correct AgentState shape", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");

      const state = onChange.mock.calls[0][0] as AgentState;
      expect(state).toEqual({
        kind: "claude",
        status: "thinking",
        processName: "claude",
        since: expect.any(Number),
      });
    });

    it("does NOT fire when status unchanged", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      onChange.mockClear();

      detector.setStatus("thinking");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("fires for complete AND the subsequent idle (two callbacks)", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      onChange.mockClear();

      detector.updateForegroundProcess(null);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0][0].status).toBe("complete");

      vi.advanceTimersByTime(3000);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange.mock.calls[1][0].status).toBe("idle");
    });

    it("fires in correct order during rapid transitions", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.setStatus("requires_input");
      detector.setStatus("thinking");

      const statuses = onChange.mock.calls.map(
        ([s]: [AgentState]) => s.status
      );
      expect(statuses).toEqual(["thinking", "requires_input", "thinking"]);
    });
  });

  // ── 6. Timer behavior (fake timers) ──

  describe("timer behavior", () => {
    it("complete->idle timer is exactly 3000ms", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.updateForegroundProcess(null);

      vi.advanceTimersByTime(2999);
      expect(detector.getState().status).toBe("complete");

      vi.advanceTimersByTime(1);
      expect(detector.getState().status).toBe("idle");
    });

    it("timer cleared when new agent appears during complete", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.updateForegroundProcess(null);
      expect(detector.getState().status).toBe("complete");

      // New agent appears before timer fires
      detector.updateForegroundProcess("opencode");

      vi.advanceTimersByTime(5000);
      // Should not have auto-transitioned to idle from old timer
      // It went idle because the new agent detection resets to idle
      expect(detector.getState().status).toBe("idle");
      expect(detector.getState().kind).toBe("opencode");
    });

    it("timer cleared on dispose()", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.updateForegroundProcess(null);
      expect(detector.getState().status).toBe("complete");

      detector.dispose();
      onChange.mockClear();

      vi.advanceTimersByTime(5000);
      // No idle callback should have fired after dispose
      expect(onChange).not.toHaveBeenCalled();
      // Status stays complete since timer was cleared
      expect(detector.getState().status).toBe("complete");
    });

    it("rapid exits don't stack timers (only one pending at a time)", () => {
      // First agent session
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.updateForegroundProcess(null);
      expect(detector.getState().status).toBe("complete");

      // Advance partway, then start and exit a new session
      vi.advanceTimersByTime(1000);

      // Complete -> idle happens from timer of first complete
      vi.advanceTimersByTime(2000); // first timer fires -> idle
      expect(detector.getState().status).toBe("idle");

      detector.updateForegroundProcess("opencode");
      detector.setStatus("thinking");
      detector.updateForegroundProcess(null);
      expect(detector.getState().status).toBe("complete");

      onChange.mockClear();
      vi.advanceTimersByTime(3000);
      expect(detector.getState().status).toBe("idle");

      // Only one idle transition should have fired
      const idleCalls = onChange.mock.calls.filter(
        ([s]: [AgentState]) => s.status === "idle"
      );
      expect(idleCalls).toHaveLength(1);
    });
  });

  // ── 7. Edge cases ──

  describe("edge cases", () => {
    it("agent switch: claude exits -> opencode starts immediately -> correct kind/status", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");

      // Claude exits
      detector.updateForegroundProcess(null);
      expect(detector.getState().status).toBe("complete");

      // opencode starts immediately (before complete timer fires)
      detector.updateForegroundProcess("opencode");
      expect(detector.getState().kind).toBe("opencode");
      expect(detector.getState().status).toBe("idle");

      // Hook fires for opencode
      detector.setStatus("thinking");
      expect(detector.getState().status).toBe("thinking");
      expect(detector.getState().kind).toBe("opencode");
    });

    it("unknown FG process while agent thinking (child process) keeps tracking", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");

      // Agent spawns git as a child process
      detector.updateForegroundProcess("git");
      expect(detector.getState().status).toBe("thinking");
      expect(detector.getState().kind).toBe("claude");
    });

    it("dispose() is safe to call multiple times", () => {
      detector.dispose();
      detector.dispose();
      detector.dispose();
      // No error thrown
    });

    it("processOutput() is a no-op", () => {
      detector.processOutput("some terminal output");
      expect(detector.getState().status).toBe("idle");
    });

    it("setAltScreen() is a no-op", () => {
      detector.setAltScreen(true);
      expect(detector.getState().status).toBe("idle");
      detector.setAltScreen(false);
      expect(detector.getState().status).toBe("idle");
    });
  });

  // ── 8. Transition sequence capture ──

  describe("transition sequence capture", () => {
    it("records exact lifecycle: idle -> thinking -> requires_input -> thinking -> complete -> idle", () => {
      const transitions: AgentStatus[] = [];
      detector.onStatusChange = (state: AgentState) => {
        transitions.push(state.status);
      };

      // Start idle (initial state, no callback)
      expect(detector.getState().status).toBe("idle");

      // Agent detected — stays idle
      detector.updateForegroundProcess("claude");
      expect(detector.getState().status).toBe("idle");

      // Hook: thinking
      detector.setStatus("thinking");

      // Hook: requires_input
      detector.setStatus("requires_input");

      // Hook: thinking (permission granted)
      detector.setStatus("thinking");

      // Agent exits -> complete
      detector.updateForegroundProcess(null);

      // Timer fires -> idle
      vi.advanceTimersByTime(3000);

      expect(transitions).toEqual([
        "thinking",
        "requires_input",
        "thinking",
        "complete",
        "idle",
      ]);
    });
  });
});
