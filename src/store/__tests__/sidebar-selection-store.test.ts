import { beforeEach, describe, expect, it } from "vitest";
import { useSidebarSelectionStore } from "../sidebar-selection-store";

const PROJECT = "proj-1";
const OTHER_PROJECT = "proj-2";

function state() {
  return useSidebarSelectionStore.getState();
}

beforeEach(() => {
  state().clear();
});

describe("setAnchor", () => {
  it("clears the selection and sets the anchor", () => {
    state().toggle(PROJECT, "/a");
    state().setAnchor(PROJECT, "/b");
    expect(state().paths).toEqual(new Set());
    expect(state().anchorPath).toBe("/b");
    expect(state().projectId).toBe(PROJECT);
  });
});

describe("toggle", () => {
  it("adds a path and moves the anchor", () => {
    state().toggle(PROJECT, "/a");
    expect(state().paths).toEqual(new Set(["/a"]));
    expect(state().anchorPath).toBe("/a");
  });

  it("removes an already-selected path", () => {
    state().toggle(PROJECT, "/a");
    state().toggle(PROJECT, "/a");
    expect(state().paths).toEqual(new Set());
  });

  it("starts a fresh selection when the project changes", () => {
    state().toggle(PROJECT, "/a");
    state().toggle(OTHER_PROJECT, "/z");
    expect(state().projectId).toBe(OTHER_PROJECT);
    expect(state().paths).toEqual(new Set(["/z"]));
  });
});

describe("selectRange", () => {
  const ordered = ["/a", "/b", "/c", "/d"];

  it("selects from the anchor to the clicked path", () => {
    state().setAnchor(PROJECT, "/a");
    state().selectRange(PROJECT, ordered, "/c", null);
    expect(state().paths).toEqual(new Set(["/a", "/b", "/c"]));
    // The anchor does not move.
    expect(state().anchorPath).toBe("/a");
  });

  it("selects backwards when the clicked path precedes the anchor", () => {
    state().setAnchor(PROJECT, "/c");
    state().selectRange(PROJECT, ordered, "/a", null);
    expect(state().paths).toEqual(new Set(["/a", "/b", "/c"]));
    expect(state().anchorPath).toBe("/c");
  });

  it("falls back to the given anchor when there is none in this project", () => {
    state().selectRange(PROJECT, ordered, "/c", "/a");
    expect(state().paths).toEqual(new Set(["/a", "/b", "/c"]));
    expect(state().anchorPath).toBe("/a");
  });

  it("falls back to the clicked path when neither anchor is visible", () => {
    state().selectRange(PROJECT, ordered, "/c", "/not-visible");
    expect(state().paths).toEqual(new Set(["/c"]));
    expect(state().anchorPath).toBe("/c");
  });
});

describe("clear", () => {
  it("resets project, paths and anchor", () => {
    state().toggle(PROJECT, "/a");
    state().clear();
    expect(state().projectId).toBeNull();
    expect(state().paths).toEqual(new Set());
    expect(state().anchorPath).toBeNull();
  });
});

describe("prune", () => {
  it("drops paths no longer present", () => {
    state().toggle(PROJECT, "/a");
    state().toggle(PROJECT, "/b");
    state().prune(PROJECT, new Set(["/a"]));
    expect(state().paths).toEqual(new Set(["/a"]));
  });

  it("does nothing for a different project", () => {
    state().toggle(PROJECT, "/a");
    state().prune(OTHER_PROJECT, new Set());
    expect(state().paths).toEqual(new Set(["/a"]));
  });
});
