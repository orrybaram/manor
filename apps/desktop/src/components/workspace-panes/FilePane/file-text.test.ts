import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { readFileText, writeFileText } from "./file-text";

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
