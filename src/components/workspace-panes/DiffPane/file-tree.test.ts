import { describe, it, expect } from "vitest";
import { buildFileTree, flattenFileTree } from "./file-tree";
import type { DiffFile } from "./types";

const f = (path: string): DiffFile => ({ path, lines: [], added: 0, removed: 0 });

describe("buildFileTree", () => {
  it("nests files under directories, dirs and files sorted together", () => {
    const tree = buildFileTree([
      f("src/b.ts"),
      f("README.md"),
      f("src/a.ts"),
      f("electron/main.ts"),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["electron", "README.md", "src"]);
    const src = tree[2];
    expect(src.kind).toBe("dir");
    if (src.kind !== "dir") return;
    expect(src.children.map((n) => n.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("compresses single-child directory chains", () => {
    const tree = buildFileTree([f("src/components/tabbar/TabBar/TabBar.tsx")]);
    expect(tree).toHaveLength(1);
    const node = tree[0];
    expect(node.kind).toBe("dir");
    if (node.kind !== "dir") return;
    expect(node.name).toBe("src/components/tabbar/TabBar");
    expect(node.path).toBe("src/components/tabbar/TabBar");
    expect(node.children[0].name).toBe("TabBar.tsx");
  });

  it("does not compress a dir that has files of its own", () => {
    const tree = buildFileTree([
      f("src/sidebar/AgentsList.tsx"),
      f("src/sidebar/AgentsView/AgentsView.tsx"),
    ]);
    const src = tree[0];
    if (src.kind !== "dir") throw new Error("expected dir");
    expect(src.name).toBe("src/sidebar");
    expect(src.children.map((n) => n.name)).toEqual([
      "AgentsList.tsx",
      "AgentsView",
    ]);
  });

  it("flattens in depth-first display order", () => {
    const tree = buildFileTree([
      f("src/z.ts"),
      f("src/inner/a.ts"),
      f("src/b.ts"),
      f("top.ts"),
    ]);
    expect(flattenFileTree(tree).map((x) => x.path)).toEqual([
      "src/b.ts",
      "src/inner/a.ts",
      "src/z.ts",
      "top.ts",
    ]);
  });
});
