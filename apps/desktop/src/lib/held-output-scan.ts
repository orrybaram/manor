/**
 * Reading **held output** without parsing it: is there a terminal query in
 * it, and what title did it last set?
 *
 * A pane that isn't on screen holds its PTY output instead of writing it to
 * xterm (`useTerminalStream`). Two things in that output can't wait for the
 * pane to be shown:
 *
 * - **Queries.** Programs ask the terminal questions (device attributes,
 *   cursor position, background colour, mode and kitty keyboard state) and
 *   only the renderer's xterm answers them. A query found here makes the pane
 *   catch up at once, so the reply goes out on time and is the one xterm
 *   would have sent anyway. Matching leans broad: a false positive costs one
 *   early catch-up, a miss leaves a program waiting.
 * - **Titles.** OSC 0/2 names the pane's tab. Agents set it often, so a
 *   title is read out here and applied without catching up.
 *
 * Sequences split across chunks are carried over: the scanner keeps the
 * unfinished tail of each chunk and reads it with the next.
 */

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
/** 8-bit String Terminator, which xterm also accepts. */
const ST8 = 0x9c;

/** Where a sequence can start: ESC, or an 8-bit DCS, CSI or OSC introducer. */
const INTRODUCER = /[\x1b\x90\x9b\x9d]/g;

/**
 * Longest unfinished sequence carried to the next chunk. Past this it is
 * something big (an image, a clipboard write), never a query or a title
 * worth reading: dropped.
 */
export const MAX_CARRY = 8 * 1024;

/** CSI `t` (window ops) parameters xterm answers with a report. */
const WINDOW_REPORTS = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]);

export interface HeldOutputScan {
  /** A terminal query appeared: the pane must catch up now to answer it. */
  query: boolean;
  /**
   * Each query in the chunk, rewritten whole (7-bit introducers, ESC \\
   * terminators, no stray controls), so it can be written on its own after
   * the output around it was dropped.
   */
  queries: string[];
  /** The last window title set in this chunk, if any. */
  title: string | null;
}

/** A parameter as xterm reads it: a number, sub-parameters after `:` dropped. */
function numberParam(field: string | undefined): number {
  const n = Number((field ?? "").split(":")[0] || "0");
  return Number.isFinite(n) ? n : -1;
}

/** Whether a complete CSI sequence asks for a reply. */
function csiIsQuery(params: string, intermediates: string, final: string): boolean {
  const prefix = /^[<=>?]/.test(params) ? params[0] : "";
  switch (final) {
    case "c": // DA1 / DA2 / DA3
    case "n": // DSR, including ?6n and ?996n
      return intermediates === "";
    case "p": // DECRQM (`CSI Ps $ p`, `CSI ? Ps $ p`)
      return intermediates === "$";
    case "q": // XTVERSION (`CSI > q`); `CSI Ps SP q` is a cursor style
      return prefix === ">" && intermediates === "";
    case "u": // kitty keyboard: query, push, pop, set; bare `CSI u` restores the cursor
      return prefix !== "" && intermediates === "";
    case "S": // XTSMGRAPHICS (`CSI ? Pi ; Pa ; Pv S`), answered by the image addon
      return prefix === "?" && intermediates === "";
    case "t":
      if (intermediates !== "" || prefix !== "") return false;
      return WINDOW_REPORTS.has(numberParam(params.split(";")[0]));
    default:
      return false;
  }
}

type Parsed =
  /** The sequence is complete; scanning resumes at `next`. `query` is the query, rewritten whole. */
  | { done: true; next: number; query: string | null; title: string | null }
  /** It runs past the end of the text: carry it to the next chunk. */
  | { done: false };

const UNFINISHED: Parsed = { done: false };

/** Read a CSI whose parameters start at `from`. C0 controls inside it run without ending it, as in xterm. */
function parseCsi(text: string, from: number): Parsed {
  let params = "";
  let intermediates = "";
  for (let j = from; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === ESC) return { done: true, next: j, query: null, title: null };
    if (c === CAN || c === SUB) return { done: true, next: j + 1, query: null, title: null };
    if (c < 0x20 || c === 0x7f) continue;
    if (c >= 0x30 && c <= 0x3f && intermediates === "") params += text[j];
    else if (c >= 0x20 && c <= 0x2f) intermediates += text[j];
    else if (c >= 0x40 && c <= 0x7e) {
      const query = csiIsQuery(params, intermediates, text[j])
        ? `\x1b[${params}${intermediates}${text[j]}`
        : null;
      return { done: true, next: j + 1, query, title: null };
    } else return { done: true, next: j, query: null, title: null }; // malformed
  }
  return UNFINISHED;
}

