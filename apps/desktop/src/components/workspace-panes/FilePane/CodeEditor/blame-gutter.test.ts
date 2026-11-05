import { describe, expect, it } from "vitest";
import { EditorState, Text, type TransactionSpec } from "@codemirror/state";
import type { BlameCommit, FileBlame } from "../../../../electron.d";
import {
  authorColor,
  authorInitials,
  blameAge,
  blameGutter,
  lineBlame,
  setBlame,
} from "./blame-gutter";

const commit = (sha: string): BlameCommit => ({
  sha,
  author: "Ada",
  time: 100,
  summary: sha,
  message: sha,
});

const A = commit("a".repeat(40));
const B = commit("b".repeat(40));
const NONE = commit("0".repeat(40));

const TEXT = "one\ntwo\nthree\nfour\n";
const clean = Text.of(TEXT.split("\n"));
/** one, two from A; three not committed; four from B. */
const BLAME: FileBlame = { commits: [A, B, NONE], lines: [0, 0, 2, 1] };

function open(doc = TEXT): EditorState {
  return EditorState.create({ doc, extensions: blameGutter(BLAME, clean) });
}

const shas = (state: EditorState) =>
  Array.from({ length: state.doc.lines }, (_, i) => {
    const blame = lineBlame(state, i + 1);
    return blame === undefined ? "-" : blame === null ? "new" : blame.sha[0];
  });

const apply = (state: EditorState, spec: TransactionSpec) => state.update(spec).state;

describe("blame gutter", () => {
  it("gives each line its commit, and nothing to the line after a final newline", () => {
    expect(shas(open())).toEqual(["a", "a", "new", "b", "-"]);
  });

  it("marks a line you edit as not committed, and only that one", () => {
    const state = apply(open(), { changes: { from: 4, insert: "x" } });
    expect(shas(state)).toEqual(["a", "new", "new", "b", "-"]);
  });

  it("carries lines down past a new one typed above them", () => {
    const state = apply(open(), { changes: { from: 0, insert: "zero\n" } });
    expect(shas(state)).toEqual(["new", "a", "a", "new", "b", "-"]);
  });

  it("carries lines up past a deleted one, which gives its blame to nothing else", () => {
    const state = apply(open(), { changes: { from: 0, to: 4 } });
    expect(shas(state)).toEqual(["a", "new", "b", "-"]);
  });

  it("gives an edit's blame back when it is undone by hand", () => {
    const typed = apply(open(), { changes: { from: 4, insert: "x" } });
    const undone = apply(typed, { changes: { from: 4, to: 5 } });
    expect(shas(undone)).toEqual(["a", "a", "new", "b", "-"]);
  });

  it("starts with your edits already placed, when the editor held a draft", () => {
    expect(shas(open("zero\none\ntwo\nthree\nfour\n"))).toEqual(["new", "a", "a", "new", "b", "-"]);
  });

  it("keeps a saved line not committed until the new blame comes", () => {
    const edited = apply(open(), { changes: { from: 4, insert: "x" } });
    const fresh: FileBlame = { commits: [B], lines: [0, 0, 0, 0] };
    const next = apply(edited, {
      effects: setBlame.of({ blame: fresh, doc: edited.doc }),
    });
    expect(shas(edited)).toEqual(["a", "new", "new", "b", "-"]);
    expect(shas(next)).toEqual(["b", "b", "b", "b", "-"]);
  });

  it("copes with the last lines going, and the whole file being replaced", () => {
    const cut = apply(open(), { changes: { from: 8, to: TEXT.length } });
    expect(shas(cut)).toEqual(["a", "a", "-"]);
    const replaced = apply(open(), { changes: { from: 0, to: TEXT.length, insert: "a\nb" } });
    expect(shas(replaced)).toEqual(["new", "new"]);
  });
});

describe("blameAge", () => {
  const now = 1000 * 86_400 * 1000;
  const ago = (seconds: number) => blameAge(now / 1000 - seconds, now);
  it("reads in the unit that fits", () => {
    expect(ago(10)).toBe("now");
    expect(ago(5 * 60)).toBe("5m");
    expect(ago(3 * 3600)).toBe("3h");
    expect(ago(2 * 86_400)).toBe("2d");
    expect(ago(90 * 86_400)).toBe("2mo");
    expect(ago(800 * 86_400)).toBe("2y");
  });
  it("treats a commit dated ahead of now as just made", () => {
    expect(ago(-500)).toBe("now");
  });
});

describe("authors", () => {
  it("shortens a name to two letters", () => {
    expect(authorInitials("Orry Baram")).toBe("OB");
    expect(authorInitials("Ada King Lovelace")).toBe("AL");
    expect(authorInitials("Claude")).toBe("CL");
    expect(authorInitials("dependabot[bot]")).toBe("DE");
    expect(authorInitials("github-actions")).toBe("GA");
    expect(authorInitials("")).toBe("?");
  });
  it("keeps one colour per author, from the theme", () => {
    expect(authorColor("Ada")).toBe(authorColor("Ada"));
    expect(authorColor("Ada")).toMatch(/^--(blue|magenta|cyan|green)$/);
    expect(new Set(["Ada", "Bob", "Claude", "Orry Baram", "Dee"].map(authorColor)).size).toBeGreaterThan(1);
  });
});
