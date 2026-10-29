import { describe, expect, it } from "vitest";
import { parseDiff } from "../parser";

const DIFF = `diff --git a/src/kept.ts b/src/kept.ts
index 1111111..2222222 100644
--- a/src/kept.ts
+++ b/src/kept.ts
@@ -1,2 +1,2 @@
-export const a = 1;
+export const a = 2;
 export const b = 1;
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const gone = true;
`;

describe("parseDiff", () => {
  it("marks a deleted file, and only that one", () => {
    const files = parseDiff(DIFF);
    expect(files.map((f) => [f.path, f.deleted ?? false])).toEqual([
      ["src/kept.ts", false],
      ["src/gone.ts", true],
    ]);
    expect(files[1].removed).toBe(1);
  });

  it("keeps a removed `-- x` and an added `++ y` inside a hunk", () => {
    const [file] = parseDiff(`diff --git a/db/q.sql b/db/q.sql
index 1111111..2222222 100644
--- a/db/q.sql
+++ b/db/q.sql
@@ -1,2 +1,2 @@
--- old comment
++++ new line
 select 1;
`);
    expect(file.lines.map((l) => [l.type, l.content])).toEqual([
      ["hunk", "@@ -1 +1 @@"],
      ["del", "-- old comment"],
      ["add", "+++ new line"],
      ["context", "select 1;"],
      ["context", ""],
    ]);
    expect([file.added, file.removed]).toEqual([1, 1]);
    expect(file.deleted).toBeUndefined();
  });
});
