import { describe, expect, it } from "vitest";
import { rankFiles, scorePath } from "./file-match";

const PATHS = [
  "README.md",
  "apps/desktop/src/App.tsx",
  "apps/desktop/src/store/app-store.ts",
  "apps/desktop/src/components/workspace-panes/FilePane/FilePane.tsx",
  "apps/desktop/src/components/workspace-panes/FilePane/FilePaneHeader.tsx",
  "apps/desktop/src/lib/commands.ts",
  "packages/protocol/src/index.ts",
];

const ranked = (query: string, limit = 10) =>
  rankFiles(PATHS, query, limit).map((m) => m.path);

describe("rankFiles", () => {
  it("lists the paths as given for an empty query, up to the limit", () => {
    expect(ranked("", 2)).toEqual(["README.md", "apps/desktop/src/App.tsx"]);
  });

  it("drops paths the query isn't a subsequence of", () => {
    expect(ranked("zzz")).toEqual([]);
  });

  it("ranks a file-name match over one spread across folders", () => {
    expect(ranked("app")[0]).toBe("apps/desktop/src/App.tsx");
    expect(ranked("cmds")[0]).toBe("apps/desktop/src/lib/commands.ts");
  });

  it("ranks the shorter of two name-prefix matches first", () => {
    expect(ranked("filepane").slice(0, 2)).toEqual([
      "apps/desktop/src/components/workspace-panes/FilePane/FilePane.tsx",
      "apps/desktop/src/components/workspace-panes/FilePane/FilePaneHeader.tsx",
    ]);
  });

  it("matches across folders and ignores spaces and case", () => {
    expect(ranked("proto index")[0]).toBe("packages/protocol/src/index.ts");
    expect(ranked("FPH")[0]).toBe(
      "apps/desktop/src/components/workspace-panes/FilePane/FilePaneHeader.tsx",
    );
  });
});

describe("scorePath", () => {
  it("returns the matched positions in the path", () => {
    expect(scorePath("src/App.tsx", "app")?.positions).toEqual([4, 5, 6]);
  });
});
