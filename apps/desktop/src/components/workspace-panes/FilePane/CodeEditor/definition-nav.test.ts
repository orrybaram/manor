import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { identifierAt, identifierAtCursor, navModifier } from "./definition-nav";

const doc = "const total = formatTotal(3); // 42 é-x";

describe("identifierAt", () => {
  const state = EditorState.create({ doc });

  it("gives the identifier touching a position, with its range", () => {
    const at = doc.indexOf("formatTotal") + 3;
    expect(identifierAt(state, at)).toEqual({
      from: doc.indexOf("formatTotal"),
      to: doc.indexOf("formatTotal") + "formatTotal".length,
      word: "formatTotal",
    });
    // Just past its end still touches it.
    expect(identifierAt(state, doc.indexOf(" = "))?.word).toBe("total");
  });

  it("gives nothing off an identifier", () => {
    expect(identifierAt(state, doc.indexOf("42") + 1)).toBeNull();
    expect(identifierAt(state, doc.indexOf("(3)") + 1)).toBeNull();
    expect(identifierAt(state, doc.indexOf("é"))).toBeNull();
  });
});

describe("identifierAtCursor", () => {
  const at = (anchor: number, head = anchor) =>
    EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });

  it("takes the identifier at the cursor", () => {
    expect(identifierAtCursor(at(doc.indexOf("Total(")))).toBe("formatTotal");
  });

  it("takes a selection only when it is one identifier", () => {
    const from = doc.indexOf("format");
    expect(identifierAtCursor(at(from, from + "format".length))).toBe("format");
    expect(identifierAtCursor(at(0, "const total".length))).toBeNull();
  });
});

describe("navModifier", () => {
  const e = (over: Partial<MouseEvent>) => ({
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

  it("is ⌘ alone on a Mac and Ctrl alone elsewhere", () => {
    expect(navModifier(e({ metaKey: true }), true)).toBe(true);
    expect(navModifier(e({ ctrlKey: true }), true)).toBe(false);
    expect(navModifier(e({ ctrlKey: true }), false)).toBe(true);
    expect(navModifier(e({ metaKey: true }), false)).toBe(false);
    expect(navModifier(e({ metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(navModifier(e({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(navModifier(e({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });
});
