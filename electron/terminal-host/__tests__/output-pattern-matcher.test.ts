import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  afterEach,
  type Mock,
} from "vitest";
import { OutputPatternMatcher, stripAnsi } from "../output-pattern-matcher";
import { AgentDetector } from "../agent-detector";

describe("OutputPatternMatcher", () => {
  let matcher: OutputPatternMatcher;

  beforeEach(() => {
    matcher = new OutputPatternMatcher();
  });

  describe("busy patterns", () => {
    it("detects 'ctrl+c to interrupt'", () => {
      matcher.addData("ctrl+c to interrupt");
      expect(matcher.detect()).toBe("thinking");
    });

    it("detects 'esc to interrupt'", () => {
      matcher.addData("esc to interrupt");
      expect(matcher.detect()).toBe("thinking");
    });

    it("detects braille spinner characters", () => {
      // U+2840 is a braille character
      matcher.addData("Loading \u2840 please wait");
      expect(matcher.detect()).toBe("thinking");
    });

    it("detects whimsical action words pattern", () => {
      matcher.addData("✢ Cerebrating... (53s, 749 tokens)");
      expect(matcher.detect()).toBe("thinking");
    });

    it("detects whimsical pattern with different words", () => {
      matcher.addData("Pondering... 120 tokens used");
      expect(matcher.detect()).toBe("thinking");
    });
  });

  describe("requires_input patterns", () => {
    it("detects 'Yes, allow once'", () => {
      matcher.addData("Yes, allow once");
      expect(matcher.detect()).toBe("requires_input");
    });

    it("detects 'No, and tell Claude what to do differently'", () => {
      matcher.addData("No, and tell Claude what to do differently");
      expect(matcher.detect()).toBe("requires_input");
    });

    it("detects 'Do you trust the files in this folder?'", () => {
      matcher.addData("Do you trust the files in this folder?");
      expect(matcher.detect()).toBe("requires_input");
    });

    it("detects '(Y/n)' prompt", () => {
      matcher.addData("Proceed with changes? (Y/n)");
      expect(matcher.detect()).toBe("requires_input");
    });

    it("detects 'Continue?' prompt", () => {
      matcher.addData("Continue?");
      expect(matcher.detect()).toBe("requires_input");
    });

    it("detects 'Approve this plan?'", () => {
      matcher.addData("Approve this plan?");
      expect(matcher.detect()).toBe("requires_input");
    });
  });

  describe("idle patterns", () => {
    it("detects ❯ prompt", () => {
      matcher.addData("❯");
      expect(matcher.detect()).toBe("idle");
    });

    it("detects > prompt", () => {
      matcher.addData(">");
      expect(matcher.detect()).toBe("idle");
    });

    it("detects prompt with surrounding whitespace", () => {
      matcher.addData("  ❯  ");
      expect(matcher.detect()).toBe("idle");
    });
  });

  describe("box-drawing filtering", () => {
    it("skips lines starting with box-drawing characters", () => {
      matcher.addData("│ ctrl+c to interrupt");
      // The box-drawing line is skipped, so buffer is empty
      expect(matcher.detect()).toBe(null);
    });

    it("skips lines starting with ├", () => {
      matcher.addData("├── some content");
      expect(matcher.detect()).toBe(null);
    });

    it("skips lines starting with └", () => {
      matcher.addData("└── end");
      expect(matcher.detect()).toBe(null);
    });

    it("skips lines starting with ─", () => {
      matcher.addData("──────────");
      expect(matcher.detect()).toBe(null);
    });
  });

  describe("ANSI stripping", () => {
    it("strips ANSI codes before matching", () => {
      matcher.addData("\x1b[32mctrl+c to interrupt\x1b[0m");
      expect(matcher.detect()).toBe("thinking");
    });

    it("strips complex ANSI sequences", () => {
      matcher.addData("\x1b[1;34m❯\x1b[0m");
      expect(matcher.detect()).toBe("idle");
    });
  });

  describe("false positive avoidance", () => {
    it("returns null for normal shell output", () => {
      matcher.addData("ls -la");
      expect(matcher.detect()).toBe(null);
    });

    it("returns null for file listing output", () => {
      matcher.addData("total 42");
      matcher.addData("drwxr-xr-x  5 user staff  160 Jan  1 00:00 .");
      expect(matcher.detect()).toBe(null);
    });

    it("returns null for Claude welcome banner", () => {
      matcher.addData("Welcome to Claude Code!");
      matcher.addData("Type your request below.");
      expect(matcher.detect()).toBe(null);
    });
  });

  describe("ring buffer", () => {
    it("maintains max 15 lines", () => {
      for (let i = 0; i < 20; i++) {
        matcher.addData(`line ${i}`);
      }
      expect(matcher.getBuffer().length).toBe(15);
    });
  });
});

