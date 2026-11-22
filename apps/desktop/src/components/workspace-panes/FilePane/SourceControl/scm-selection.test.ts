import { describe, expect, it } from "vitest";
import {
  actionTargets,
  NO_SELECTION,
  selectedIn,
  selectGesture,
  selectRow,
  type ScmSelection,
} from "./scm-selection";

type G = "staged" | "changes";
const visible = ["a", "b", "c", "d", "e"];
const pick = (
  sel: ScmSelection<G>,
  path: string,
  gesture: "only" | "range" | "toggle",
  group: G = "changes",
) => selectRow(sel, group, path, gesture, visible);
const paths = (sel: ScmSelection<G>) => [...sel.paths].sort();

describe("selectGesture", () => {
  const e = (m: Partial<Record<"shiftKey" | "metaKey" | "ctrlKey", boolean>>) => ({
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...m,
  });
  it("ranges on Shift and toggles on the platform's command key", () => {
    expect(selectGesture(e({}), true)).toBe("only");
    expect(selectGesture(e({ shiftKey: true }), true)).toBe("range");
    expect(selectGesture(e({ metaKey: true }), true)).toBe("toggle");
    expect(selectGesture(e({ ctrlKey: true }), true)).toBe("only");
    expect(selectGesture(e({ ctrlKey: true }), false)).toBe("toggle");
    expect(selectGesture(e({ metaKey: true }), false)).toBe("only");
  });
});

describe("selectRow", () => {
  it("picks one file on a plain click and anchors there", () => {
    const sel = pick(pick(NO_SELECTION, "a", "only"), "c", "only");
    expect(paths(sel)).toEqual(["c"]);
    expect(sel.anchor).toBe("c");
  });

  it("selects the visible files from the anchor to a Shift+click, either way", () => {
    const anchored = pick(NO_SELECTION, "b", "only");
    expect(paths(pick(anchored, "d", "range"))).toEqual(["b", "c", "d"]);
    expect(paths(pick(anchored, "a", "range"))).toEqual(["a", "b"]);
  });

  it("keeps the anchor across ranges, so a second Shift+click replaces the first", () => {
    const sel = pick(pick(pick(NO_SELECTION, "c", "only"), "e", "range"), "a", "range");
    expect(paths(sel)).toEqual(["a", "b", "c"]);
    expect(sel.anchor).toBe("c");
  });

  it("toggles one file and moves the anchor to it", () => {
    let sel = pick(NO_SELECTION, "a", "only");
    sel = pick(sel, "c", "toggle");
    expect(paths(sel)).toEqual(["a", "c"]);
    sel = pick(sel, "a", "toggle");
    expect(paths(sel)).toEqual(["c"]);
    expect(sel.anchor).toBe("a");
    expect(paths(pick(sel, "b", "range"))).toEqual(["a", "b"]);
  });

  it("starts over in the other group, whatever the gesture", () => {
    const sel = pick(pick(NO_SELECTION, "a", "only"), "c", "range");
    const there = pick(sel, "x", "range", "staged");
    expect(there.group).toBe("staged");
    expect(paths(there)).toEqual(["x"]);
    expect(pick(sel, "x", "toggle", "staged").anchor).toBe("x");
  });

  it("picks just the file when the anchor is no longer visible", () => {
    const sel: ScmSelection<G> = { group: "changes", paths: new Set(["gone"]), anchor: "gone" };
    expect(paths(pick(sel, "c", "range"))).toEqual(["c"]);
    expect(paths(pick(NO_SELECTION, "c", "range"))).toEqual(["c"]);
  });
});

describe("selectedIn", () => {
  it("lists the selection's files still in its group, in list order", () => {
    const sel: ScmSelection<G> = { group: "changes", paths: new Set(["d", "gone", "a"]), anchor: "a" };
    expect(selectedIn(sel, "changes", visible)).toEqual(["a", "d"]);
    expect(selectedIn(sel, "staged", visible)).toEqual([]);
  });
});

describe("actionTargets", () => {
  it("acts on every selected file from a selected row, else on the row alone", () => {
    expect(actionTargets(["a", "b"], "b")).toEqual(["a", "b"]);
    expect(actionTargets(["a", "b"], "c")).toEqual(["c"]);
    expect(actionTargets(["a"], "a")).toEqual(["a"]);
  });
});
