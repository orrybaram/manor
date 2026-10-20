import { describe, expect, it } from "vitest";
import { flatten, stripAnsi } from "./ansi";

const ESC = "\u001b";
const BEL = "\u0007";

/**
 * The stripper every e2e spec reads a pane through.
 *
 * Its predecessor removed the *body* of a sequence and left the `ESC` behind,
 * which is worse than not stripping at all: the dump looks right and the
 * substring test fails. Two repro runs were lost to that, so the cases that
 * matter are pinned here.
 */
describe("stripAnsi", () => {
  it("takes the ESC with the sequence, not just its body", () => {
    expect(stripAnsi(`Welcome${ESC}[10Gback`)).toBe("Welcomeback");
  });

  it("strips private and non-numeric parameter bytes", () => {
    expect(stripAnsi(`${ESC}[?2026h`)).toBe("");
    expect(stripAnsi(`${ESC}[>1u`)).toBe("");
  });

  it("strips OSC hyperlinks and keeps their text", () => {
    expect(
      stripAnsi(`${ESC}]8;id=x;https://a${BEL}link${ESC}]8;;${BEL}`),
    ).toBe("link");
  });

  it("strips colour and erase sequences", () => {
    expect(stripAnsi(`${ESC}[38;2;1;2;3mred${ESC}[39m`)).toBe("red");
    expect(stripAnsi(`${ESC}[2K${ESC}[1BZQ159`)).toBe("ZQ159");
  });

  it("leaves text that merely looks like a sequence", () => {
    expect(stripAnsi("cost [3m] of rope")).toBe("cost [3m] of rope");
  });
});

describe("flatten", () => {
  it("joins words a program positioned with cursor moves", () => {
    expect(flatten(`Welcome${ESC}[10Gback  Orry!`)).toBe("WelcomebackOrry!");
  });
});