/**
 * Read an OSC or DCS string whose body starts at `from`. As in xterm, BEL
 * (OSC only), 8-bit ST and any ESC end it; CAN and SUB abort it; other C0
 * controls inside it are ignored.
 */
function parseString(text: string, from: number, osc: boolean): Parsed {
  let body = "";
  for (let j = from; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === CAN || c === SUB) return { done: true, next: j + 1, query: null, title: null };
    let next = -1;
    if (c === ESC) {
      if (j + 1 >= text.length) return UNFINISHED; // `ESC \` may be split
      next = text[j + 1] === "\\" ? j + 2 : j;
    } else if (c === ST8 || (osc && c === BEL)) {
      next = j + 1;
    }
    if (next !== -1) {
      const read = osc ? readOsc(body) : readDcs(body);
      const query = read.query ? `\x1b${osc ? "]" : "P"}${body}\x1b\\` : null;
      return { done: true, next, query, title: read.title };
    }
    if (c >= 0x20) body += text[j];
  }
  return UNFINISHED;
}

/** An OSC body: a title (OSC 0, 2), or a query (a `?` field, as in `11;?`). */
function readOsc(body: string): { query: boolean; title: string | null } {
  const semi = body.indexOf(";");
  const idText = semi === -1 ? body : body.slice(0, semi);
  const rest = semi === -1 ? "" : body.slice(semi + 1);
  const id = /^\d+$/.test(idText) ? Number(idText) : -1;
  if (id === 0 || id === 2) return { query: false, title: rest };
  if (id === 1) return { query: false, title: null }; // icon name
  return { query: rest.split(";").some((field) => field === "?"), title: null };
}

/** A DCS body: DECRQSS (`$q`) and XTGETTCAP (`+q`) ask for a reply. */
function readDcs(body: string): { query: boolean; title: string | null } {
  return { query: body.startsWith("$q") || body.startsWith("+q"), title: null };
}

/** Scans one pane's held output, chunk by chunk. */
export class HeldOutputScanner {
  private carry = "";

  /** Read `chunk`, after whatever the last chunk left unfinished. */
  scan(chunk: string): HeldOutputScan {
    const text = this.carry + chunk;
    this.carry = "";
    const queries: string[] = [];
    let title: string | null = null;

    INTRODUCER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INTRODUCER.exec(text)) !== null) {
      const i = match.index;
      let parsed: Parsed;
      const c = text.charCodeAt(i);
      if (c === 0x9b) parsed = parseCsi(text, i + 1);
      else if (c === 0x9d) parsed = parseString(text, i + 1, true);
      else if (c === 0x90) parsed = parseString(text, i + 1, false);
      else if (i + 1 >= text.length) parsed = UNFINISHED;
      else {
        const kind = text[i + 1];
        if (kind === "[") parsed = parseCsi(text, i + 2);
        else if (kind === "]") parsed = parseString(text, i + 2, true);
        else if (kind === "P") parsed = parseString(text, i + 2, false);
        // DECID (`ESC Z`) is the old form of DA1; any other escape is one byte.
        else parsed = { done: true, next: i + 2, query: kind === "Z" ? "\x1bZ" : null, title: null };
      }
      if (!parsed.done) {
        this.keep(text, i);
        break;
      }
      if (parsed.query !== null) queries.push(parsed.query);
      if (parsed.title !== null) title = parsed.title;
      INTRODUCER.lastIndex = Math.max(parsed.next, i + 1);
    }
    return { query: queries.length > 0, queries, title };
  }

  /** Forget any unfinished sequence: the output it came from was written or dropped. */
  reset(): void {
    this.carry = "";
  }

  private keep(text: string, from: number): void {
    const rest = text.slice(from);
    this.carry = rest.length <= MAX_CARRY ? rest : "";
  }
}
