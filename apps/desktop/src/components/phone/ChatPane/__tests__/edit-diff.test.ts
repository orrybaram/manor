/**
 * An edit card's file name, folder, ratio bar and hunk lines.
 */
import { describe, expect, it } from "vitest";
import { diffLines, editPathParts, hunkHeader, ratioBlocks } from "../edit-diff";

describe("editPathParts", () => {
  it("splits a relative path into name and folder", () => {
    expect(editPathParts("electron/chat-mirror/stream.ts")).toEqual({
      name: "stream.ts",
      folder: "electron/chat-mirror",
    });
    expect(editPathParts("README.md")).toEqual({ name: "README.md", folder: "" });
    expect(editPathParts("/etc")).toEqual({ name: "etc", folder: "/" });
  });

  it("shows a home directory as ~ and keeps a deep folder's tail", () => {
    expect(editPathParts("/home/someone/notes/a.md")).toEqual({ name: "a.md", folder: "~/notes" });
    expect(editPathParts("/Users/someone/x.md")).toEqual({ name: "x.md", folder: "~" });
    expect(editPathParts("a/b/c/d/e/f.ts")).toEqual({ name: "f.ts", folder: "…/b/c/d/e" });
  });
});

describe("ratioBlocks", () => {
  it("splits five blocks by the add/remove ratio", () => {
    expect(ratioBlocks(3, 2)).toEqual(["add", "add", "add", "del", "del"]);
    expect(ratioBlocks(10, 0)).toEqual(["add", "add", "add", "add", "add"]);
    expect(ratioBlocks(0, 4)).toEqual(["del", "del", "del", "del", "del"]);
  });

  it("gives a side that changed at least one block", () => {
    expect(ratioBlocks(100, 1)).toEqual(["add", "add", "add", "add", "del"]);
    expect(ratioBlocks(1, 100)).toEqual(["add", "del", "del", "del", "del"]);
  });

  it("is grey when nothing changed", () => {
    expect(ratioBlocks(0, 0)).toEqual(["none", "none", "none", "none", "none"]);
  });
});

describe("hunk lines", () => {
  const h = {
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 3,
    lines: ["     keep();", "-    old();", "+    fresh();", "+", "\\ No newline at end of file"],
  };

  it("writes the unified header", () => {
    expect(hunkHeader(h)).toBe("@@ -10,3 +10,3 @@");
  });

  it("splits off the sign and the shared indent", () => {
    expect(diffLines(h)).toEqual([
      { kind: "context", sign: " ", text: "keep();" },
      { kind: "del", sign: "−", text: "old();" },
      { kind: "add", sign: "+", text: "fresh();" },
      { kind: "add", sign: "+", text: "" },
      { kind: "meta", sign: "", text: "\\ No newline at end of file" },
    ]);
  });
});
