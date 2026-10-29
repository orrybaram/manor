import { Chunk } from "@codemirror/merge";
import {
  ChangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { LineRange } from "../file-changes";

/**
 * The open file's changed lines (`changed`, from the workspace diff against
 * HEAD) or, for a new file, all of them (`added`). Line numbers are the file's
 * on disk, which the editor's clean copy holds.
 */
export type AgentMarks = { kind: "changed" | "added"; ranges: readonly LineRange[] };

/** The workspace diff was read again: these are the file's marks now. */
export const setAgentMarks = StateEffect.define<AgentMarks | null>();
/** The clean copy changed (a save, a reload): unsaved lines are measured against it. */
export const setCleanDoc = StateEffect.define<Text>();
/** Flash a line (by number) for a moment; null ends the flash. */
export const flashLine = StateEffect.define<number | null>();

/** A run of marked lines the mark lane draws. */
export type LaneMark = { from: number; to: number; kind: "agent" | "mine" };

const agentLine = Decoration.line({ class: "cm-change-agent" });
const addedLine = Decoration.line({ class: "cm-change-added" });
const mineLine = Decoration.line({ class: "cm-change-mine" });
const flashDeco = Decoration.line({ class: "cm-change-flash" });

function lineDecos(doc: Text, lines: Iterable<number>, deco: Decoration): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const n of lines) builder.add(doc.line(n).from, doc.line(n).from, deco);
  return builder.finish();
}

/** Each line number in `ranges` that `doc` has, in order, once. */
function linesIn(doc: Text, ranges: readonly LineRange[]): number[] {
  const out: number[] = [];
  let last = 0;
  for (const { from, to } of ranges) {
    for (let n = Math.max(from, last + 1); n <= Math.min(to, doc.lines); n++) {
      out.push(n);
      last = n;
    }
  }
  return out;
}

function lastContentLine(doc: Text): number {
  return doc.lines > 1 && doc.line(doc.lines).length === 0 ? doc.lines - 1 : doc.lines;
}

/** Whether two sets of marks mark the same lines the same way. */
function sameAgentMarks(a: AgentMarks | null, b: AgentMarks | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.ranges.length !== b.ranges.length) return false;
  return a.ranges.every((r, i) => r.from === b.ranges[i].from && r.to === b.ranges[i].to);
}

/**
 * Where `lines` of `from` are in the text `changes` made of it: each line
 * follows its own start, so text inserted before a line (a new line typed
 * above it) pushes it down. A deleted line lands on what follows it.
 */
function mapLines(from: Text, to: Text, changes: ChangeDesc, lines: readonly number[]): number[] {
  const out: number[] = [];
  for (const n of lines) {
    if (n > from.lines) break;
    const m = to.lineAt(changes.mapPos(from.line(n).from, 1)).number;
    if (m > (out[out.length - 1] ?? 0)) out.push(m);
  }
  return out;
}

/** The changes that turn `clean` into `doc`, from the chunks of their diff. */
function changesFromChunks(clean: Text, doc: Text, chunks: readonly Chunk[]): ChangeSet {
  const specs: { from: number; to: number; insert: string }[] = [];
  for (const chunk of chunks) {
    for (const change of chunk.changes) {
      specs.push({
        from: chunk.fromA + change.fromA,
        to: chunk.fromA + change.toA,
        insert: doc.sliceString(chunk.fromB + change.fromB, chunk.fromB + change.toB),
      });
    }
  }
  return ChangeSet.of(specs, clean.length);
}

type MineState = { clean: Text; chunks: readonly Chunk[]; deco: DecorationSet };

/** Give up on a precise diff of your edits past this long; it falls back to a coarse one. */
const DIFF_TIMEOUT_MS = 50;

function mineState(clean: Text, doc: Text, chunks: readonly Chunk[]): MineState {
  const lines: number[] = [];
  for (const chunk of chunks) {
    const first = doc.lineAt(Math.min(chunk.fromB, doc.length)).number;
    const last = doc.lineAt(Math.min(Math.max(chunk.endB, chunk.fromB), doc.length)).number;
    for (let n = first; n <= last; n++) if (n > (lines[lines.length - 1] ?? 0)) lines.push(n);
  }
  return { clean, chunks, deco: lineDecos(doc, lines, mineLine) };
}

function buildMine(clean: Text, doc: Text): MineState {
  return mineState(clean, doc, Chunk.build(clean, doc, { timeout: DIFF_TIMEOUT_MS }));
}

const mineField = StateField.define<MineState>({
  // `changeMarks` gives it the clean copy; without one, nothing is unsaved.
  create: (state) => mineState(state.doc, state.doc, []),
  update(value, tr) {
    let clean: Text | null = null;
    for (const effect of tr.effects) if (effect.is(setCleanDoc)) clean = effect.value;
    const doc = tr.state.doc;
    if (clean) return buildMine(clean, doc);
    if (!tr.docChanged) return value;
    return mineState(
      value.clean,
      doc,
      Chunk.updateB(value.chunks, value.clean, doc, tr.changes, { timeout: DIFF_TIMEOUT_MS }),
    );
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.deco),
});

