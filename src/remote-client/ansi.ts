/**
 * ANSI → DOM.
 *
 * `POST /sessions/read` can hand back the session's screen exactly as the
 * terminal drew it, escape sequences and all. Stripping that down to plain
 * text loses the thing that makes a transcript readable at a glance: an
 * agent's diffs, its errors, and its prompts are told apart by colour long
 * before they are read. So the client renders the escapes rather than
 * discarding them.
 *
 * Only SGR (`ESC [ … m`) is interpreted. Everything else an emulator would act
 * on — cursor moves, erases, mode switches, OSC titles — is dropped, because
 * what arrives here is already a *rendered screen* from the daemon's headless
 * emulator, not a live stream to be replayed.
 *
 * Colours are set through `element.style`, which CSP governs markup for, not
 * the CSSOM. The palette is Manor's own.
 */

const ESC = "\u001b";
const BEL = "\u0007";

/** Catppuccin Mocha, matching `DEFAULT_THEME` in `electron/theme.ts`. */
const PALETTE = [
  "#45475a",
  "#f38ba8",
  "#a6e3a1",
  "#f9e2af",
  "#89b4fa",
  "#f5c2e7",
  "#94e2d5",
  "#a6adc8",
  "#585b70",
  "#f37799",
  "#89d88b",
  "#ebd391",
  "#74a8fc",
  "#f2aede",
  "#6bd7ca",
  "#bac2de",
];

const DEFAULT_FG = "var(--term-fg)";
const DEFAULT_BG = "var(--term-bg)";

interface Style {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

function blank(): Style {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

function isPlain(style: Style): boolean {
  return (
    style.fg === null &&
    style.bg === null &&
    !style.bold &&
    !style.dim &&
    !style.italic &&
    !style.underline &&
    !style.inverse
  );
}

/** One of the 256 indexed colours: 16 named, a 6×6×6 cube, then 24 greys. */
function indexedColor(index: number): string | null {
  if (index < 0 || index > 255) return null;
  if (index < 16) return PALETTE[index];
  if (index < 232) {
    const n = index - 16;
    const step = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    const r = step(Math.floor(n / 36));
    const g = step(Math.floor(n / 6) % 6);
    const b = step(n % 6);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const grey = 8 + (index - 232) * 10;
  return `rgb(${grey}, ${grey}, ${grey})`;
}

/**
 * Apply one SGR sequence's parameters. The returned style holds until the next
 * sequence, which is how a terminal models this.
 */
function applySgr(style: Style, params: number[]): Style {
  const next = { ...style };
  for (let i = 0; i < params.length; i++) {
    const code = params[i];
    if (code === 0) Object.assign(next, blank());
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code >= 30 && code <= 37) next.fg = PALETTE[code - 30];
    else if (code === 39) next.fg = null;
    else if (code >= 40 && code <= 47) next.bg = PALETTE[code - 40];
    else if (code === 49) next.bg = null;
    else if (code >= 90 && code <= 97) next.fg = PALETTE[code - 90 + 8];
    else if (code >= 100 && code <= 107) next.bg = PALETTE[code - 100 + 8];
    else if (code === 38 || code === 48) {
      // Extended colour: `5;<index>` or `2;<r>;<g>;<b>`, consumed inline.
      const target = code === 38 ? "fg" : "bg";
      if (params[i + 1] === 5) {
        next[target] = indexedColor(params[i + 2]);
        i += 2;
      } else if (params[i + 1] === 2) {
        const r = params[i + 2] || 0;
        const g = params[i + 3] || 0;
        const b = params[i + 4] || 0;
        next[target] = `rgb(${r}, ${g}, ${b})`;
        i += 4;
      }
    }
  }
  return next;
}

function styledNode(text: string, style: Style): Node {
  if (isPlain(style)) return document.createTextNode(text);

  const span = document.createElement("span");
  span.textContent = text;
  const fg = style.fg ?? DEFAULT_FG;
  const bg = style.bg ?? DEFAULT_BG;
  // Inverse is a swap, not a colour of its own — which is why it needs both
  // defaults resolved above and not just the explicitly-set half.
  span.style.color = style.inverse ? bg : fg;
  if (style.inverse || style.bg !== null) {
    span.style.background = style.inverse ? fg : bg;
  }
  if (style.bold) span.style.fontWeight = "600";
  if (style.dim) span.style.opacity = "0.6";
  if (style.italic) span.style.fontStyle = "italic";
  if (style.underline) span.style.textDecoration = "underline";
  return span;
}

/** Where a CSI sequence ends: parameters, then intermediates, then a final byte. */
function endOfCsi(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code >= 0x20 && code <= 0x3f) i++;
    else return i;
  }
  return i;
}

/** Where an OSC sequence ends: BEL, or ST (`ESC \`). */
function endOfOsc(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === BEL) return i;
    if (text[i] === ESC && text[i + 1] === "\\") return i + 1;
  }
  return text.length;
}

/** Render `text` into `into`, replacing whatever was there. */
export function renderAnsi(text: string, into: HTMLElement): void {
  const nodes: Node[] = [];
  let style = blank();
  let buffer = "";

  const flush = () => {
    if (!buffer) return;
    nodes.push(styledNode(buffer, style));
    buffer = "";
  };

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ESC) {
      buffer += text[i];
      continue;
    }
    flush();

    const kind = text[i + 1];
    if (kind === "[") {
      const end = endOfCsi(text, i + 2);
      if (text[end] === "m") {
        const params = text
          .slice(i + 2, end)
          .split(";")
          .map((part) => (part === "" ? 0 : Number(part)))
          .filter((n) => Number.isFinite(n));
        style = applySgr(style, params.length ? params : [0]);
      }
      i = end;
    } else if (kind === "]") {
      i = endOfOsc(text, i + 2);
    } else {
      // A two- or three-byte escape (charset selection, `ESC c`, …).
      i += 1;
    }
  }
  flush();

  into.replaceChildren(...nodes);
}

/**
 * Trim the blank rows a serialized *screen* carries.
 *
 * The daemon renders a fixed grid, so an agent sitting at a prompt hands back
 * its output followed by however many rows are left over — which on a phone is
 * a screenful of nothing under the last line anyone cares about.
 */
export function trimBlankRows(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && stripSgr(lines[end - 1]).trim() === "") end--;
  return lines.slice(0, end).join("\n");
}

function stripSgr(line: string): string {
  return line.replace(/\u001b\[[\d;]*m/g, "");
}
