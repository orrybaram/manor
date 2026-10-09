import { describe, it, expect } from "vitest";
import { applySuggestionResult, shouldSuggest } from "./folder-suggestion";

const gate = {
  jevConnected: true,
  folderTouched: false,
  initialFolderId: null,
  activeProjectId: "p1",
  folderCount: 2,
  name: "Fix login",
};

describe("shouldSuggest", () => {
  it("passes when every condition holds", () => {
    expect(shouldSuggest(gate)).toBe(true);
  });

  it.each([
    { jevConnected: false },
    { folderTouched: true },
    { initialFolderId: "f1" },
    { activeProjectId: "" },
    { folderCount: 0 },
    { name: "   " },
  ])("blocks on %o", (override) => {
    expect(shouldSuggest({ ...gate, ...override })).toBe(false);
  });
});

describe("applySuggestionResult", () => {
  const hit = { folderId: "f2", confidence: 0.9 };

  it("applies a hit", () => {
    expect(applySuggestionResult({ folderId: null, suggestion: null }, hit)).toEqual({
      folderId: "f2",
      suggestion: hit,
    });
  });

  it("reverts a previously suggested folder on a miss", () => {
    expect(applySuggestionResult({ folderId: "f2", suggestion: hit }, null)).toEqual({
      folderId: null,
      suggestion: null,
    });
  });

  it("leaves another pick alone on a miss", () => {
    expect(applySuggestionResult({ folderId: "f1", suggestion: null }, null)).toEqual({
      folderId: "f1",
      suggestion: null,
    });
  });
});