type AgentState = {
  /** The last marks the diff sent, kept to place again after a reload. */
  marks: AgentMarks | null;
  /** The marked lines of the doc as it is now, in order. */
  lines: readonly number[];
  deco: DecorationSet;
};

const noAgentMarks: AgentState = { marks: null, lines: [], deco: Decoration.none };

function agentState(marks: AgentMarks | null, doc: Text, lines: readonly number[]): AgentState {
  if (!marks) return noAgentMarks;
  return {
    marks,
    lines,
    deco: lineDecos(doc, lines, marks.kind === "added" ? addedLine : agentLine),
  };
}

/**
 * Place `marks`, whose line numbers are the clean copy's, on the doc: read
 * against the clean copy, then carried through your unsaved edits to where
 * those lines are now.
 */
function placeMarks(marks: AgentMarks | null, mine: MineState, doc: Text): AgentState {
  if (!marks) return noAgentMarks;
  const clean = mine.clean;
  const onClean =
    marks.kind === "added"
      ? linesIn(clean, [{ from: 1, to: lastContentLine(clean) }])
      : linesIn(clean, marks.ranges);
  const lines =
    mine.chunks.length === 0
      ? onClean
      : mapLines(clean, doc, changesFromChunks(clean, doc, mine.chunks), onClean);
  return agentState(marks, doc, lines);
}

const agentField = StateField.define<AgentState>({
  create: () => noAgentMarks,
  update(value, tr) {
    let marks = value.marks;
    let place = false;
    for (const effect of tr.effects) {
      // The same marks again (the diff was read for another file) change nothing.
      if (effect.is(setAgentMarks) && !sameAgentMarks(effect.value, marks)) {
        marks = effect.value;
        place = true;
      }
      // The doc was replaced by a new clean copy (Reload theirs, a clean
      // reload): the old lines went with it, so the marks go on afresh.
      if (effect.is(setCleanDoc) && tr.docChanged) place = true;
    }
    if (place) return placeMarks(marks, tr.state.field(mineField), tr.state.doc);
    if (!tr.docChanged || !value.marks) return value;
    const lines = mapLines(tr.startState.doc, tr.state.doc, tr.changes, value.lines);
    return agentState(value.marks, tr.state.doc, lines);
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.deco),
});

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = tr.docChanged ? deco.map(tr.changes) : deco;
    for (const effect of tr.effects) {
      if (!effect.is(flashLine)) continue;
      const n = effect.value;
      next =
        n === null || n < 1 || n > tr.state.doc.lines
          ? Decoration.none
          : lineDecos(tr.state.doc, [n], flashDeco);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * The gutter bars: changed lines, every line of a new file, and your own
 * unsaved lines (measured against `clean`), as line classes the editor theme
 * draws as a 3px bar at each line's left edge.
 */
export function changeMarks(clean: Text): Extension {
  // The changed lines are placed through your unsaved ones, so those come first.
  return [mineField.init((state) => buildMine(clean, state.doc)), agentField, flashField];
}

/** The line numbers each decoration in `deco` sits on, in order. */
function decoLines(state: EditorState, deco: DecorationSet): number[] {
  const lines: number[] = [];
  deco.between(0, state.doc.length, (from) => {
    lines.push(state.doc.lineAt(from).number);
  });
  return lines;
}

function runs(lines: readonly number[]): LineRange[] {
  const out: LineRange[] = [];
  for (const n of lines) {
    const last = out[out.length - 1];
    if (last && n <= last.to + 1) last.to = Math.max(last.to, n);
    else out.push({ from: n, to: n });
  }
  return out;
}

/**
 * The file's changes as it is now: each run of changed lines, where your
 * edits have moved them. None for a new file, whose every line is new.
 */
export function agentEdits(state: EditorState): LineRange[] {
  const agent = state.field(agentField, false);
  if (agent?.marks?.kind !== "changed") return [];
  return runs(agent.lines);
}

/** A new file's lines as it is now, where your edits have moved them. */
export function addedLines(state: EditorState): LineRange[] {
  const agent = state.field(agentField, false);
  if (agent?.marks?.kind !== "added") return [];
  return runs(agent.lines);
}

/** What the mark lane draws: changed runs and your unsaved runs. */
export function laneMarks(state: EditorState): LaneMark[] {
  const marks: LaneMark[] = [];
  const agent = state.field(agentField, false);
  // A new file is new from top to bottom: the gutter says so, and a lane mark
  // the height of the file would only cover the scrollbar.
  if (agent?.marks && agent.marks.kind !== "added") {
    for (const run of runs(agent.lines)) marks.push({ ...run, kind: "agent" });
  }
  const mine = state.field(mineField, false);
  for (const run of runs(decoLines(state, mine?.deco ?? Decoration.none))) {
    marks.push({ ...run, kind: "mine" });
  }
  return marks;
}
