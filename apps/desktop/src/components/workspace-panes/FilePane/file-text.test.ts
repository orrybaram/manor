import { describe, expect, it } from "vitest";
import { joinBom, lineSeparatorOf, splitBom } from "./file-text";

describe("splitBom / joinBom", () => {
  it("round-trips a leading BOM unchanged", () => {
    const content = "﻿const a = 1;\n";
    const { bom, text } = splitBom(content);
    expect(bom).toBe(true);
    expect(text).toBe("const a = 1;\n");
    expect(joinBom(bom, text)).toBe(content);
  });

  it("leaves a file without one alone", () => {
    expect(splitBom("x")).toEqual({ bom: false, text: "x" });
    expect(joinBom(false, "x")).toBe("x");
  });
});

describe("lineSeparatorOf", () => {
  it("keeps CRLF for a CRLF file and the default otherwise", () => {
    expect(lineSeparatorOf("a\r\nb\r\n")).toBe("\r\n");
    expect(lineSeparatorOf("a\nb\n")).toBeNull();
  });
});
