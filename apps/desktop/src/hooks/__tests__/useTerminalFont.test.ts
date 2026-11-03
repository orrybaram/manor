import { describe, expect, it } from "vitest";
import { resolveTerminalFont } from "../useTerminalFont";
import { FONT_FAMILY } from "../../terminal/config";

describe("resolveTerminalFont", () => {
  it("draws with the bundled font at 13px by default", () => {
    expect(resolveTerminalFont("", 13, false)).toEqual({
      family: FONT_FAMILY,
      size: 13,
    });
  });

  it("puts the chosen family in front of the bundled stack", () => {
    const font = resolveTerminalFont("JetBrains Mono", 15, false);
    expect(font.family).toBe(`"JetBrains Mono", ${FONT_FAMILY}`);
    expect(font.size).toBe(15);
  });

  it("holds the size to 8–32px", () => {
    expect(resolveTerminalFont("", 2, false).size).toBe(8);
    expect(resolveTerminalFont("", 99, false).size).toBe(32);
    expect(resolveTerminalFont("", "big", false).size).toBe(13);
  });

  it("ignores the desktop's choice in a phone or browser tab", () => {
    expect(resolveTerminalFont("JetBrains Mono", 20, true)).toEqual({
      family: FONT_FAMILY,
      size: 13,
    });
  });
});
