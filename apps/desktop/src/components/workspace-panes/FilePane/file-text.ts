const BOM = "﻿";

/**
 * A file's leading byte-order mark, apart from its text. The editor shows the
 * text only, and a save puts the mark back, so a BOM round-trips unchanged.
 */
export function splitBom(content: string): { bom: boolean; text: string } {
  return content.startsWith(BOM)
    ? { bom: true, text: content.slice(BOM.length) }
    : { bom: false, text: content };
}

export function joinBom(bom: boolean, text: string): string {
  return bom ? BOM + text : text;
}

/** "\r\n" for a file with CRLF line breaks, else null (the editor's default). */
export function lineSeparatorOf(text: string): "\r\n" | null {
  return text.includes("\r\n") ? "\r\n" : null;
}
