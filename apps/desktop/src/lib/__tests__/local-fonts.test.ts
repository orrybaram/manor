import { describe, expect, it } from "vitest";
import { isMonospace, monospaceFamilies } from "../local-fonts";

/** Every letter 10px wide in a monospace family, `i` 4px and `W` 14px otherwise. */
const measure = (text: string, family: string) =>
  [...text].reduce(
    (w, ch) => w + (family.includes("Mono") ? 10 : ch === "i" || ch === "l" ? 4 : 14),
    0,
  );

describe("local fonts", () => {
  it("tells a monospace family from a proportional one", () => {
    expect(isMonospace(measure, "JetBrains Mono")).toBe(true);
    expect(isMonospace(measure, "Helvetica")).toBe(false);
  });

  it("lists each family once, sorted, without hidden system families", () => {
    const fonts = [
      { family: "Fira Mono" },
      { family: "Fira Mono" },
      { family: "Arial" },
      { family: ".SF NS Mono" },
      { family: "Andale Mono" },
    ];
    expect(
      monospaceFamilies(fonts, (family) => isMonospace(measure, family)),
    ).toEqual(["Andale Mono", "Fira Mono"]);
  });
});
