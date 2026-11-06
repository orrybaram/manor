import { describe, expect, it } from "vitest";
import { HeldOutputScanner, MAX_CARRY } from "../held-output-scan";

function scanAll(chunks: string[]) {
  const scanner = new HeldOutputScanner();
  let query = false;
  let title: string | null = null;
  for (const chunk of chunks) {
    const r = scanner.scan(chunk);
    query ||= r.query;
    if (r.title !== null) title = r.title;
  }
  return { query, title };
}

const q = (s: string) => scanAll([s]).query;

describe("HeldOutputScanner queries", () => {
  // What Claude Code and Neovim actually sent at startup, captured with
  // `script` on 2026-11-06.
  it.each([
    ["DA1", "\x1b[c"],
    ["DA2", "\x1b[>c"],
    ["DSR status", "\x1b[5n"],
    ["DSR cursor", "\x1b[6n"],
    ["DECXCPR", "\x1b[?6n"],
    ["colour scheme", "\x1b[?996n"],
    ["background colour", "\x1b]11;?\x07"],
    ["foreground colour, ST", "\x1b]10;?\x1b\\"],
    ["palette entry", "\x1b]4;1;?\x07"],
    ["Claude Code's own OSC", "\x1b]7501;?\x07"],
    ["kitty keyboard query", "\x1b[?u"],
    ["kitty keyboard push", "\x1b[>1u"],
    ["kitty keyboard pop", "\x1b[<u"],
    ["XTVERSION", "\x1b[>0q"],
    ["DECRQM private", "\x1b[?2026$p"],
    ["DECRQM ANSI", "\x1b[4$p"],
    ["DECRQSS", "\x1bP$qm\x1b\\"],
    ["XTGETTCAP", "\x1bP+q544e\x1b\\"],
    ["window size report", "\x1b[18t"],
    ["cell size report", "\x1b[16t"],
    ["DECID", "\x1bZ"],
  ])("%s", (_name, seq) => {
    expect(q(`before ${seq} after`)).toBe(true);
  });

  it.each([
    ["SGR colours", "\x1b[38;5;246mhi\x1b[0m\x1b[48;2;1;2;3m"],
    ["cursor moves", "\x1b[2G\x1b[H\x1b[23B\x1b[K\x1b[J"],
    ["cursor style", "\x1b[2 q\x1b[1 q"],
    ["restore cursor", "\x1b[u\x1b[s"],
    ["modes", "\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[?1004h"],
    ["title push/pop", "\x1b[22;0;0t\x1b[23;0;0t"],
    ["resize request", "\x1b[8;24;80t"],
    ["modifyOtherKeys", "\x1b[>4;0m"],
    ["title with a question mark", "\x1b]0;What next?\x07"],
    ["hyperlink", "\x1b]8;;https://x.test/?a=1\x1b\\link\x1b]8;;\x1b\\"],
    ["cwd", "\x1b]7;file:///home/a\x07"],
    ["prompt marks", "\x1b]133;A\x07\x1b]133;B\x07"],
    ["sixel", "\x1bP0;1;0q#0;2;0;0;0~~\x1b\\"],
    ["charset", "\x1b(B"],
    ["plain text", "y\ny\ny\n✓ tool_result src/x.ts:1 warning"],
  ])("not %s", (_name, seq) => {
    expect(q(seq)).toBe(false);
  });

  it("finds a query split across chunks at every point", () => {
    const seq = "\x1b]11;?\x07";
    for (let cut = 1; cut < seq.length; cut++) {
      expect(scanAll([`a${seq.slice(0, cut)}`, `${seq.slice(cut)}b`]).query).toBe(true);
    }
    const csi = "\x1b[?2026$p";
    for (let cut = 1; cut < csi.length; cut++) {
      expect(scanAll([csi.slice(0, cut), csi.slice(cut)]).query).toBe(true);
    }
  });

  it("reports a query in the chunk that completes it", () => {
    const scanner = new HeldOutputScanner();
    expect(scanner.scan("x\x1b[").query).toBe(false);
    expect(scanner.scan("6n").query).toBe(true);
    expect(scanner.scan("more").query).toBe(false);
  });

  it("drops an unfinished sequence past the carry limit", () => {
    const scanner = new HeldOutputScanner();
    scanner.scan(`\x1b]52;c;${"A".repeat(MAX_CARRY + 10)}`);
    // Whatever follows is read fresh, not as the end of the dropped string.
    expect(scanner.scan("\x07\x1b[c").query).toBe(true);
  });

  it("forgets the carry on reset", () => {
    const scanner = new HeldOutputScanner();
    scanner.scan("\x1b[");
    scanner.reset();
    expect(scanner.scan("6n").query).toBe(false);
  });
});

describe("HeldOutputScanner titles", () => {
  it("reads OSC 0 and OSC 2, keeping the last", () => {
    expect(scanAll(["\x1b]0;one\x07 text \x1b]2;two\x1b\\"]).title).toBe("two");
  });

  it("ignores the icon name and other OSCs", () => {
    expect(scanAll(["\x1b]1;icon\x07\x1b]7;file:///x\x07"]).title).toBeNull();
  });

  it("reads a title split across chunks", () => {
    expect(scanAll(["\x1b]0;✳ Fix", "ing tests", "\x07"]).title).toBe("✳ Fixing tests");
  });

  it("drops a title another sequence aborts", () => {
    expect(scanAll(["\x1b]0;half\x1b[0m"]).title).toBeNull();
  });

  it("reads an empty title", () => {
    expect(scanAll(["\x1b]2;\x07"]).title).toBe("");
  });

  it("is not a query", () => {
    expect(scanAll(["\x1b]0;Ready?\x07"]).query).toBe(false);
  });
});