describe("stripAnsi", () => {
  it("removes color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("removes cursor movement", () => {
    expect(stripAnsi("\x1b[2Ahello")).toBe("hello");
  });

  it("passes through plain text", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });
});

describe("AgentDetector fallback debounce", () => {
  let detector: AgentDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new AgentDetector();
    // Set up as if an agent is tracked
    detector.updateForegroundProcess("claude");
  });

  afterEach(() => {
    detector.dispose();
    vi.useRealTimers();
  });

  it("fallback status does not override recent hook status", () => {
    const changes: string[] = [];
    detector.onStatusChange = (state) => changes.push(state.status);

    // Hook fires, sets to thinking
    detector.setStatus("thinking");
    expect(changes).toEqual(["thinking"]);

    // Immediately try fallback — should be ignored (within 2s)
    detector.setFallbackStatus("idle");
    expect(changes).toEqual(["thinking"]);
  });

  it("fallback status applies after debounce period", () => {
    const changes: string[] = [];
    detector.onStatusChange = (state) => changes.push(state.status);

    // Hook fires, sets to thinking
    detector.setStatus("thinking");
    expect(changes).toEqual(["thinking"]);

    // Advance past debounce window
    vi.advanceTimersByTime(2100);

    // Now fallback should apply
    detector.setFallbackStatus("requires_input");
    expect(changes).toEqual(["thinking", "requires_input"]);
  });

  it("fallback status is ignored when no agent is tracked", () => {
    // Reset to no agent
    detector.updateForegroundProcess(null);
    const changes: string[] = [];
    detector.onStatusChange = (state) => changes.push(state.status);

    detector.setFallbackStatus("thinking");
    expect(changes).toEqual([]);
  });
});

describe("AgentDetector sweepStalePids", () => {
  let detector: AgentDetector;
  let originalKill: typeof process.kill;

  beforeEach(() => {
    detector = new AgentDetector();
    originalKill = process.kill;
  });

  afterEach(() => {
    detector.dispose();
    process.kill = originalKill;
  });

  it("dead PID (ESRCH) forces idle", () => {
    const changes: string[] = [];
    detector.onStatusChange = (state) => changes.push(state.status);

    // Track an agent with a PID
    detector.updateForegroundProcess("claude", 12345);
    detector.setStatus("thinking");
    changes.length = 0;

    // Mock process.kill to throw ESRCH
    process.kill = vi
      .fn()
      .mockImplementation((_pid: number, _signal?: number) => {
        const err = new Error("No such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }) as unknown as typeof process.kill;

    detector.sweepStalePids();
    expect(changes).toContain("idle");
  });

  it("live PID (kill succeeds) causes no change", () => {
    const changes: string[] = [];
    detector.onStatusChange = (state) => changes.push(state.status);

    detector.updateForegroundProcess("claude", 12345);
    detector.setStatus("thinking");
    changes.length = 0;

    // Mock process.kill to succeed (process is alive)
    process.kill = vi
      .fn()
      .mockImplementation(() => true) as unknown as typeof process.kill;

    detector.sweepStalePids();
    expect(changes).toEqual([]);
  });

  it("no-permission PID (EPERM) causes no change", () => {
    const changes: string[] = [];
    detector.onStatusChange = (state) => changes.push(state.status);

    detector.updateForegroundProcess("claude", 12345);
    detector.setStatus("thinking");
    changes.length = 0;

    // Mock process.kill to throw EPERM
    process.kill = vi
      .fn()
      .mockImplementation((_pid: number, _signal?: number) => {
        const err = new Error(
          "Operation not permitted",
        ) as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }) as unknown as typeof process.kill;

    detector.sweepStalePids();
    expect(changes).toEqual([]);
  });

  it("sweep with no tracked agents is a no-op", () => {
    const changes: string[] = [];
    detector.onStatusChange = (state) => changes.push(state.status);

    process.kill = vi.fn() as unknown as typeof process.kill;
    detector.sweepStalePids();

    expect(changes).toEqual([]);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("multiple stale agents cleaned up in one sweep", () => {
    const changes: string[] = [];
    detector.onStatusChange = (state) => changes.push(state.status);

    // Track multiple agents with PIDs
    detector.updateForegroundProcess("claude", 11111);
    detector.setStatus("thinking");
    detector.updateForegroundProcess("claude", 22222);
    changes.length = 0;

    // Mock: all PIDs are dead
    process.kill = vi
      .fn()
      .mockImplementation((_pid: number, _signal?: number) => {
        const err = new Error("No such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }) as unknown as typeof process.kill;

    detector.sweepStalePids();
    // Should transition to idle since all tracked PIDs are dead
    expect(changes).toContain("idle");
  });
});
