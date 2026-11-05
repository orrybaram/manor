import { Chunk } from "@codemirror/merge";
import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, showTooltip } from "@codemirror/view";
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

/**
 * The blamed text's line for a position at the start of a line of the editor's
 * text, or null for a line your edits changed. A chunk's B side runs from the
 * start of its first line to the start of the line after its last, so a pure
 * deletion covers no line and the line after it keeps its blame.
 */
function blamedLine({ doc, chunks }: BlameState, pos: number): number | null {
  let shift = 0;
  for (const chunk of chunks) {
    if (pos < chunk.fromB) break;
    if (pos < chunk.toB) return null;
    shift = chunk.toB - chunk.toA;
  }
  const at = pos - shift;
  return at > doc.length ? null : doc.lineAt(at).number;
}

/** The blame of the line starting at `pos`, or undefined with no blame on. */
function blameAt(state: EditorState, pos: number): LineBlame {
  const value = state.field(blameField, false);
  if (!value) return undefined;
  const line = blamedLine(value, pos);
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

/** "3d ago", "5mo ago", "2y ago": the column has no room for a date, and a year matters. */
export function blameAge(seconds: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - seconds * 1000);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365.25)}y ago`;
}

function span(className: string, text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}

/**
 * One line's cell. The first line of a run from one commit says whose it is;
 * the rest of the run stays blank, so a run reads as one block.
 */
class BlameMarker extends GutterMarker {
  constructor(
    readonly commit: BlameCommit | null,
    readonly first: boolean,
  ) {
    super();
    const classes = [];
    if (first) classes.push("cm-blameFirst");
    if (!commit) classes.push("cm-blameNotCommitted");
    this.elementClass = classes.join(" ");
  }

  eq(other: BlameMarker): boolean {
    return this.first === other.first && this.commit?.sha === other.commit?.sha;
  }

  toDOM(): Node {
    const row = document.createElement("span");
    row.className = "cm-blameRow";
    if (!this.first) return row;
    if (!this.commit) {
      row.append(span("cm-blameSummary", NOT_COMMITTED));
      return row;
    }
    row.append(
      span("cm-blameAuthor", this.commit.author),
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
      `${blame.sha} · ${blame.author} · ${new Date(blame.time * 1000).toLocaleString()}`,
    ),
  );
  return dom;
}

const hoverField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setHovered)) return effect.value;
    return tr.docChanged ? null : value;
  },
  provide: (field) =>
    showTooltip.compute([field], (state) => {
      const pos = state.field(field);
      if (pos === null) return null;
      const blame = blameAt(state, pos);
      if (blame === undefined) return null;
      return { pos, create: () => ({ dom: tooltipDom(blame) }) };
    }),
});

const theme = EditorView.theme({
  // The column takes a share of the editor, however narrow the pane.
  "&": { containerType: "inline-size" },
  ".cm-blameGutter": {
    width: "clamp(12ch, 34cqw, 44ch)",
    borderRight: "1px solid var(--border)",
    userSelect: "none",
  },
  ".cm-blameGutter .cm-gutterElement": { overflow: "hidden", padding: "0 8px" },
  ".cm-blameGutter .cm-blameFirst": { boxShadow: "inset 0 1px 0 var(--border)" },
  ".cm-blameRow": { display: "flex", gap: "1ch", whiteSpace: "nowrap" },
  ".cm-blameAuthor, .cm-blameSummary": { overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-blameAuthor": { flex: "0 1 auto", maxWidth: "12ch", color: "var(--text-primary)" },
  ".cm-blameAge": { flex: "none", color: "var(--text-dim)" },
  ".cm-blameSummary": { flex: "1 1 0", minWidth: "0", color: "var(--text-dim)" },
  ".cm-blameNotCommitted .cm-blameSummary": { fontStyle: "italic" },
  ".cm-blameTooltip": {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    maxWidth: "min(480px, 70vw)",
    maxHeight: "40vh",
    overflow: "auto",
    padding: "6px 8px",
  },
  ".cm-blameMessage": { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  ".cm-blameMeta": { color: "var(--text-dim)", overflowWrap: "anywhere" },
});

/**
 * A column left of the line numbers saying which commit each line came from,
 * which your unsaved edits carry along: a line you changed reads "Not
 * committed yet" until you undo it, and the others stay on their commits. It
 * draws its own column and leaves the change marks to the lines themselves.
 * Hovering a line shows its commit in full.
 */
export function blameGutter(blame: FileBlame, doc: Text): Extension {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return [
    blameField.init((state) => blameState(blame, doc, state.doc)),
    hoverField,
    gutter({
      class: "cm-blameGutter",
      lineMarker(view, line) {
        const here = blameAt(view.state, line.from);
        if (here === undefined) return null;
        const number = view.state.doc.lineAt(line.from).number;
        const above = number > 1 ? lineBlame(view.state, number - 1) : undefined;
        return new BlameMarker(here, above === undefined || above?.sha !== here?.sha);
      },
      lineMarkerChange: (update) =>
        update.docChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(setBlame))),
      domEventHandlers: {
        mousemove(view, line) {
          clearTimeout(timer);
          const hovered = view.state.field(hoverField);
          if (hovered === line.from) return false;
          // Already showing one: the next line's follows without another wait.
          const show = () => view.dispatch({ effects: setHovered.of(line.from) });
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
