import { beforeEach, describe, expect, it } from "vitest";
import { useDeletingWorkspacesStore } from "../deleting-workspaces-store";

function state() {
  return useDeletingWorkspacesStore.getState();
}

beforeEach(() => {
  useDeletingWorkspacesStore.setState({ keys: new Set(), counts: new Map() });
});

describe("deleting workspaces", () => {
  it("dims a key from mark until unmark", () => {
    state().mark(["a"]);
    expect(state().keys).toEqual(new Set(["a"]));
    state().unmark(["a"]);
    expect(state().keys).toEqual(new Set());
  });

  it("keeps a key dimmed until every overlapping removal has settled", () => {
    // A bulk delete and a single delete both remove "a".
    state().mark(["a", "b"]);
    state().mark(["a"]);
    // The single delete fails first; the bulk one is still running.
    state().unmark(["a"]);
    expect(state().keys).toEqual(new Set(["a", "b"]));
    state().unmark(["a", "b"]);
    expect(state().keys).toEqual(new Set());
  });

  it("ignores an unmark with no matching mark", () => {
    state().unmark(["x"]);
    expect(state().keys).toEqual(new Set());
    expect(state().counts.size).toBe(0);
  });
});
