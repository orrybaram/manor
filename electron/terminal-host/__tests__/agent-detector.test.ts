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
        title: null,
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

    it('setStatus("idle") calls transitionToGone — kind becomes null', () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      onChange.mockClear();

      detector.setStatus("idle");
      expect(detector.getState().status).toBe("idle");
      expect(detector.getState().kind).toBeNull();
      expect(detector.getState().processName).toBeNull();
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0][0].kind).toBeNull();
    });
  });

  // ── 4. Agent exit (foreground process disappears) ──

  describe("agent exit", () => {
    it('agent thinking, FG becomes null -> transitionToGone (status=idle, kind=null)', () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      onChange.mockClear();

      detector.updateForegroundProcess(null);
      expect(detector.getState().status).toBe("idle");
      expect(detector.getState().kind).toBeNull();
      expect(detector.getState().processName).toBeNull();
    });

    it('agent requires_input, FG becomes null -> transitionToGone (status=idle, kind=null)', () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.setStatus("requires_input");
      onChange.mockClear();

      detector.updateForegroundProcess(null);
      expect(detector.getState().status).toBe("idle");
      expect(detector.getState().kind).toBeNull();
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

    it('agent complete, FG becomes null -> transitionToGone (status=idle, kind=null)', () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.setStatus("complete");
      onChange.mockClear();

      detector.updateForegroundProcess(null);
      expect(detector.getState().status).toBe("idle");
      expect(detector.getState().kind).toBeNull();
    });

    it("complete lingers for 5s then auto-transitions to idle (gone)", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.setStatus("complete");
      onChange.mockClear();

      // Still complete before linger expires
      vi.advanceTimersByTime(4999);
      expect(detector.getState().status).toBe("complete");
      expect(onChange).not.toHaveBeenCalled();

      // Linger expires → transitions to idle (gone)
      vi.advanceTimersByTime(1);
      expect(detector.getState().status).toBe("idle");
      expect(detector.getState().kind).toBeNull();
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });

  // ── 5. Title clearing on new turn ──

  describe("title clearing on new turn", () => {
    it("thinking clears title for new turn", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.setTitle("Working on feature X");
      detector.setStatus("complete");
      expect(detector.getState().title).toBe("Working on feature X");

      // New turn starts — title should be cleared
      detector.setStatus("thinking");
      expect(detector.getState().title).toBeNull();
      expect(detector.getState().kind).toBe("claude");
      expect(detector.getState().status).toBe("thinking");
    });

    it("complete persists through user typing (no input detection)", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.setStatus("complete");
      expect(detector.getState().status).toBe("complete");
      // No setInputReceived method — complete persists until next turn or exit
    });

    it("title preserved during working/requires_input transitions", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      detector.setTitle("Working on feature X");
      detector.setStatus("working");
      expect(detector.getState().title).toBe("Working on feature X");
      detector.setStatus("requires_input");
      expect(detector.getState().title).toBe("Working on feature X");
    });
  });

  // ── 6. Callback behavior ──

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
        title: null,
      });
    });

    it("does NOT fire when status unchanged", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      onChange.mockClear();

      detector.setStatus("thinking");
      expect(onChange).not.toHaveBeenCalled();
    });

    it("process exit fires single idle callback (transitionToGone, not complete)", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");
      onChange.mockClear();

      detector.updateForegroundProcess(null);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0][0].status).toBe("idle");
      expect(onChange.mock.calls[0][0].kind).toBeNull();
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

  // ── 7. Edge cases ──

  describe("edge cases", () => {
    it("agent switch: claude exits -> opencode starts immediately -> correct kind/status", () => {
      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");

      // Claude exits
      detector.updateForegroundProcess(null);
      // Gone — no complete flash
      expect(detector.getState().status).toBe("idle");
      expect(detector.getState().kind).toBeNull();

      // opencode starts immediately
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
    it("records exact lifecycle: idle -> thinking -> requires_input -> thinking -> complete -> thinking (new turn, title cleared)", () => {
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

      // Hook: complete (Stop hook) — persists
      detector.setStatus("complete");

      // New turn starts — title cleared
      detector.setStatus("thinking");

      expect(transitions).toEqual([
        "thinking",
        "requires_input",
        "thinking",
        "complete",
        "thinking",
      ]);
    });

    it("records process exit lifecycle: thinking -> gone (idle with kind=null)", () => {
      const transitions: AgentState[] = [];
      detector.onStatusChange = (state: AgentState) => {
        transitions.push({ ...state });
      };

      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");

      // Process exits
      detector.updateForegroundProcess(null);

      expect(transitions.map((t) => t.status)).toEqual(["thinking", "idle"]);
      // The idle from process exit has kind=null (truly gone)
      expect(transitions[1].kind).toBeNull();
    });
  });
});
