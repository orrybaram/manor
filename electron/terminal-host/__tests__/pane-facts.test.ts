import { describe, it, expect } from "vitest";
import {
  AGENT_COMMAND_PATTERNS,
  PaneFactsExtractor,
  agentKindForProcess,
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
    it("reports the latest OSC 0/2 title of a chunk", () => {
      const { extractor, emitted } = setup();
      extractor.feedData("\x1b]0;first\x07\x1b]2;second\x1b\\");
      expect(extractor.facts.title).toBe("second");
      expect(emitted).toHaveLength(1);
    });

    it("finds a title split across chunks", () => {
      const { extractor } = setup();
      extractor.feedData("\x1b]2;hal");
      extractor.feedData("f a title\x07");
      expect(extractor.facts.title).toBe("half a title");
    });

    it("ignores other OSC sequences", () => {
      const { extractor, emitted } = setup();
      extractor.feedData("\x1b]7;file://host/tmp\x07");
      expect(extractor.facts.title).toBeNull();
      expect(emitted).toEqual([]);
    });

    it("does not emit when the same title is set again", () => {
      const { extractor, emitted } = setup();
      extractor.feedData("\x1b]0;same\x07");
      extractor.feedData("\x1b]0;same\x07");
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
      extractor.feedData("\x1b]0;⠋ working\x07esc to interrupt\r\n");
      expect(emitted).toHaveLength(2);
      expect(emitted[1]).toEqual({
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
