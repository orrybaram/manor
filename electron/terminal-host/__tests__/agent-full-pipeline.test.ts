import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentDetector } from "../agent-detector";
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
    titleDetector.setTitle("✳ claude done");
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

    // 4. PID sweep detects dead process → idle
    detector.sweepStalePids();

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "idle",
      ]
    `);

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
    titleDetector.setTitle("✳ task complete");
    expect(titleDetector.detect()).toBe("complete");

    // Each done marker works
    for (const marker of ["✳", "✻", "✽", "✶", "✢"]) {
      titleDetector.setTitle(`${marker} done`);
      expect(titleDetector.detect()).toBe("complete");
    }

    // Regular title → unknown
    titleDetector.setTitle("claude - terminal");
    expect(titleDetector.detect()).toBe("unknown");
  });

  it("Regression: transition sequence snapshot — normal session with fallback", () => {
    const { detector, transitions } = createTestHarness();

    detector.updateForegroundProcess("claude");
    detector.setStatus("thinking");
    detector.setStatus("working");
    detector.setStatus("thinking");
    detector.setStatus("requires_input");
    detector.setStatus("thinking");
    detector.setStatus("complete");
    detector.updateForegroundProcess(null);
    vi.advanceTimersByTime(3000);

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

    detector.dispose();
  });

  it("Regression: transition sequence snapshot — crash recovery", () => {
    const { detector, transitions } = createTestHarness();

    detector.updateForegroundProcess("claude");
    detector.setStatus("thinking");
    // Crash — FG disappears with no Stop hook
    detector.updateForegroundProcess(null);
    vi.advanceTimersByTime(3000);

    expect(statuses(transitions)).toMatchInlineSnapshot(`
      [
        "thinking",
        "complete",
        "idle",
      ]
    `);

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

    // Agent exits
    detector.updateForegroundProcess(null);
    vi.advanceTimersByTime(3000);

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
});
