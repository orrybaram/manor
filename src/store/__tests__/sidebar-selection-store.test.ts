import { beforeEach, describe, expect, it } from "vitest";
import { useSidebarSelectionStore } from "../sidebar-selection-store";
import { selectionKey } from "../../utils/sidebar-items";

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
    expect(state().keys).toEqual(new Set());
    expect(state().anchorKey).toBe("/b");
    expect(state().scopeId).toBe(PROJECT);
  });
});

describe("toggle", () => {
  it("adds a path and moves the anchor", () => {
    state().toggle(PROJECT, "/a");
    expect(state().keys).toEqual(new Set(["/a"]));
    expect(state().anchorKey).toBe("/a");
  });

  it("removes an already-selected path", () => {
    state().toggle(PROJECT, "/a");
    state().toggle(PROJECT, "/a");
    expect(state().keys).toEqual(new Set());
  });

  it("takes the anchor along when it starts a selection", () => {
    state().setAnchor(PROJECT, "/a");
    state().toggle(PROJECT, "/b");
    expect(state().keys).toEqual(new Set(["/a", "/b"]));
    expect(state().anchorKey).toBe("/b");
  });

  it("falls back to the active workspace when there is no anchor", () => {
    state().toggle(PROJECT, "/b", "/a");
    expect(state().keys).toEqual(new Set(["/a", "/b"]));
  });

  it("selects just the anchor when the anchor itself is toggled", () => {
    state().setAnchor(PROJECT, "/a");
    state().toggle(PROJECT, "/a");
    expect(state().keys).toEqual(new Set(["/a"]));
  });

  it("never brings back a row that was toggled off", () => {
    state().setAnchor(PROJECT, "/a");
    state().toggle(PROJECT, "/b");
    state().toggle(PROJECT, "/a");
    state().toggle(PROJECT, "/b");
    expect(state().keys).toEqual(new Set());
    state().toggle(PROJECT, "/c", "/active");
    expect(state().keys).toEqual(new Set(["/c"]));
  });

  it("starts a fresh selection when the scope changes", () => {
    state().toggle(PROJECT, "/a");
    state().toggle(OTHER_PROJECT, "/z");
    expect(state().scopeId).toBe(OTHER_PROJECT);
    expect(state().keys).toEqual(new Set(["/z"]));
  });
});

describe("selectRange", () => {
  const ordered = ["/a", "/b", "/c", "/d"];

  it("selects from the anchor to the clicked path", () => {
    state().setAnchor(PROJECT, "/a");
    state().selectRange(PROJECT, ordered, "/c", null);
    expect(state().keys).toEqual(new Set(["/a", "/b", "/c"]));
    // The anchor does not move.
    expect(state().anchorKey).toBe("/a");
  });

  it("selects backwards when the clicked path precedes the anchor", () => {
    state().setAnchor(PROJECT, "/c");
    state().selectRange(PROJECT, ordered, "/a", null);
    expect(state().keys).toEqual(new Set(["/a", "/b", "/c"]));
    expect(state().anchorKey).toBe("/c");
  });

  it("falls back to the given anchor when there is none in this scope", () => {
    state().selectRange(PROJECT, ordered, "/c", "/a");
    expect(state().keys).toEqual(new Set(["/a", "/b", "/c"]));
    expect(state().anchorKey).toBe("/a");
  });

  it("falls back to the clicked path when neither anchor is visible", () => {
    state().selectRange(PROJECT, ordered, "/c", "/not-visible");
    expect(state().keys).toEqual(new Set(["/c"]));
    expect(state().anchorKey).toBe("/c");
  });
});

describe("a linked group's sections (ADR-192 ticket 7)", () => {
  const GROUP = "group-1";
  // Two hosts with the same checkout path: distinct rows in one scope.
  const localA = selectionKey("local-proj", "/repo/a");
  const localB = selectionKey("local-proj", "/repo/b");
  const boxA = selectionKey("box-proj", "/repo/a");
  const boxB = selectionKey("box-proj", "/repo/b");
  const ordered = [localA, localB, boxA, boxB];

  it("toggles rows of different sections into one selection", () => {
    state().setAnchor(GROUP, localA);
    state().toggle(GROUP, boxA);
    expect(state().keys).toEqual(new Set([localA, boxA]));
    expect(state().scopeId).toBe(GROUP);
  });

  it("extends a range across the section boundary", () => {
    state().setAnchor(GROUP, localB);
    state().selectRange(GROUP, ordered, boxB, null);
    expect(state().keys).toEqual(new Set([localB, boxA, boxB]));
  });
});

describe("clear", () => {
  it("resets scope, keys and anchor", () => {
    state().toggle(PROJECT, "/a");
    state().clear();
    expect(state().scopeId).toBeNull();
    expect(state().keys).toEqual(new Set());
    expect(state().anchorKey).toBeNull();
  });
});
