import { Chunk } from "@codemirror/merge";
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  showTooltip,
  type Rect,
} from "@codemirror/view";
import type { BlameCommit, FileBlame } from "../../../../electron.d";

/** A new blame, and the text its line numbers count: the clean copy it was read for. */
export const setBlame = StateEffect.define<{ blame: FileBlame; doc: Text }>();
/** The line under the pointer, by position; null when it left the column. */
const setHovered = StateEffect.define<number | null>();

/** Give up on a precise diff of your edits past this long; it falls back to a coarse one. */
const DIFF_TIMEOUT_MS = 50;
/** How long the pointer rests on the column before a commit shows. */
const HOVER_DELAY_MS = 250;

const NOT_COMMITTED = "Not committed yet";

/**
 * A line's blame: its commit; `null` when it isn't committed yet, on disk or
 * in your unsaved edits; `undefined` past the blame's last line (the empty
 * line after a final newline).
 */
export type LineBlame = BlameCommit | null | undefined;

type BlameState = {
  blame: FileBlame;
  /** The text `blame` counts lines of. */
  doc: Text;
  /** How the editor's text differs from `doc`. Undoing an edit brings its blame back. */
  chunks: readonly Chunk[];
};

function blameState(blame: FileBlame, blamed: Text, doc: Text): BlameState {
  return {
    blame,
    doc: blamed,
    chunks: blamed.eq(doc) ? [] : Chunk.build(blamed, doc, { timeout: DIFF_TIMEOUT_MS }),
  };
}

const blameField = StateField.define<BlameState>({
  // `blameGutter` gives it a blame.
  create: (state) => ({ blame: { commits: [], lines: [] }, doc: state.doc, chunks: [] }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBlame)) return blameState(effect.value.blame, effect.value.doc, tr.state.doc);
    }
    if (!tr.docChanged) return value;
    return {
      ...value,
      chunks: Chunk.updateB(value.chunks, value.doc, tr.state.doc, tr.changes, {
        timeout: DIFF_TIMEOUT_MS,
      }),
    };
  },
});

/** Past this many line pairs, a chunk's lines all count as changed. */
const MAX_ALIGNED_PAIRS = 1_000_000;

/** The numbers of the lines starting in `from`..`to`, which may run one past the end. */
function linesStartingIn(text: Text, from: number, to: number): number[] {
  if (from >= to || from > text.length) return [];
  const first = text.lineAt(from).number;
  const last = text.lineAt(Math.min(to - 1, text.length)).number;
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/**
 * Each of `b`'s lines' match among `a`'s, or null: the longest common
 * subsequence of whole lines, the way git counts a changed line.
 */
function alignLines(a: readonly string[], b: readonly string[]): (number | null)[] {
  const out = new Array<number | null>(b.length).fill(null);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    out[start] = start;
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) out[--endB] = --endA;
  const rows = endA - start;
  const cols = endB - start;
  if (rows === 0 || cols === 0 || rows * cols > MAX_ALIGNED_PAIRS) return out;
  const width = cols + 1;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[start + i] === b[start + j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < rows && j < cols; ) {
    if (a[start + i] === b[start + j]) out[start + j++] = start + i++;
    else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i++;
    else j++;
  }
  return out;
}

/** A chunk's lines of the editor's text, as lines of the blamed text or null, kept per chunk. */
const chunkLines = new WeakMap<Chunk, (number | null)[]>();

function alignedChunk(chunk: Chunk, blamed: Text, doc: Text): (number | null)[] {
  let lines = chunkLines.get(chunk);
  if (lines) return lines;
  const inA = linesStartingIn(blamed, chunk.fromA, chunk.toA);
  const inB = linesStartingIn(doc, chunk.fromB, chunk.toB);
  const aligned = alignLines(
    inA.map((n) => blamed.line(n).text),
    inB.map((n) => doc.line(n).text),
  );
  lines = aligned.map((i) => (i === null ? null : inA[i]));
  chunkLines.set(chunk, lines);
  return lines;
}

/**
 * The blamed text's line for the editor's line starting at `pos`, or null for
 * a line your edits changed. A chunk is wider than its changed lines (Enter on
 * an indented line takes in the next line's indent), so its lines are matched
 * up whole. A pure deletion has no lines of its own, and the line after it
 * keeps its blame.
 */
