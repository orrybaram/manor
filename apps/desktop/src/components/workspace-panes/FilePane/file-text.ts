import type { Text } from "@codemirror/state";

const BOM = "﻿";

/**
 * How a file is written on disk apart from its lines: a leading byte-order
 * mark, and CRLF or LF line breaks. The editor shows the text only, with its
 * line breaks normalized, and a save writes this back, so a BOM and a CRLF
 * file round-trip unchanged, and text pasted with other breaks is written
 * with the file's own.
 */
export type FileFormat = { bom: boolean; crlf: boolean };

/** A file's content, as the editor shows it (`text`) and as it was written. */
export function readFileText(content: string): { format: FileFormat; text: string } {
  const bom = content.startsWith(BOM);
  const text = bom ? content.slice(BOM.length) : content;
  return { format: { bom, crlf: text.includes("\r\n") }, text };
}

/** What a save writes for the editor's `doc`: every line break the file's own. */
export function writeFileText(format: FileFormat, doc: Text): string {
  const text = doc.sliceString(0, doc.length, format.crlf ? "\r\n" : "\n");
  return format.bom ? BOM + text : text;
}
