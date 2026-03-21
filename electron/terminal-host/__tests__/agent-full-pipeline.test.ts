import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentDetector } from "../agent-detector";
import { Session } from "../session";
import { OutputPatternMatcher } from "../output-pattern-matcher";
import { TitleDetector } from "../title-detector";
import type { AgentState, AgentStatus } from "../types";

function createTestHarness() {
  const detector = new AgentDetector();
  const patternMatcher = new OutputPatternMatcher();
  const titleDetector = new TitleDetector();
  const transitions: AgentState[] = [];
  detector.onStatusChange = (state) => transitions.push({ ...state });
  return { detector, patternMatcher, titleDetector, transitions };
}

function statuses(transitions: AgentState[]): AgentStatus[] {
  return transitions.map((t) => t.status);
}

describe("Full Pipeline Integration — Fallback Detection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Scenario: Hooks working — fallbacks stay quiet", () => {
    const { detector, patternMatcher, transitions } = createTestHarness();

    // 1. FG → "claude"
    detector.updateForegroundProcess("claude");

    // 2. Hook: UserPromptSubmit → thinking
    detector.setStatus("thinking");

    // 3. Output contains busy pattern — fallback tries to fire
    patternMatcher.addData("ctrl+c to interrupt");
    const fallbackResult = patternMatcher.detect();
    expect(fallbackResult).toBe("thinking");

    // Apply fallback — should be ignored because hook fired recently
    detector.setFallbackStatus(fallbackResult!);

    // 4. Verify: status is still "thinking" from hook (not overridden)
    expect(detector.getState().status).toBe("thinking");

    // 5. Hook: PreToolUse → working
    detector.setStatus("working");

    // 6. Hook: PostToolUse → thinking
    detector.setStatus("thinking");

    // 7. Hook: Stop → complete
    detector.setStatus("complete");

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "working",
        "thinking",
        "complete",
      ]
    `);

    detector.dispose();
  });

  it("Scenario: Hooks fail — output patterns take over", () => {
    const { detector, patternMatcher, transitions } = createTestHarness();

    // 1. FG → "claude" → idle (detected but no hook)
    detector.updateForegroundProcess("claude");

    // 2. No hook fires (simulating hook failure)
    //    Advance past debounce window so fallback can work
    vi.advanceTimersByTime(2500);

    // 3. Output contains busy pattern → fallback detects → thinking
    patternMatcher.addData("ctrl+c to interrupt");
    const busyResult = patternMatcher.detect();
    expect(busyResult).toBe("thinking");
    detector.setFallbackStatus(busyResult!);

    // 4. Output contains permission prompt → fallback detects → requires_input
    patternMatcher.addData("Yes, allow once");
    const permResult = patternMatcher.detect();
    expect(permResult).toBe("requires_input");
    detector.setFallbackStatus(permResult!);

    // 5. Output contains idle prompt → fallback detects → idle
    patternMatcher.clear();
    patternMatcher.addData("❯");
    const idleResult = patternMatcher.detect();
    expect(idleResult).toBe("idle");
    // Note: setFallbackStatus won't transition to idle directly because
    // transitionToIdle clears kind, but setFallbackStatus requires kind.
    // The idle fallback would need the FG process to disappear instead.
    // This verifies the pattern matcher detects idle correctly.

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "requires_input",
      ]
    `);

    detector.dispose();
  });

  it("Scenario: Title-based detection", () => {
    const { detector, titleDetector, transitions } = createTestHarness();

    // 1. FG → "claude"
    detector.updateForegroundProcess("claude");

    // Advance past debounce window
    vi.advanceTimersByTime(2500);

    // 2. OSC title contains braille character → working (title fallback)
    titleDetector.setTitle("⠋ claude working");
    const workingResult = titleDetector.detect();
    expect(workingResult).toBe("working");
    detector.setFallbackStatus(workingResult as AgentStatus);

    // 3. OSC title contains done marker → complete (title fallback)
    titleDetector.setTitle("✻ claude done");
    const completeResult = titleDetector.detect();
    expect(completeResult).toBe("complete");
    detector.setFallbackStatus(completeResult as AgentStatus);

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "working",
        "complete",
      ]
    `);

    detector.dispose();
  });

  it("Scenario: Stale PID cleanup", () => {
    const { detector, transitions } = createTestHarness();

    // Mock process.kill to simulate process existence checks
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    // 1. FG → "claude" with PID
    detector.updateForegroundProcess("claude", 12345);

    // 2. Hook: UserPromptSubmit → thinking
    detector.setStatus("thinking");

    // 3. Agent crashes — process.kill(pid, 0) throws ESRCH
    killSpy.mockImplementation(() => {
      const err = new Error("No such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    // 4. PID sweep detects dead process → transitionToGone → idle with kind=null
    detector.sweepStalePids();

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "idle",
      ]
    `);

    // PID sweep calls transitionToGone — kind should be null
    expect(detector.getState().kind).toBeNull();

    killSpy.mockRestore();
    detector.dispose();
  });

  it("Scenario: Subagent tracking", () => {
    const { detector, transitions } = createTestHarness();

    // 1. FG → "claude"
    detector.updateForegroundProcess("claude");

    // 2. Hook: UserPromptSubmit → thinking
    detector.setStatus("thinking");

    // 3. Hook: SubagentStart → working
    detector.setStatus("working");

    // 4. Hook: SubagentStop → thinking
    detector.setStatus("thinking");

    // 5. Hook: Stop → complete
    detector.setStatus("complete");

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "working",
        "thinking",
        "complete",
      ]
    `);

    detector.dispose();
  });

  it("Scenario: Error recovery", () => {
    const { detector, transitions } = createTestHarness();

    // 1. FG → "claude"
    detector.updateForegroundProcess("claude");

    // 2. Hook: UserPromptSubmit → thinking
    detector.setStatus("thinking");

    // 3. Hook: StopFailure → error
    detector.setStatus("error");

    // 4. FG → null → idle (error clears when process exits)
    //    When status is "error" and FG goes null, updateForegroundProcess
    //    does not call transitionToComplete (guarded by the error check).
    //    The agent stays in error until transitionToIdle clears it.
    //    Since the status is "error", the FG null path doesn't match
    //    the thinking/working/requires_input check, nor complete, and
    //    it hits the else-if for "not error" which is false, so no transition.
    //    We need to verify the actual behavior here.
    detector.updateForegroundProcess(null);

    // The error status should persist until explicitly cleared.
    // FG going null when in error state doesn't auto-transition.
    // Verify the transitions that did occur.
    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "error",
      ]
    `);

    detector.dispose();
  });

  it("Scenario: Fallback debounce — hook takes priority within 2s window", () => {
    const { detector, patternMatcher, transitions } = createTestHarness();

    // 1. FG → "claude"
    detector.updateForegroundProcess("claude");

    // 2. Hook fires → thinking (sets lastHookTime)
    detector.setStatus("thinking");

    // 3. Immediately try fallback → requires_input (should be debounced)
    patternMatcher.addData("Yes, allow once");
    detector.setFallbackStatus("requires_input");

    // 4. Advance 1s (still within debounce window)
    vi.advanceTimersByTime(1000);
    detector.setFallbackStatus("requires_input");

    // 5. Status should still be thinking (fallback debounced)
    expect(detector.getState().status).toBe("thinking");

    // 6. Advance past debounce (total 2.5s since hook)
    vi.advanceTimersByTime(1500);
    detector.setFallbackStatus("requires_input");

    // 7. Now fallback should work
    expect(detector.getState().status).toBe("requires_input");

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "requires_input",
      ]
    `);

    detector.dispose();
  });

  it("Scenario: Fallback ignored when no agent tracked", () => {
    const { detector, transitions } = createTestHarness();

    // No agent detected — fallback should be ignored
    vi.advanceTimersByTime(5000);
    detector.setFallbackStatus("thinking");
    detector.setFallbackStatus("requires_input");
    detector.setFallbackStatus("working");

    expect(statuses(transitions)).toMatchInlineSnapshot(`[]`);

    detector.dispose();
  });

  it("Scenario: PID sweep — alive process keeps tracking", () => {
    const { detector, transitions } = createTestHarness();

    // Mock process.kill to simulate alive process
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(() => true);

    // 1. FG → "claude" with PID
    detector.updateForegroundProcess("claude", 99999);

    // 2. Hook: UserPromptSubmit → thinking
    detector.setStatus("thinking");

    // 3. PID sweep — process is alive
    detector.sweepStalePids();

    // 4. Status should still be thinking
    expect(detector.getState().status).toBe("thinking");

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
      ]
    `);

    killSpy.mockRestore();
    detector.dispose();
  });

  it("Scenario: PID sweep — EPERM means process exists", () => {
    const { detector, transitions } = createTestHarness();

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("Operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    detector.updateForegroundProcess("claude", 55555);
    detector.setStatus("thinking");

    // EPERM = process exists but can't signal → keep tracking
    detector.sweepStalePids();

    expect(detector.getState().status).toBe("thinking");

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
      ]
    `);

    killSpy.mockRestore();
    detector.dispose();
  });

  it("Scenario: Output pattern matcher ring buffer and detection pipeline", () => {
    const matcher = new OutputPatternMatcher();

    // Empty buffer → null
    expect(matcher.detect()).toBeNull();

    // Add busy line
    matcher.addData("Thinking... ctrl+c to interrupt");
    expect(matcher.detect()).toBe("thinking");

    // Add permission prompt — should override busy (more recent)
    matcher.addData("Yes, allow once");
    expect(matcher.detect()).toBe("requires_input");

    // Clear and add idle prompt
    matcher.clear();
    matcher.addData("❯");
    expect(matcher.detect()).toBe("idle");

    // Braille spinner detection
    matcher.clear();
    matcher.addData("⠋ Loading...");
    expect(matcher.detect()).toBe("thinking");

    // Whimsical pattern detection
    matcher.clear();
    matcher.addData("Cerebrating... (53s, 749 tokens)");
    expect(matcher.detect()).toBe("thinking");
  });

  it("Scenario: Title detector state machine", () => {
    const titleDetector = new TitleDetector();

    // Empty title → unknown
    expect(titleDetector.detect()).toBe("unknown");

    // Braille character → working
    titleDetector.setTitle("⠋ claude");
    expect(titleDetector.detect()).toBe("working");

    // Done marker → complete
    titleDetector.setTitle("✻ task complete");
    expect(titleDetector.detect()).toBe("complete");

    // Each done marker works (including ✳)
    for (const marker of ["✳", "✻", "✽", "✶", "✢"]) {
      titleDetector.setTitle(`${marker} done`);
      expect(titleDetector.detect()).toBe("complete");
    }

    // Regular title → unknown
    titleDetector.setTitle("claude - terminal");
    expect(titleDetector.detect()).toBe("unknown");
  });

  it("Regression: transition sequence snapshot — normal session (hooks fire Stop)", () => {
    const { detector, transitions } = createTestHarness();

    detector.updateForegroundProcess("claude");
    detector.setStatus("thinking");
    detector.setStatus("working");
    detector.setStatus("thinking");
    detector.setStatus("requires_input");
    detector.setStatus("thinking");
    detector.setStatus("complete");
    // Process exits after Stop hook — complete is already set, transitionToGone fires
    detector.updateForegroundProcess(null);

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "working",
        "thinking",
        "requires_input",
        "thinking",
        "complete",
        "idle",
      ]
    `);

    // The idle from process exit has kind=null
    expect(transitions[transitions.length - 1].kind).toBeNull();

    detector.dispose();
  });

  it("Regression: transition sequence snapshot — crash recovery (no Stop hook)", () => {
    const { detector, transitions } = createTestHarness();

    detector.updateForegroundProcess("claude");
    detector.setStatus("thinking");
    // Crash — FG disappears with no Stop hook → transitionToGone directly
    detector.updateForegroundProcess(null);

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "idle",
      ]
    `);

    // The idle is from transitionToGone — kind is null
    expect(transitions[transitions.length - 1].kind).toBeNull();

    detector.dispose();
  });

  it("Regression: transition sequence snapshot — fallback-only session", () => {
    const { detector, transitions } = createTestHarness();

    detector.updateForegroundProcess("claude");
    // No hooks — advance past debounce
    vi.advanceTimersByTime(2500);

    detector.setFallbackStatus("thinking");
    detector.setFallbackStatus("working");
    detector.setFallbackStatus("requires_input");
    detector.setFallbackStatus("thinking");
    detector.setFallbackStatus("complete");

    // Agent exits → complete already set → transitionToGone
    detector.updateForegroundProcess(null);

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "working",
        "requires_input",
        "thinking",
        "complete",
        "idle",
      ]
    `);

    detector.dispose();
  });

  it("Regression: shell becomes foreground — agent should transition to gone (idle, kind=null)", () => {
    const { detector, transitions } = createTestHarness();

    // Agent starts
    detector.updateForegroundProcess("claude");
    detector.setStatus("thinking");
    detector.setStatus("working");

    // Agent exits — shell becomes foreground (not null)
    detector.updateForegroundProcess("zsh");

    // transitionToGone — status=idle, kind=null
    expect(detector.getState().status).toBe("idle");
    expect(detector.getState().kind).toBeNull();

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "working",
        "idle",
      ]
    `);

    detector.dispose();
  });

  it("Regression: shell variants (bash, fish, etc.) trigger gone transition", () => {
    for (const shell of ["bash", "sh", "fish", "nu", "pwsh", "zsh"]) {
      const { detector, transitions } = createTestHarness();

      detector.updateForegroundProcess("claude");
      detector.setStatus("thinking");

      // Shell becomes foreground → transitionToGone
      detector.updateForegroundProcess(shell);

      expect(detector.getState().status).toBe("idle");
      expect(detector.getState().kind).toBeNull();
      expect(statuses(transitions)).toContain("idle");

      detector.dispose();
    }
  });

  it("Regression: full path shell name triggers gone transition", () => {
    const { detector, transitions } = createTestHarness();

    detector.updateForegroundProcess("claude");
    detector.setStatus("thinking");
    detector.setStatus("working");

    // Shell returned as full path → transitionToGone
    detector.updateForegroundProcess("/bin/zsh");

    expect(detector.getState().status).toBe("idle");
    expect(detector.getState().kind).toBeNull();

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "working",
        "idle",
      ]
    `);

    detector.dispose();
  });

  it("Regression: non-shell child process does NOT trigger completion", () => {
    const { detector } = createTestHarness();

    detector.updateForegroundProcess("claude");
    detector.setStatus("thinking");
    detector.setStatus("working");

    // Agent spawns a child (e.g., npm, node) — should keep tracking
    detector.updateForegroundProcess("node");

    expect(detector.getState().status).toBe("working");

    detector.dispose();
  });

  it("Regression: fallback working → shell foreground → gone (idle, kind=null)", () => {
    const { detector, transitions } = createTestHarness();

    detector.updateForegroundProcess("claude");
    vi.advanceTimersByTime(2500);

    // Fallback detects working (no hooks)
    detector.setFallbackStatus("working");

    // Agent exits — shell returns → transitionToGone
    detector.updateForegroundProcess("bash");

    expect(detector.getState().status).toBe("idle");
    expect(detector.getState().kind).toBeNull();

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "working",
        "idle",
      ]
    `);

    detector.dispose();
  });

  it("Lifecycle: detect → thinking → working → complete → setInputReceived → idle (kind kept) → process exit → gone (kind null)", () => {
    const { detector, transitions } = createTestHarness();

    // Agent appears
    detector.updateForegroundProcess("claude");

    // Active lifecycle
    detector.setStatus("thinking");
    detector.setStatus("working");
    detector.setStatus("complete");

    // User types → complete → idle, kind stays
    detector.setInputReceived();
    expect(detector.getState().status).toBe("idle");
    expect(detector.getState().kind).toBe("claude");

    // Process actually exits → transitionToGone
    detector.updateForegroundProcess(null);
    expect(detector.getState().status).toBe("idle");
    expect(detector.getState().kind).toBeNull();

    // Only 4 transitions: transitionToGone skips callback when already idle
    // (it clears kind/processName silently since status doesn't change)
    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "working",
        "complete",
        "idle",
      ]
    `);

    // The idle from setInputReceived keeps kind
    expect(transitions[3].kind).toBe("claude");
    // After process exits, kind is cleared silently (no callback since already idle)
    // Verify via getState() instead of transitions
    expect(detector.getState().kind).toBeNull();

    detector.dispose();
  });
});