function blamedLine({ doc: blamed, chunks }: BlameState, doc: Text, pos: number): number | null {
  let shift = 0;
  for (const chunk of chunks) {
    if (pos < chunk.fromB) break;
    if (pos < chunk.toB) {
      const first = doc.lineAt(chunk.fromB).number;
      return alignedChunk(chunk, blamed, doc)[doc.lineAt(pos).number - first] ?? null;
    }
    shift = chunk.toB - chunk.toA;
  }
  const at = pos - shift;
  return at > blamed.length ? null : blamed.lineAt(at).number;
}

/** The blame of the line starting at `pos`, or undefined with no blame on. */
function blameAt(state: EditorState, pos: number): LineBlame {
  const value = state.field(blameField, false);
  if (!value) return undefined;
  const line = blamedLine(value, state.doc, pos);
  if (line === null) return null;
  const index = value.blame.lines[line - 1];
  if (index === undefined) return undefined;
  const commit = value.blame.commits[index];
  return /^0+$/.test(commit.sha) ? null : commit;
}

/** The blame of the editor's line `number` (1-based), where your edits have moved it. */
export function lineBlame(state: EditorState, number: number): LineBlame {
  return blameAt(state, state.doc.line(number).from);
}

/** "3d", "5mo", "2y": the column has no room for a date, and a year matters. */
export function blameAge(seconds: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - seconds * 1000);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365.25)}y`;
}

/** "Orry Baram" is OB, "Claude" is CL, "dependabot[bot]" is DE. */
export function authorInitials(author: string): string {
  const words = author.replace(/\[bot\]$/, "").split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2);
  return letters.toUpperCase();
}

/** Theme colours for authors. Yellow is for lines not committed yet. */
const AUTHOR_COLORS = ["--blue", "--magenta", "--cyan", "--green"];

/** One author's colour, the same wherever they appear. */
export function authorColor(author: string): string {
  let hash = 0;
  for (let i = 0; i < author.length; i++) hash = (hash * 31 + author.charCodeAt(i)) | 0;
  return AUTHOR_COLORS[Math.abs(hash) % AUTHOR_COLORS.length];
}

function span(className: string, text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

/**
 * One line's cell. A bracket in the author's colour spans a run from one
 * commit; the run's first line says what it is, and the rest stay blank, so a
 * run reads as one block.
 */
class BlameMarker extends GutterMarker {
  constructor(
    readonly commit: BlameCommit | null,
    readonly first: boolean,
    readonly last: boolean,
  ) {
    super();
    const classes = [];
    if (first) classes.push("cm-blameFirst");
    if (last) classes.push("cm-blameLast");
    if (!commit) classes.push("cm-blameNotCommitted");
    this.elementClass = classes.join(" ");
  }

  eq(other: BlameMarker): boolean {
    return (
      this.first === other.first &&
      this.last === other.last &&
      this.commit?.sha === other.commit?.sha
    );
  }

  toDOM(): Node {
    const row = document.createElement("span");
    row.className = "cm-blameRow";
    const color = this.commit ? authorColor(this.commit.author) : "--yellow";
    row.style.setProperty("--blame-author", `var(${color})`);
    if (!this.first) return row;
    if (!this.commit) {
      row.append(span("cm-blameSummary", NOT_COMMITTED));
      return row;
    }
    row.append(
      span("cm-blameInitials", authorInitials(this.commit.author)),
      span("cm-blameAge", blameAge(this.commit.time)),
      span("cm-blameSummary", this.commit.summary),
    );
    return row;
  }
}

function tooltipDom(blame: BlameCommit | null): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-blameTooltip";
  dom.dataset.testid = "file-pane-blame-tooltip";
  if (!blame) {
    dom.append(span("cm-blameMessage", NOT_COMMITTED));
    return dom;
  }
  dom.append(
    span("cm-blameMessage", blame.message),
    span(
      "cm-blameMeta",
      `${blame.sha.slice(0, 7)} · ${blame.author} · ${new Date(blame.time * 1000).toLocaleString()}`,
    ),
  );
  return dom;
}

/**
 * Where the hover card goes: under the hovered line and left of the column,
 * next to the pointer, rather than at the start of the line across the pane.
 */
function besideColumn(view: EditorView, pos: number, dom: HTMLElement): Rect {
  const column = view.dom.querySelector(".cm-blameGutter")?.getBoundingClientRect();
  const block = view.lineBlockAt(pos);
  const top = view.documentTop + block.top;
  const width = dom.offsetWidth;
  const left = Math.max(0, (column?.left ?? width) - width - 4);
  return { left, right: left + width, top, bottom: top + block.height };
}

const hoverField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setHovered)) return effect.value;
    return tr.docChanged ? null : value;
  },
  provide: (field) =>
    showTooltip.compute([field, blameField], (state) => {
      const pos = state.field(field);
      if (pos === null) return null;
      const blame = blameAt(state, pos);
      if (blame === undefined) return null;
      return {
        pos,
        create: (view) => {
          const dom = tooltipDom(blame);
          return { dom, getCoords: (at) => besideColumn(view, at, dom) };
        },
      };
    }),
});

const theme = EditorView.theme({
  // The column takes a share of the editor, however narrow the pane.
  "&": { containerType: "inline-size" },
  ".cm-blameGutter": {
    width: "clamp(12ch, 38cqw, 48ch)",
    borderLeft: "1px solid var(--border)",
    userSelect: "none",
  },
  ".cm-blameGutter .cm-gutterElement": { overflow: "hidden", padding: "0" },
  ".cm-blameRow": {
    position: "relative",
    display: "flex",
    gap: "1ch",
    height: "100%",
    padding: "0 8px 0 12px",
    whiteSpace: "nowrap",
  },
  // The bracket, inset at the ends of a run so neighbouring runs stay apart.
  ".cm-blameRow::before": {
    content: '""',
    position: "absolute",
    left: "4px",
    top: "0",
    bottom: "0",
    width: "2px",
    backgroundColor: "var(--blame-author)",
  },
  ".cm-blameFirst .cm-blameRow::before": { top: "3px", borderTopLeftRadius: "2px", borderTopRightRadius: "2px" },
  ".cm-blameLast .cm-blameRow::before": { bottom: "3px", borderBottomLeftRadius: "2px", borderBottomRightRadius: "2px" },
  ".cm-blameInitials": { flex: "none", fontWeight: "600", color: "var(--blame-author)" },
  ".cm-blameAge": { flex: "none", color: "var(--text-dim)" },
  ".cm-blameSummary": {
    flex: "1 1 0",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    color: "var(--text-primary)",
  },
  ".cm-blameNotCommitted .cm-blameSummary": { fontStyle: "italic", color: "var(--text-dim)" },
  ".cm-blameTooltip": {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    width: "max-content",
    maxWidth: "min(420px, 70vw)",
    maxHeight: "40vh",
    overflow: "auto",
    padding: "6px 8px",
  },
  ".cm-blameMessage": { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  ".cm-blameMeta": { color: "var(--text-dim)", overflowWrap: "anywhere" },
});

/**
 * A column right of the code saying which commit each line came from, which
 * your unsaved edits carry along: a line you changed reads "Not committed yet"
 * until you undo it, and the others stay on their commits. On the right, the
 * code stays put as the column comes and goes, and long lines scroll under it.
 * Hovering a line shows its commit in full.
 */
export function blameGutter(blame: FileBlame, doc: Text): Extension {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return [
    blameField.init((state) => blameState(blame, doc, state.doc)),
    hoverField,
    gutter({
      class: "cm-blameGutter",
      side: "after",
      lineMarker(view, line) {
        const { state } = view;
        const here = blameAt(state, line.from);
        if (here === undefined) return null;
        const { doc } = state;
        const differs = (n: number) => {
          if (n < 1 || n > doc.lines) return true;
          const other = lineBlame(state, n);
          return other === undefined || other?.sha !== here?.sha;
        };
        const above = doc.lineAt(line.from).number - 1;
        // A row under hidden lines (a fold, a diff's collapsed stretch) says
        // whose it is: the row above it may be another commit's.
        const hiddenAbove =
          above >= 1 && view.lineBlockAt(line.from - 1).from !== doc.line(above).from;
        return new BlameMarker(
          here,
          hiddenAbove || differs(above),
          differs(doc.lineAt(line.to).number + 1),
        );
      },
      lineMarkerChange: (update) =>
        update.docChanged ||
        // A fold opening or closing changes which rows start a run.
        update.heightChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setBlame))),
      domEventHandlers: {
        mousemove(view, line) {
          clearTimeout(timer);
          const hovered = view.state.field(hoverField);
          if (hovered === line.from) return false;
          // Already showing one: the next line's follows without another wait.
          const { doc } = view.state;
          const show = () => {
            // An edit moved the line while the pointer rested.
            if (view.state.doc === doc) view.dispatch({ effects: setHovered.of(line.from) });
          };
          if (hovered !== null) show();
          else timer = setTimeout(show, HOVER_DELAY_MS);
          return false;
        },
        mouseleave(view) {
          clearTimeout(timer);
          if (view.state.field(hoverField) !== null) view.dispatch({ effects: setHovered.of(null) });
          return false;
        },
      },
    }),
    ViewPlugin.define(() => ({ destroy: () => clearTimeout(timer) })),
    theme,
  ];
}
