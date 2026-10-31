import { describe, expect, it } from "vitest";
import { resolveEditorFont } from "../useEditorFont";

describe("resolveEditorFont", () => {
  it("is the system monospace at 12px by default", () => {
    expect(resolveEditorFont("", 12)).toEqual({ family: "var(--font-mono)", size: 12 });
  });

  it("puts the chosen family in front of the system monospace", () => {
    expect(resolveEditorFont("Fira Code", 14)).toEqual({
      family: `"Fira Code", var(--font-mono)`,
      size: 14,
    });
  });

  it("holds the size to 8–32px", () => {
    expect(resolveEditorFont("", 1).size).toBe(8);
    expect(resolveEditorFont("", 40).size).toBe(32);
  });
});
