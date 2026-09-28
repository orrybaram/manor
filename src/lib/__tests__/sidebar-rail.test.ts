import { describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "../../store/project-store";
import {
  railTileLabel,
  workspaceDisplayName,
} from "../sidebar-rail";

function ws(path: string, extra: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { path, branch: path, isMain: false, name: null, ...extra };
}

describe("railTileLabel", () => {
  it("uppercases the first letter", () => {
    expect(railTileLabel("manor")).toBe("M");
    expect(railTileLabel("Alpha")).toBe("A");
  });
  it("returns a leading emoji", () => {
    expect(railTileLabel("🚀 launch")).toBe("🚀");
  });
  it("ignores leading whitespace", () => {
    expect(railTileLabel("   beta")).toBe("B");
  });
  it("returns ? for empty", () => {
    expect(railTileLabel("")).toBe("?");
    expect(railTileLabel("   ")).toBe("?");
  });
});

describe("workspaceDisplayName", () => {
  it("names main for its remote target or local", () => {
    expect(workspaceDisplayName(ws("a", { isMain: true }), "box")).toBe("box");
    expect(workspaceDisplayName(ws("a", { isMain: true }), null)).toBe("local");
  });
  it("prefers name, then branch", () => {
    expect(workspaceDisplayName(ws("a", { name: "N", branch: "b" }), null)).toBe("N");
    expect(workspaceDisplayName(ws("a", { branch: "b" }), null)).toBe("b");
  });
});
