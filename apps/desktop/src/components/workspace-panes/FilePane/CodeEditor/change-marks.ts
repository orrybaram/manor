import { Chunk } from "@codemirror/merge";
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { LineRange } from "../file-changes";

/**
 * The open file's lines an agent changed (`changed`, from the workspace diff)
 * or, for a new file, all of them (`added`).
 */
export type AgentMarks = { kind: "changed" | "added"; ranges: readonly LineRange[] };

/** The workspace diff was read again: these are the file's agent marks now. */
export const setAgentMarks = StateEffect.define<AgentMarks | null>();
/** The clean copy changed (a save, a reload): unsaved lines are measured against it. */
export const setCleanDoc = StateEffect.define<Text>();
/** Flash a line (by number) for a moment; null ends the flash. */
export const flashLine = StateEffect.define<number | null>();

/** A run of marked lines the mark lane draws. */
export type LaneMark = { from: number; to: number; kind: "agent" | "added" | "mine" };

const agentLine = Decoration.line({ class: "cm-change-agent" });
const addedLine = Decoration.line({ class: "cm-change-added" });
const mineLine = Decoration.line({ class: "cm-change-mine" });
const flashDeco = Decoration.line({ class: "cm-change-flash" });

type AgentState = { kind: AgentMarks["kind"] | null; deco: DecorationSet };

function lineDecos(doc: Text, lines: Iterable<number>, deco: Decoration): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const n of lines) builder.add(doc.line(n).from, doc.line(n).from, deco);
  return builder.finish();
}

/** Each line number in `ranges` that `doc` has, in order, once. */
function* linesIn(doc: Text, ranges: readonly LineRange[]): Iterable<number> {
  let last = 0;
  for (const { from, to } of ranges) {
    for (let n = Math.max(from, last + 1); n <= Math.min(to, doc.lines); n++) {
      yield n;
      last = n;
    }
  }
}

function allLines(doc: Text): LineRange[] {
  return [{ from: 1, to: doc.lines }];
}

const agentField = StateField.define<AgentState>({
  create: () => ({ kind: null, deco: Decoration.none }),
  update(value, tr) {
    let next = tr.docChanged ? { kind: value.kind, deco: value.deco.map(tr.changes) } : value;
    for (const effect of tr.effects) {
      if (!effect.is(setAgentMarks)) continue;
      const marks = effect.value;
      const doc = tr.state.doc;
      next = !marks
        ? { kind: null, deco: Decoration.none }
        : {
            kind: marks.kind,
            deco:
              marks.kind === "added"
                ? lineDecos(doc, linesIn(doc, allLines(doc)), addedLine)
                : lineDecos(doc, linesIn(doc, marks.ranges), agentLine),
          };
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.deco),
});

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
 * The gutter bars: agent-changed lines, every line of a new file, and your
 * own unsaved lines (measured against `clean`), as line classes the editor
 * theme draws as a 3px bar at each line's left edge.
 */
export function changeMarks(clean: Text): Extension {
  return [agentField, mineField.init((state) => buildMine(clean, state.doc)), flashField];
}

/** The line numbers each decoration in `deco` sits on, in order. */
function decoLines(state: EditorState, deco: DecorationSet): number[] {
  const lines: number[] = [];
  deco.between(0, state.doc.length, (from) => {
    lines.push(state.doc.lineAt(from).number);
  });
  return lines;
}

function runs(lines: number[]): LineRange[] {
  const out: LineRange[] = [];
  for (const n of lines) {
    const last = out[out.length - 1];
    if (last && n <= last.to + 1) last.to = Math.max(last.to, n);
    else out.push({ from: n, to: n });
  }
  return out;
}

/**
 * The agent's edits in the file as it is now: each run of agent-changed
 * lines, where the edits have moved them. None for a new file, whose every
 * line is the agent's.
 */
export function agentEdits(state: EditorState): LineRange[] {
  const agent = state.field(agentField, false);
  if (!agent || agent.kind !== "changed") return [];
  return runs(decoLines(state, agent.deco));
}

/** What the mark lane draws: agent runs, a new file's whole length, and your unsaved runs. */
export function laneMarks(state: EditorState): LaneMark[] {
  const marks: LaneMark[] = [];
  const agent = state.field(agentField, false);
  if (agent?.kind === "added") {
    marks.push({ from: 1, to: state.doc.lines, kind: "added" });
  } else {
    for (const run of agentEdits(state)) marks.push({ ...run, kind: "agent" });
  }
  const mine = state.field(mineField, false);
  for (const run of runs(decoLines(state, mine?.deco ?? Decoration.none))) {
    marks.push({ ...run, kind: "mine" });
  }
  return marks;
}