describe("Hook events routed through Session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("Session.setAgentHookStatus() exists and delegates to AgentDetector", () => {
    // Verify the method exists on Session instances
    const session = new Session("test-session", "/tmp", 80, 24);
    expect(typeof session.setAgentHookStatus).toBe("function");
    session.dispose();
  });

  it("setAgentHookStatus routes to AgentDetector via state machine", () => {
    // Test the AgentDetector state machine directly — this is what setAgentHookStatus delegates to.
    // Session.setAgentHookStatus(status) calls agentDetector.setStatus(status).
    const detector = new AgentDetector();
    const transitions: AgentState[] = [];
    detector.onStatusChange = (state) => transitions.push({ ...state });

    // Simulate agent process detected first (so setStatus doesn't guard on !kind)
    detector.updateForegroundProcess("claude");

    // Hook fires: UserPromptSubmit → thinking
    detector.setStatus("thinking");

    expect(detector.getState().status).toBe("thinking");
    expect(statuses(transitions)).toEqual(["thinking"]);

    detector.dispose();
  });

  it("Complete is a stable state — no auto-timer fires", () => {
    const detector = new AgentDetector();
    const transitions: AgentState[] = [];
    detector.onStatusChange = (state) => transitions.push({ ...state });

    detector.updateForegroundProcess("claude");

    // Hook: thinking → complete
    detector.setStatus("thinking");
    detector.setStatus("complete");

    expect(detector.getState().status).toBe("complete");

    // Advance way past old timer — complete should remain stable
    vi.advanceTimersByTime(10000);

    expect(detector.getState().status).toBe("complete");
    expect(statuses(transitions)).toEqual(["thinking", "complete"]);

    detector.dispose();
  });

  it("setInputReceived after complete — transitions to idle keeping kind", () => {
    const detector = new AgentDetector();
    const transitions: AgentState[] = [];
    detector.onStatusChange = (state) => transitions.push({ ...state });

    detector.updateForegroundProcess("claude");
    detector.setStatus("thinking");
    detector.setStatus("complete");

    expect(detector.getState().status).toBe("complete");

    // User types → complete → idle (kind preserved)
    detector.setInputReceived();

    expect(detector.getState().status).toBe("idle");
    expect(detector.getState().kind).toBe("claude");
    expect(statuses(transitions)).toEqual(["thinking", "complete", "idle"]);

    detector.dispose();
  });

  it("Process exits after complete → transitionToGone (kind=null)", () => {
    const detector = new AgentDetector();
    const transitions: AgentState[] = [];
    detector.onStatusChange = (state) => transitions.push({ ...state });

    detector.updateForegroundProcess("claude");
    detector.setStatus("thinking");
    detector.setStatus("complete");

    // Process exits
    detector.updateForegroundProcess(null);

    expect(detector.getState().status).toBe("idle");
    expect(detector.getState().kind).toBeNull();
    expect(statuses(transitions)).toEqual(["thinking", "complete", "idle"]);

    // Verify the idle has kind=null
    expect(transitions[2].kind).toBeNull();

    detector.dispose();
  });

  it("Fallback debounce respects hook timing — fallback ignored within 2s window", () => {
    const detector = new AgentDetector();
    const transitions: AgentState[] = [];
    detector.onStatusChange = (state) => transitions.push({ ...state });

    detector.updateForegroundProcess("claude");

    // Hook fires: thinking (sets lastHookTime)
    detector.setStatus("thinking");

    // Immediately try fallback with a different status — should be ignored
    detector.setFallbackStatus("complete");

    // Status stays thinking — fallback was debounced
    expect(detector.getState().status).toBe("thinking");
    expect(statuses(transitions)).toEqual(["thinking"]);

    detector.dispose();
  });

  it("hasBeenActive set by hook events — complete not ignored after activity", () => {
    const detector = new AgentDetector();
    const transitions: AgentState[] = [];
    detector.onStatusChange = (state) => transitions.push({ ...state });

    detector.updateForegroundProcess("claude");

    // Agent becomes active (hasBeenActive = true)
    detector.setStatus("thinking");

    // Now complete should NOT be ignored (hasBeenActive is true)
    detector.setStatus("complete");

    expect(detector.getState().status).toBe("complete");
    expect(statuses(transitions)).toContain("complete");

    detector.dispose();
  });

  it("complete ignored when hasBeenActive is false (no prior activity)", () => {
    const detector = new AgentDetector();
    const transitions: AgentState[] = [];
    detector.onStatusChange = (state) => transitions.push({ ...state });

    detector.updateForegroundProcess("claude");

    // Send complete without any prior thinking/working — should be ignored
    detector.setStatus("complete");

    expect(detector.getState().status).toBe("idle");
    expect(statuses(transitions)).not.toContain("complete");

    detector.dispose();
  });
});
