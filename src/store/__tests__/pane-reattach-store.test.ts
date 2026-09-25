import { describe, it, expect, beforeEach } from "vitest";
import { consumeReattach, usePaneReattachStore } from "../pane-reattach-store";

describe("pane-reattach-store", () => {
  beforeEach(() => {
    usePaneReattachStore.setState({ epochByPane: {} });
    consumeReattach("a");
    consumeReattach("b");
  });

  it("bumps each pane's epoch so its terminal remounts", () => {
    usePaneReattachStore.getState().reattach(["a", "b"]);
    usePaneReattachStore.getState().reattach(["a"]);
    expect(usePaneReattachStore.getState().epochByPane).toEqual({ a: 2, b: 1 });
  });

  it("does not update for an empty list", () => {
    const before = usePaneReattachStore.getState();
    usePaneReattachStore.getState().reattach([]);
    expect(usePaneReattachStore.getState()).toBe(before);
  });

  it("marks the next mount as a reattach, once", () => {
    expect(consumeReattach("a")).toBe(false);
    usePaneReattachStore.getState().reattach(["a"]);
    expect(consumeReattach("a")).toBe(true);
    expect(consumeReattach("a")).toBe(false);
  });
});
