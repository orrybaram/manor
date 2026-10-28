import { describe, expect, it } from "vitest";
import { autoCollapseReason, collapsedFiles } from "../auto-collapse";
import type { DiffFile } from "../types";

function file(path: string, added: number, removed = 0): DiffFile {
  return { path, lines: [], added, removed };
}

describe("autoCollapseReason", () => {
  it("collapses lockfiles and generated bundles whatever their size", () => {
    expect(autoCollapseReason(file("pnpm-lock.yaml", 3))).toBe("generated");
    expect(autoCollapseReason(file("apps/web/package-lock.json", 3))).toBe(
      "generated",
    );
    expect(autoCollapseReason(file("Cargo.lock", 1))).toBe("generated");
    expect(autoCollapseReason(file("dist/app.min.js", 1))).toBe("generated");
    expect(autoCollapseReason(file("dist/app.js.map", 1))).toBe("generated");
  });

  it("collapses a hand-written file past 1,000 changed lines", () => {
    expect(autoCollapseReason(file("src/big.ts", 1400, 100))).toBe("large");
    expect(autoCollapseReason(file("src/edge.ts", 600, 400))).toBeNull();
  });

  it("leaves an ordinary file open", () => {
    expect(autoCollapseReason(file("src/app.ts", 300, 20))).toBeNull();
    // A name that only contains a lockfile's name is not one.
    expect(autoCollapseReason(file("docs/yarn.lock.md", 5))).toBeNull();
  });
});

describe("collapsedFiles", () => {
  const files = [
    file("pnpm-lock.yaml", 40),
    file("src/big.ts", 1500),
    file("src/app.ts", 30),
  ];

  it("applies the defaults where the user has made no choice", () => {
    expect(collapsedFiles(files, new Map(), new Map())).toEqual(
      new Set(["pnpm-lock.yaml", "src/big.ts"]),
    );
  });

  it("keeps the user's choice either way", () => {
    const choices = new Map([
      ["src/big.ts", false],
      ["src/app.ts", true],
    ]);
    expect(collapsedFiles(files, choices, new Map())).toEqual(
      new Set(["pnpm-lock.yaml", "src/app.ts"]),
    );
  });

  it("keeps the default a file got when first seen as it grows or shrinks", () => {
    const defaults = new Map<string, boolean>();
    collapsedFiles([file("src/growing.ts", 990)], new Map(), defaults);
    expect(
      collapsedFiles([file("src/growing.ts", 1010)], new Map(), defaults),
    ).toEqual(new Set());

    collapsedFiles([file("src/shrinking.ts", 1200)], new Map(), defaults);
    expect(
      collapsedFiles([file("src/shrinking.ts", 50)], new Map(), defaults),
    ).toEqual(new Set(["src/shrinking.ts"]));
  });
});
