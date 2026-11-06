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

const ESC = "\x1b";
const BEL = "\x07";
/** 8-bit String Terminator, which xterm also accepts. */
const ST8 = "\x9c";

/**
 * Longest unfinished sequence carried to the next chunk. Past this it is
 * something big (an image, a clipboard write), never a query or a title
 * worth reading: dropped.
 */
export const MAX_CARRY = 8 * 1024;

/** CSI `t` (window ops) parameters xterm answers with a report. */
const WINDOW_REPORTS = new Set(["11", "13", "14", "15", "16", "18", "19", "20", "21"]);

/** OSC numbers that set the window title, as xterm's `onTitleChange` hears them. */
const TITLE_OSC = new Set(["0", "2"]);

export interface HeldOutputScan {
  /** A terminal query appeared: the pane must catch up now to answer it. */
  query: boolean;
  /** The last window title set in this chunk, if any. */
  title: string | null;
}

/** Whether a complete CSI sequence (`ESC [` … final) asks for a reply. */
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
    case "t": {
      if (intermediates !== "" || prefix !== "") return false;
      return WINDOW_REPORTS.has(params.split(";")[0] ?? "");
    }
    default:
      return false;
  }
}

/** Whether a complete OSC payload asks for a reply (a `?` field, as in `11;?`). */
function oscIsQuery(ps: string, rest: string): boolean {
  if (TITLE_OSC.has(ps) || ps === "1") return false;
  return rest.split(";").some((field) => field === "?");
}

/** Whether a complete DCS body asks for a reply (DECRQSS `$q`, XTGETTCAP `+q`). */
function dcsIsQuery(body: string): boolean {
  return body.startsWith("$q") || body.startsWith("+q");
}

/**
 * Where the string starting before `from` ends: its body's end, where
 * scanning resumes, and whether a terminator (BEL, `ESC \\` or 8-bit ST)
 * ended it rather than another sequence aborting it. Null if neither has
 * happened yet.
 */
function findStringEnd(
  text: string,
  from: number,
  allowBel: boolean,
): { bodyEnd: number; next: number; ended: boolean } | null {
  for (let j = from; j < text.length; j++) {
    const ch = text[j];
    if (allowBel && ch === BEL) return { bodyEnd: j, next: j + 1, ended: true };
    if (ch === ST8) return { bodyEnd: j, next: j + 1, ended: true };
    if (ch === ESC) {
      if (j + 1 >= text.length) return null;
      // `ESC \` ends it; any other ESC aborts the string, as in xterm.
      const ended = text[j + 1] === "\\";
      return { bodyEnd: j, next: ended ? j + 2 : j, ended };
    }
  }
  return null;
}

/** Scans one pane's held output, chunk by chunk. */
export class HeldOutputScanner {
  private carry = "";

  /** Read `chunk`, after whatever the last chunk left unfinished. */
  scan(chunk: string): HeldOutputScan {
    const text = this.carry + chunk;
    this.carry = "";
    let query = false;
    let title: string | null = null;

    let i = text.indexOf(ESC);
    while (i !== -1) {
      if (i + 1 >= text.length) {
        this.keep(text, i);
        break;
      }
      const kind = text[i + 1];
      let next = i + 2;

      if (kind === "[") {
        // CSI: parameters 0x30–0x3F, intermediates 0x20–0x2F, final 0x40–0x7E.
        let j = i + 2;
        while (j < text.length && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) j++;
        const paramsEnd = j;
        while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
        if (j >= text.length) {
          this.keep(text, i);
          break;
        }
        const code = text.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) {
          if (csiIsQuery(text.slice(i + 2, paramsEnd), text.slice(paramsEnd, j), text[j])) {
            query = true;
          }
          next = j + 1;
        } else {
          next = j; // malformed: resume at the offending byte
        }
      } else if (kind === "]" || kind === "P") {
        const end = findStringEnd(text, i + 2, kind === "]");
        if (!end) {
          this.keep(text, i);
          break;
        }
        // A string another sequence aborted is dropped, as xterm drops it.
        const body = end.ended ? text.slice(i + 2, end.bodyEnd) : null;
        if (body === null) {
          // nothing to read
        } else if (kind === "]") {
          const semi = body.indexOf(";");
          const ps = semi === -1 ? body : body.slice(0, semi);
          const rest = semi === -1 ? "" : body.slice(semi + 1);
          if (TITLE_OSC.has(ps)) title = rest;
          else if (oscIsQuery(ps, rest)) query = true;
        } else if (dcsIsQuery(body)) {
          query = true;
        }
        next = Math.max(end.next, i + 2);
      } else if (kind === "Z") {
        query = true; // DECID: the old form of DA1
      }

      i = text.indexOf(ESC, next);
    }
    return { query, title };
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
