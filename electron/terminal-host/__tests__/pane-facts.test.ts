import { describe, it, expect, beforeEach } from "vitest";
import {
  AGENT_COMMAND_PATTERNS,
  OutputPatternMatcher,
  PaneFactsExtractor,
  agentKindForProcess,
  stripAnsi,
} from "../pane-facts";
import type { PaneFacts } from "../types";

/** An extractor with a controllable clock and a record of every emission. */
function setup() {
  let clock = 1000;
  const emitted: PaneFacts[] = [];
  const extractor = new PaneFactsExtractor({
    now: () => clock,
    onChange: (facts) => emitted.push(facts),
  });
  return {
    extractor,
    emitted,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("agentKindForProcess (ADR-184)", () => {
  it("maps every known agent CLI, including pi", () => {
    expect(agentKindForProcess("claude")).toBe("claude");
    expect(agentKindForProcess("codex")).toBe("codex");
    expect(agentKindForProcess("opencode")).toBe("opencode");
    expect(agentKindForProcess("pi")).toBe("pi");
  });

  it("uses the basename, case-insensitively", () => {
    expect(agentKindForProcess("/usr/local/bin/Claude")).toBe("claude");
  });

  it("returns null for anything else", () => {
    expect(agentKindForProcess("vim")).toBeNull();
    expect(agentKindForProcess("node")).toBeNull();
    expect(agentKindForProcess("pip")).toBeNull();
  });

  it("finds agents in command lines, including pi", () => {
    const kindOf = (line: string) =>
      AGENT_COMMAND_PATTERNS.find(([re]) => re.test(line))?.[1] ?? null;
    expect(kindOf("node /opt/node_modules/@anthropic-ai/claude-code/cli.mjs")).toBe("claude");
    expect(kindOf("node /usr/local/bin/pi")).toBe("pi");
    expect(kindOf("node /srv/api/server.js")).toBeNull();
  });
});

describe("PaneFactsExtractor (ADR-184)", () => {
  it("starts empty and emits nothing", () => {
    const { extractor, emitted } = setup();
    expect(extractor.facts).toEqual({ foreground: null, title: null, outputHint: null });
    expect(emitted).toEqual([]);
  });

  describe("titles", () => {
    it("reports the title the terminal set", () => {
      const { extractor, emitted } = setup();
      extractor.setTitle("first");
      extractor.setTitle("second");
      expect(extractor.facts.title).toBe("second");
      expect(emitted.map((f) => f.title)).toEqual(["first", "second"]);
    });

    it("does not read titles out of output bytes", () => {
      const { extractor, emitted } = setup();
      extractor.feedData("\x1b]2;not parsed here\x07");
      expect(extractor.facts.title).toBeNull();
      expect(emitted).toEqual([]);
    });

    it("does not emit when the same title is set again", () => {
      const { extractor, emitted } = setup();
      extractor.setTitle("same");
      extractor.setTitle("same");
      expect(emitted).toHaveLength(1);
    });
  });

  describe("output hints", () => {
    it("reports hints as raw facts with a timestamp", () => {
      const { extractor, emitted, advance } = setup();
      advance(5);
      extractor.feedData("✢ Cerebrating... (53s, 749 tokens)\r\n");
      expect(extractor.facts.outputHint).toEqual({ hint: "thinking", at: 1005 });
      expect(emitted).toHaveLength(1);
    });

    it("reports an idle prompt", () => {
      const { extractor } = setup();
      extractor.feedData("some output\r\n❯\r\n");
      expect(extractor.facts.outputHint?.hint).toBe("idle");
    });

    it("does not emit for a repeat of the same hint", () => {
      const { extractor, emitted, advance } = setup();
      extractor.feedData("esc to interrupt\r\n");
      advance(10);
      extractor.feedData("esc to interrupt\r\n");
      expect(emitted).toHaveLength(1);
      expect(extractor.facts.outputHint?.at).toBe(1000);
    });

    it("stamps a new `at` for each new hint, strictly increasing", () => {
      const { extractor, emitted } = setup(); // clock never moves
      extractor.feedData("Proceed? (y/n)\r\n");
      extractor.feedData("esc to interrupt\r\n");
      extractor.feedData("Proceed? (y/n)\r\n");
      const ats = emitted.map((f) => f.outputHint!.at);
      expect(ats).toEqual([1000, 1001, 1002]);
    });

    it("treats every fresh prompt as a new requires_input hint", () => {
      const { extractor, emitted } = setup();
      extractor.feedData("Do you want to proceed? (y/n)\r\n");
      extractor.feedData("Overwrite file? (y/n)\r\n");
      expect(emitted.map((f) => f.outputHint?.hint)).toEqual([
        "requires_input",
        "requires_input",
      ]);
      expect(emitted[1].outputHint!.at).toBeGreaterThan(emitted[0].outputHint!.at);
    });

    it("does not re-report an answered prompt still in the buffer", () => {
      const { extractor, emitted } = setup();
      extractor.feedData("Yes, allow once\r\n");
      extractor.feedData("plain output\r\n");
      expect(emitted).toHaveLength(1);
    });

    it("keeps the last hint through chunks that show none", () => {
      const { extractor, emitted } = setup();
      extractor.feedData("esc to interrupt\r\n");
      for (let i = 0; i < 20; i++) extractor.feedData(`line ${i}\r\n`);
      expect(extractor.facts.outputHint?.hint).toBe("thinking");
      expect(emitted).toHaveLength(1);
    });
  });

  describe("foreground process", () => {
    it("maps the name to an Agent kind", () => {
      const { extractor, emitted } = setup();
      extractor.setForeground("pi");
      expect(extractor.facts.foreground).toEqual({ name: "pi", kind: "pi" });
      extractor.setForeground("vim");
      expect(extractor.facts.foreground).toEqual({ name: "vim", kind: null });
      expect(emitted).toHaveLength(2);
    });

    it("emits when the shell is back in the foreground", () => {
      const { extractor, emitted } = setup();
      extractor.setForeground("claude");
      extractor.setForeground(null);
      expect(emitted.map((f) => f.foreground)).toEqual([
        { name: "claude", kind: "claude" },
        null,
      ]);
    });

    it("does not emit when the foreground is unchanged", () => {
      const { extractor, emitted } = setup();
      extractor.setForeground(null);
      extractor.setForeground("claude");
      extractor.setForeground("claude");
      expect(emitted).toHaveLength(1);
    });

    it("makes the next hint new after a foreground change, even if it repeats", () => {
      const { extractor, emitted, advance } = setup();
      extractor.setForeground("claude");
      extractor.feedData("esc to interrupt\r\n");
      extractor.setForeground(null);
      extractor.setForeground("claude");
      advance(50);
      extractor.feedData("esc to interrupt\r\n");
      expect(emitted).toHaveLength(5);
      expect(extractor.facts.outputHint).toEqual({ hint: "thinking", at: 1050 });
    });
  });

  describe("snapshots", () => {
    it("emits the whole snapshot each time", () => {
      const { extractor, emitted } = setup();
      extractor.setForeground("claude");
      extractor.setTitle("⠋ working");
      extractor.feedData("esc to interrupt\r\n");
      expect(emitted).toHaveLength(3);
      expect(emitted[2]).toEqual({
        foreground: { name: "claude", kind: "claude" },
        title: "⠋ working",
        outputHint: { hint: "thinking", at: 1000 },
      });
    });

    it("hands out copies callers cannot mutate", () => {
      const { extractor } = setup();
      extractor.setForeground("claude");
      extractor.facts.foreground!.name = "mutated";
      expect(extractor.facts.foreground!.name).toBe("claude");
    });

    it("does not emit for output with no facts in it", () => {
      const { extractor, emitted } = setup();
      extractor.feedData("hello world\r\n");
      expect(emitted).toEqual([]);
    });
  });
});

// ── OutputPatternMatcher (ported from output-pattern-matcher.test.ts, ADR-184 ticket 4) ──

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
      matcher.addData("Loading ⡀ please wait");
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

  describe("staleness (edge-triggered requires_input)", () => {
    it("does not re-report a prompt that is only retained in the buffer", () => {
      matcher.addData("❯ 1. Yes, allow once");
      expect(matcher.detect()).toBe("requires_input");

      matcher.addData("Running tool...");
      expect(matcher.detect()).not.toBe("requires_input");
    });

    it("reports a prompt again when it is re-drawn", () => {
      matcher.addData("❯ 1. Yes, allow once");
      matcher.addData("Running tool...");
      matcher.addData("❯ 1. Yes, allow once");
      expect(matcher.detect()).toBe("requires_input");
    });

    it("a chunk with no usable lines does not re-assert a retained prompt", () => {
      matcher.addData("Proceed with changes? (Y/n)");
      expect(matcher.detect()).toBe("requires_input");

      matcher.addData("\n\n");
      expect(matcher.detect()).not.toBe("requires_input");
    });

    it("still reports busy state while a stale prompt sits in the buffer", () => {
      matcher.addData("❯ 1. Yes, allow once");
      matcher.addData("✢ Sprouting... (2m 21s, 9100 tokens)");
      expect(matcher.detect()).toBe("thinking");
    });
  });

  describe("prose false positives", () => {
    it("ignores 'continue?' inside a sentence", () => {
      matcher.addData("Tell me if you want me to continue? Not a prompt here.");
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

  describe("chunk tail", () => {
    it("keeps only the last lines of a large chunk, in order", () => {
      const lines = Array.from({ length: 5000 }, (_, i) => `\x1b[32mline ${i}\x1b[0m`);
      matcher.addData(lines.join("\r\n") + "\r\n");
      const buffer = matcher.getBuffer();
      expect(buffer).toHaveLength(15);
      expect(buffer[0]).toBe("line 4985");
      expect(buffer[14]).toBe("line 4999");
    });

    it("finds a hint at the end of a large chunk", () => {
      const output = Array.from({ length: 5000 }, (_, i) => `file-${i}.txt`).join("\n");
      matcher.addData(`${output}\nDo you want to proceed? (y/n)\n`);
      expect(matcher.detect()).toBe("requires_input");
    });

    it("skips blank and box-drawing lines when filling from the tail", () => {
      matcher.addData("esc to interrupt\r\n\r\n│ boxed\r\n\r\n\r\n");
      expect(matcher.getBuffer()).toEqual(["esc to interrupt"]);
      expect(matcher.detect()).toBe("thinking");
    });

    it("splits on bare and CRLF newlines alike", () => {
      matcher.addData("one\ntwo\r\nthree");
      expect(matcher.getBuffer()).toEqual(["one", "two", "three"]);
    });

    it("handles a chunk that starts with a newline", () => {
      matcher.addData("\nesc to interrupt");
      expect(matcher.getBuffer()).toEqual(["esc to interrupt"]);
    });
  });
});

describe("stripAnsi (ADR-184 ticket 4)", () => {
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
