import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { baseFromDiff, fileDiffIn, followDiffBase, type FileDiff } from "./diff-base";

const dir = mkdtempSync(join(tmpdir(), "diff-base-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Git's own diff of `before` → `after`, as `diffs.getLocalDiff` would read it. */
function gitDiff(before: string, after: string): string {
  writeFileSync(join(dir, "a"), before);
  writeFileSync(join(dir, "b"), after);
  try {
    execFileSync("git", ["diff", "--no-index", "--no-color", "a", "b"], { cwd: dir, encoding: "utf8" });
    return "";
  } catch (err) {
    // Exit 1: the files differ, which is the point.
    return (err as { stdout: string }).stdout;
  }
}

/** Rebuild `before` from `after` and git's diff of the two. */
function roundTrip(before: string, after: string): string | null {
  return baseFromDiff(after, fileDiffIn(gitDiff(before, after), "b"));
}

const lines = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`);

describe("baseFromDiff", () => {
  it.each([
    ["one changed line", "a\nb\nc\n", "a\nB\nc\n"],
    ["lines added at the top", "a\nb\n", "x\ny\na\nb\n"],
    ["lines removed at the end", "a\nb\nc\nd\n", "a\nb\n"],
    [
      "several hunks",
      [...lines(40)].join("\n") + "\n",
      [...lines(40)].map((l, i) => (i === 3 || i === 30 ? `${l} changed` : l)).join("\n") + "\n",
    ],
    [
      "hunks that add and remove lines",
      [...lines(60)].join("\n") + "\n",
      [...lines(60)]
        .flatMap((l, i) => (i === 5 ? [] : i === 40 ? [l, "new a", "new b"] : [l]))
        .join("\n") + "\n",
    ],
    ["a newline added at the end", "a\nb", "a\nb\n"],
    ["a newline removed at the end", "a\nb\n", "a\nb"],
    ["no newline at the end on either side", "a\nb", "a\nc"],
    ["no newline at the end, the end unchanged", [...lines(20)].join("\n"), ["x", ...lines(20)].join("\n")],
    ["CRLF lines", "a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n"],
    ["a file emptied", "a\nb\n", ""],
    ["a file filled", "", "a\nb\n"],
    ["removed lines that look like headers", "--- a\n+++ b\nkeep\n", "keep\n"],
  ])("rebuilds the old side: %s", (_name, before, after) => {
    expect(roundTrip(before, after)).toBe(before);
  });

  it("gives an unchanged file (no section in the diff) as it is", () => {
    expect(baseFromDiff("same\n", null)).toBe("same\n");
  });

  it("gives a new file an empty old side", () => {
    const raw =
      "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n";
    const diff = fileDiffIn(raw, "new.ts");
    expect(diff?.added).toBe(true);
    expect(baseFromDiff("one\ntwo\n", diff)).toBe("");
  });

  it("rebuilds a deleted file from nothing", () => {
    const raw =
      "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n\\ No newline at end of file\n";
    const diff = fileDiffIn(raw, "gone.ts");
    expect(diff?.deleted).toBe(true);
    expect(baseFromDiff("", diff)).toBe("one\ntwo");
  });

  it("finds its file among others and stops at the next", () => {
    const raw =
      gitDiff("x\n", "y\n").replace(/a\/a b\/b/, "a/first b/first") +
      gitDiff("a\nb\n", "a\nc\n");
    const diff = fileDiffIn(raw, "first");
    expect(diff?.hunks).toHaveLength(1);
    expect(baseFromDiff("y\n", diff)).toBe("x\n");
    expect(fileDiffIn(raw, "missing")).toBeNull();
  });

  it("marks a binary file", () => {
    const raw = "diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n";
    expect(fileDiffIn(raw, "img.png")?.binary).toBe(true);
  });

  it("refuses a working copy that has moved on since the diff", () => {
    const diff = fileDiffIn(gitDiff("a\nb\nc\n", "a\nB\nc\n"), "b");
    expect(baseFromDiff("a\nB!\nc\n", diff)).toBeNull();
    // Lines added above the hunk shift it off its place.
    expect(baseFromDiff("top\na\nB\nc\n", diff)).toBeNull();
    // Only the final newline differs.
    expect(baseFromDiff("a\nB\nc", diff)).toBeNull();
  });
});

describe("followDiffBase", () => {
  const diff = fileDiffIn(gitDiff("a\nb\n", "a\nB\n"), "b") as FileDiff;

  it("waits for the first diff without a base", () => {
    expect(followDiffBase(null, undefined, "a\nB\n")).toMatchObject({ base: null, stale: false });
  });

  it("keeps the base while only the working copy moved (a save)", () => {
    const first = followDiffBase(null, diff, "a\nB\n");
    expect(first).toMatchObject({ base: "a\nb\n", stale: false });
    const saved = followDiffBase(first, diff, "a\nB!\n");
    expect(saved).toMatchObject({ base: "a\nb\n", stale: false });
  });

  it("says stale when a new diff doesn't fit, keeping the last base", () => {
    const first = followDiffBase(null, diff, "a\nB\n");
    const newer = fileDiffIn(gitDiff("a\nb\n", "a\nC\n"), "b");
    expect(followDiffBase(first, newer, "a\nB\n")).toMatchObject({ base: "a\nb\n", stale: true });
  });

  it("says stale with no base when the first diff doesn't fit", () => {
    expect(followDiffBase(null, diff, "zzz\n")).toMatchObject({ base: null, stale: true });
  });
});
