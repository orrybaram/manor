import { describe, it, expect } from "vitest";
import {
  isFolderDescendant,
  normalizeSidebarOrder,
  spliceFolderOut,
} from "./workspace-folders";

describe("sidebar order", () => {
  describe("normalizeSidebarOrder", () => {
    it("keeps known entries in order", () => {
      const result = normalizeSidebarOrder(
        ["folder-a", "/tmp/b", "/tmp/a"],
        ["/tmp/a", "/tmp/b"],
        ["folder-a"],
      );
      expect(result).toEqual(["folder-a", "/tmp/b", "/tmp/a"]);
    });

    it("drops unknown ids and stale paths", () => {
      const result = normalizeSidebarOrder(
        ["/tmp/gone", "folder-gone", "/tmp/a"],
        ["/tmp/a"],
        [],
      );
      expect(result).toEqual(["/tmp/a"]);
    });

    it("appends missing paths then missing folder ids", () => {
      const result = normalizeSidebarOrder(
        ["/tmp/a"],
        ["/tmp/a", "/tmp/b"],
        ["folder-a"],
      );
      expect(result).toEqual(["/tmp/a", "/tmp/b", "folder-a"]);
    });

    it("undefined input yields paths then folder ids", () => {
      const result = normalizeSidebarOrder(
        undefined,
        ["/tmp/a", "/tmp/b"],
        ["folder-a"],
      );
      expect(result).toEqual(["/tmp/a", "/tmp/b", "folder-a"]);
    });

    it("never duplicates an entry even if it appears twice in the input", () => {
      const result = normalizeSidebarOrder(
        ["/tmp/a", "/tmp/a"],
        ["/tmp/a", "/tmp/b"],
        [],
      );
      expect(result).toEqual(["/tmp/a", "/tmp/b"]);
    });
  });

  describe("spliceFolderOut", () => {
    it("gathers scattered members into the folder's slot", () => {
      const result = spliceFolderOut(
        ["/tmp/loose-1", "/tmp/a", "folder-a", "/tmp/loose-2", "/tmp/b"],
        "folder-a",
        ["/tmp/a", "/tmp/b"],
      );
      expect(result).toEqual([
        "/tmp/loose-1",
        "/tmp/a",
        "/tmp/b",
        "/tmp/loose-2",
      ]);
    });

    it("appends members when the folder id is absent", () => {
      const result = spliceFolderOut(
        ["/tmp/loose-1", "/tmp/loose-2"],
        "folder-missing",
        ["/tmp/a", "/tmp/b"],
      );
      expect(result).toEqual([
        "/tmp/loose-1",
        "/tmp/loose-2",
        "/tmp/a",
        "/tmp/b",
      ]);
    });

    it("never duplicates a path", () => {
      const result = spliceFolderOut(
        ["folder-a", "/tmp/a", "/tmp/b"],
        "folder-a",
        ["/tmp/a", "/tmp/b"],
      );
      expect(result).toEqual(["/tmp/a", "/tmp/b"]);
      expect(result.filter((e) => e === "/tmp/a")).toHaveLength(1);
    });
  });

  describe("isFolderDescendant", () => {
    const folders = [
      { id: "top", name: "Epic", parentId: null },
      { id: "mid", name: "API", parentId: "top" },
      { id: "leaf", name: "v2", parentId: "mid" },
      { id: "other", name: "Bugs", parentId: null },
    ];

    it("counts the folder itself", () => {
      expect(isFolderDescendant(folders, "top", "top")).toBe(true);
    });

    it("finds a direct child and an indirect one", () => {
      expect(isFolderDescendant(folders, "top", "mid")).toBe(true);
      expect(isFolderDescendant(folders, "top", "leaf")).toBe(true);
    });

    it("is false for an unrelated folder, an ancestor, null and unknown ids", () => {
      expect(isFolderDescendant(folders, "top", "other")).toBe(false);
      expect(isFolderDescendant(folders, "leaf", "top")).toBe(false);
      expect(isFolderDescendant(folders, "top", null)).toBe(false);
      expect(isFolderDescendant(folders, "top", "nonexistent")).toBe(false);
    });

    it("terminates on a cyclic parent chain", () => {
      const cyclic = [
        { id: "a", name: "A", parentId: "b" },
        { id: "b", name: "B", parentId: "a" },
      ];
      expect(isFolderDescendant(cyclic, "c", "a")).toBe(false);
      expect(isFolderDescendant(cyclic, "b", "a")).toBe(true);
    });
  });
});
