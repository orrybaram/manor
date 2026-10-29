import { Text } from "@codemirror/state";

const BOM = "﻿";

/**
 * How a file is written on disk apart from its lines: a leading byte-order
 * mark, and CRLF or LF line breaks. The editor shows the text only, with its
 * line breaks normalized, and a save writes this back, so a BOM and a CRLF
 * file round-trip unchanged, and text pasted with other breaks is written
 * with the file's own.
 */
export type FileFormat = { bom: boolean; crlf: boolean };

/**
 * A file's content, as the editor shows it (`text`) and as it was written.
 *
 * A file whose breaks are mixed is read as the kind it has more of (a tie
 * is LF), and a save writes every break that way: mixed endings are
 * normalized to the majority, not kept line by line.
 */
export function readFileText(content: string): { format: FileFormat; text: string } {
  const bom = content.startsWith(BOM);
  const text = bom ? content.slice(BOM.length) : content;
  const crlfs = text.match(/\r\n/g)?.length ?? 0;
  const lfs = (text.match(/\n/g)?.length ?? 0) - crlfs;
  return { format: { bom, crlf: crlfs > lfs }, text };
}

/** What a save writes for the editor's `doc`: every line break the file's own. */
export function writeFileText(format: FileFormat, doc: Text): string {
  const text = doc.sliceString(0, doc.length, format.crlf ? "\r\n" : "\n");
  return format.bom ? BOM + text : text;
}

/** `text` split into lines as the editor splits it, whatever its breaks. */
export function toText(text: string): Text {
  return Text.of(text.split(/\r\n?|\n/));
}

/**
 * The editor's file apart from what it shows: the format a save writes and
 * the clean copy. The format is the one the file was loaded with, and stays
 * so: a save does not re-read it from what it wrote (a CRLF file edited down
 * to one line has no break left to tell), and whether the editor is dirty is
 * whether its text differs from the clean copy's, never its format.
 */
export class EditorFile {
  private constructor(
    /** How a save writes the editor's text. */
    public format: FileFormat,
    private clean: Text,
  ) {}

  /**
   * Open `base` (on disk), showing `draft` (unsaved edits from a mount
   * before) when there is one. A draft was written in the format the file
   * was loaded with, so it tells that format, unless it has no break to
   * tell: then `base`'s.
   */
  static open(base: string, draft: string | null): { file: EditorFile; shown: string } {
    const clean = readFileText(base);
    if (draft === null) {
      return { file: new EditorFile(clean.format, toText(clean.text)), shown: clean.text };
    }
    const shown = readFileText(draft);
    const format = {
      bom: shown.format.bom,
      crlf: /[\r\n]/.test(shown.text) ? shown.format.crlf : clean.format.crlf,
    };
    return { file: new EditorFile(format, toText(clean.text)), shown: shown.text };
  }

  /** The clean copy, as the editor splits it: what your unsaved lines differ from. */
  get cleanDoc(): Text {
    return this.clean;
  }

  /** `doc` differs from the clean copy. */
  isDirty(doc: Text): boolean {
    return !doc.eq(this.clean);
  }

  /** What a save writes for `doc`. */
  write(doc: Text): string {
    return writeFileText(this.format, doc);
  }

  /** `written` (by `write`) is now on disk: the clean copy, in the same format. */
  markClean(written: string): void {
    this.clean = toText(readFileText(written).text);
  }

  /** `content` was read from disk and replaces what the editor shows. Returns its text. */
  replace(content: string): { text: Text } {
    const { format, text } = readFileText(content);
    this.format = format;
    this.clean = toText(text);
    return { text: this.clean };
  }
}
