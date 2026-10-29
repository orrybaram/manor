import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorFile, readFileText, writeFileText } from "./file-text";

/** Load `content` as the editor does, apply `edit`, and write it back. */
function roundTrip(content: string, edit?: (state: EditorState) => EditorState): string {
  const { format, text } = readFileText(content);
  let state = EditorState.create({ doc: text });
  if (edit) state = edit(state);
  return writeFileText(format, state.doc);
}

describe("readFileText / writeFileText", () => {
  it("round-trips a leading BOM and LF breaks unchanged", () => {
    const content = "﻿const a = 1;\nconst b = 2;\n";
    expect(readFileText(content)).toEqual({
      format: { bom: true, crlf: false },
      text: "const a = 1;\nconst b = 2;\n",
    });
    expect(roundTrip(content)).toBe(content);
  });

  it("round-trips a CRLF file unchanged", () => {
    expect(roundTrip("a\r\nb\r\n")).toBe("a\r\nb\r\n");
    expect(roundTrip("﻿a\r\nb")).toBe("﻿a\r\nb");
  });

  it("writes LF text pasted into a CRLF file with CRLFs, keeping the BOM", () => {
    const written = roundTrip("﻿a\r\nb\r\n", (state) =>
      state.update({ changes: { from: 1, insert: "\npasted\nlines" } }).state,
    );
    expect(written).toBe("﻿a\r\npasted\r\nlines\r\nb\r\n");
    expect(written.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("writes CRLF text pasted into an LF file with LFs", () => {
    const written = roundTrip("a\nb\n", (state) =>
      state.update({ changes: { from: 1, insert: "\r\npasted" } }).state,
    );
    expect(written).toBe("a\npasted\nb\n");
  });
});

describe("mixed line breaks", () => {
  it("are read as the kind there are more of, and written that way throughout", () => {
    expect(readFileText("a\r\nb\r\nc\nd").format.crlf).toBe(true);
    expect(roundTrip("a\r\nb\r\nc\nd")).toBe("a\r\nb\r\nc\r\nd");
    expect(readFileText("a\nb\nc\r\nd").format.crlf).toBe(false);
    expect(roundTrip("a\nb\nc\r\nd")).toBe("a\nb\nc\nd");
    // A tie is LF.
    expect(readFileText("a\r\nb\nc").format.crlf).toBe(false);
  });
});

describe("EditorFile", () => {
  /** The editor's document: `shown`, after `edit`. */
  function edited(shown: string, edit: (state: EditorState) => EditorState) {
    return edit(EditorState.create({ doc: shown })).doc;
  }
  const joinLines = (state: EditorState) =>
    state.update({ changes: { from: 0, to: state.doc.length, insert: "ab" } }).state;

  it("a CRLF file edited down to one line and saved is clean", () => {
    const { file, shown } = EditorFile.open("a\r\nb\r\n", null);
    const doc = edited(shown, joinLines);
    expect(file.isDirty(doc)).toBe(true);
    const written = file.write(doc);
    expect(written).toBe("ab");
    file.markClean(written);
    expect(file.isDirty(doc)).toBe(false);
    // And it keeps the file's breaks for lines typed after.
    expect(file.format.crlf).toBe(true);
    const more = edited("ab", (s) => s.update({ changes: { from: 2, insert: "\nc" } }).state);
    expect(file.write(more)).toBe("ab\r\nc");
  });

  it("a one-line draft resumed over a CRLF file keeps its breaks and is not stuck dirty", () => {
    const { file, shown } = EditorFile.open("a\r\nb", "ab");
    expect(file.format.crlf).toBe(true);
    const doc = EditorState.create({ doc: shown }).doc;
    expect(file.isDirty(doc)).toBe(true);
    file.markClean(file.write(doc));
    expect(file.isDirty(doc)).toBe(false);
  });

  it("a CRLF draft over a file saved down to one line is clean once edited back", () => {
    // Saved as "ab" (one line, nothing to tell CRLF), then lines were typed
    // and the pane remounted.
    const { file, shown } = EditorFile.open("ab", "ab\r\nc");
    expect(file.format.crlf).toBe(true);
    const back = edited(shown, (s) =>
      s.update({ changes: { from: 2, to: s.doc.length, insert: "" } }).state,
    );
    expect(file.isDirty(back)).toBe(false);
  });

  it("keeps a BOM, and takes the format of a re-read", () => {
    const { file, shown } = EditorFile.open("﻿a\nb", null);
    expect(file.write(EditorState.create({ doc: shown }).doc)).toBe("﻿a\nb");
    const { text } = file.replace("x\r\ny");
    expect(file.format).toEqual({ bom: false, crlf: true });
    expect(file.isDirty(text)).toBe(false);
  });
});
