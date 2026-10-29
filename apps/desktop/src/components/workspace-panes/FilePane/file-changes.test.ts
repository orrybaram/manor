import { describe, expect, it } from "vitest";
import { parseDiff } from "../DiffPane/parser";
import {
  changedLineRanges,
  fileChangesFromDiff,
  foldersWithChanges,
  stepEdit,
} from "./file-changes";

const lines = (diff: string) => parseDiff(diff.replace(/\n$/, ""))[0].lines;

const MODIFIED = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,6 +1,7 @@",
  " one",
  "-two",
  "+TWO",
  "+two and a half",
  " three",
  " four",
  "-five",
  " six",
  "@@ -20,3 +21,2 @@",
  " twenty",
  " twenty-one",
  "-twenty-two",
  "",
].join("\n");

const ADDED = [
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const a = 1;",
  "+export const b = 2;",
  "",
].join("\n");

const DELETED = [
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const gone = 1;",
  "",
].join("\n");

const RENAMED = [
  "diff --git a/src/old.ts b/src/moved.ts",
  "similarity index 100%",
  "rename from src/old.ts",
  "rename to src/moved.ts",
  "",
].join("\n");

describe("changedLineRanges", () => {
  it("marks each run of added lines, in the new file's numbers", () => {
    const ranges = changedLineRanges(lines(MODIFIED));
    expect(ranges[0]).toEqual({ from: 2, to: 3 });
  });

  it("marks the line after a deletion, or the line before one at a hunk's end", () => {
    // "-five" sits before " six" (new line 6); "-twenty-two" ends its hunk after line 22.
    expect(changedLineRanges(lines(MODIFIED))).toEqual([
      { from: 2, to: 3 },
      { from: 6, to: 6 },
      { from: 22, to: 22 },
    ]);
  });

  it("marks every line of a new file as one run", () => {
    expect(changedLineRanges(lines(ADDED))).toEqual([{ from: 1, to: 2 }]);
  });

  it("merges a deletion's mark into the run it touches", () => {
    const diff = [
      "diff --git a/x b/x",
      "@@ -1,3 +1,3 @@",
      "+new first",
      "-old first",
      " kept",
      "",
    ].join("\n");
    expect(changedLineRanges(lines(diff))).toEqual([{ from: 1, to: 1 }]);
  });
});

describe("fileChangesFromDiff", () => {
  it("reads each file's status and ranges", () => {
    const changes = fileChangesFromDiff(MODIFIED + ADDED + DELETED + RENAMED);
    expect(changes.get("src/a.ts")?.status).toBe("modified");
    expect(changes.get("src/new.ts")).toEqual({
      path: "src/new.ts",
      status: "added",
      ranges: [{ from: 1, to: 2 }],
    });
    expect(changes.get("src/gone.ts")).toEqual({ path: "src/gone.ts", status: "deleted", ranges: [] });
    expect(changes.get("src/moved.ts")?.status).toBe("renamed");
  });

  it("is empty for no diff", () => {
    expect(fileChangesFromDiff(null).size).toBe(0);
    expect(fileChangesFromDiff("").size).toBe(0);
  });
});

describe("foldersWithChanges", () => {
  it("dots every folder on the way to a changed file, and no file", () => {
    expect(
      [...foldersWithChanges(["src/components/tabbar/Tab.tsx", "src/a.ts", "README.md"])].sort(),
    ).toEqual(["src", "src/components", "src/components/tabbar"]);
  });

  it("is empty with nothing changed", () => {
    expect(foldersWithChanges([]).size).toBe(0);
  });
});

describe("stepEdit", () => {
  it("starts at the first going down and the last going up", () => {
    expect(stepEdit(4, null, 1)).toBe(0);
    expect(stepEdit(4, null, -1)).toBe(3);
  });

  it("wraps at both ends", () => {
    expect(stepEdit(4, 3, 1)).toBe(0);
    expect(stepEdit(4, 0, -1)).toBe(3);
    expect(stepEdit(4, 1, 1)).toBe(2);
  });

  it("restarts when the edits shrank under the current one", () => {
    expect(stepEdit(2, 5, 1)).toBe(0);
  });

  it("has nowhere to go with no edits", () => {
    expect(stepEdit(0, null, 1)).toBeNull();
  });
});
