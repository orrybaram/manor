import { describe, it, expect, beforeEach } from "vitest";
import { TitleDetector, OscTitleParser } from "../title-detector";

describe("TitleDetector", () => {
  let detector: TitleDetector;

  beforeEach(() => {
    detector = new TitleDetector();
  });

  describe("braille character detection", () => {
    it("detects braille chars → working", () => {
      detector.setTitle("Claude \u2840 processing");
      expect(detector.detect()).toBe("working");
    });

    it("detects various braille chars", () => {
      detector.setTitle("\u2801");
      expect(detector.detect()).toBe("working");
    });

    it("detects braille in mixed content", () => {
      detector.setTitle("file.ts - \u28FF Claude Code");
      expect(detector.detect()).toBe("working");
    });
  });

  describe("done marker detection", () => {
    it("detects ✳ → complete", () => {
      detector.setTitle("✳ Claude Code");
      expect(detector.detect()).toBe("complete");
    });

    it("detects ✻ → complete", () => {
      detector.setTitle("✻ Done");
      expect(detector.detect()).toBe("complete");
    });

    it("detects ✽ → complete", () => {
      detector.setTitle("✽ Finished");
      expect(detector.detect()).toBe("complete");
    });

    it("detects ✶ → complete", () => {
      detector.setTitle("✶ Ready");
      expect(detector.detect()).toBe("complete");
    });

    it("detects ✢ → complete", () => {
      detector.setTitle("✢ Complete");
      expect(detector.detect()).toBe("complete");
    });
  });

  describe("normal titles", () => {
    it("returns unknown for empty title", () => {
      expect(detector.detect()).toBe("unknown");
    });

    it("returns unknown for normal title", () => {
      detector.setTitle("Claude Code");
      expect(detector.detect()).toBe("unknown");
    });

    it("returns unknown for file path title", () => {
      detector.setTitle("/Users/me/project - zsh");
      expect(detector.detect()).toBe("unknown");
    });
  });

  describe("mixed content", () => {
    it("braille takes precedence in title with text", () => {
      detector.setTitle("Working on \u2840 something");
      expect(detector.detect()).toBe("working");
    });
  });
});

describe("OscTitleParser", () => {
  let parser: OscTitleParser;

  beforeEach(() => {
    parser = new OscTitleParser();
  });

  it("parses OSC 0 title (BEL terminated)", () => {
    const data = "\x1b]0;My Title\x07";
    const titles = parser.parse(data);
    expect(titles).toEqual(["My Title"]);
  });

  it("parses OSC 2 title (BEL terminated)", () => {
    const data = "\x1b]2;Window Title\x07";
    const titles = parser.parse(data);
    expect(titles).toEqual(["Window Title"]);
  });

  it("parses OSC 0 title (ESC terminated)", () => {
    const data = "\x1b]0;My Title\x1b";
    const titles = parser.parse(data);
    expect(titles).toEqual(["My Title"]);
  });

  it("parses multiple titles in one data chunk", () => {
    const data = "\x1b]0;First\x07some output\x1b]2;Second\x07";
    const titles = parser.parse(data);
    expect(titles).toEqual(["First", "Second"]);
  });

  it("handles titles with braille characters", () => {
    const data = "\x1b]0;\u2840 Working\x07";
    const titles = parser.parse(data);
    expect(titles).toEqual(["\u2840 Working"]);
  });

  it("handles titles with done markers", () => {
    const data = "\x1b]0;✳ Done\x07";
    const titles = parser.parse(data);
    expect(titles).toEqual(["✳ Done"]);
  });

  it("ignores non-title OSC sequences", () => {
    // OSC 7 (CWD) should not be captured
    const data = "\x1b]7;file:///Users/test\x07";
    const titles = parser.parse(data);
    expect(titles).toEqual([]);
  });

  it("handles split data across calls", () => {
    const titles1 = parser.parse("\x1b]0;");
    expect(titles1).toEqual([]);
    const titles2 = parser.parse("Split Title\x07");
    expect(titles2).toEqual(["Split Title"]);
  });

  it("returns empty for plain text", () => {
    const titles = parser.parse("hello world");
    expect(titles).toEqual([]);
  });
});
