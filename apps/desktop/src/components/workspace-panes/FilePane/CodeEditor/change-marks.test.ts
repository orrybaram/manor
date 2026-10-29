import { describe, expect, it } from "vitest";
import { EditorState, Text, type TransactionSpec } from "@codemirror/state";
import { agentEdits, changeMarks, laneMarks, setAgentMarks, setCleanDoc } from "./change-marks";

const doc = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

function editor(text: string) {
  let state = EditorState.create({ doc: text, extensions: changeMarks(Text.of(text.split("\n"))) });
  return {
    get state() {
      return state;
    },
    apply(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  };
}

describe("change marks", () => {
  it("has the agent's edits as runs of changed lines", () => {
    const ed = editor(doc(10));
    ed.apply({
      effects: setAgentMarks.of({
        kind: "changed",
        ranges: [
          { from: 2, to: 3 },
          { from: 7, to: 7 },
        ],
      }),
    });
    expect(agentEdits(ed.state)).toEqual([
      { from: 2, to: 3 },
      { from: 7, to: 7 },
    ]);
    expect(laneMarks(ed.state)).toEqual([
      { from: 2, to: 3, kind: "agent" },
      { from: 7, to: 7, kind: "agent" },
    ]);
  });

  it("drops lines past the end of the file", () => {
    const ed = editor(doc(3));
    ed.apply({ effects: setAgentMarks.of({ kind: "changed", ranges: [{ from: 3, to: 9 }] }) });
    expect(agentEdits(ed.state)).toEqual([{ from: 3, to: 3 }]);
  });

  it("moves the agent's edits with your typing, and marks your lines", () => {
    const ed = editor(doc(10));
    ed.apply({ effects: setAgentMarks.of({ kind: "changed", ranges: [{ from: 5, to: 5 }] }) });
    ed.apply({ changes: { from: 0, insert: "mine\n" } });
    expect(agentEdits(ed.state)).toEqual([{ from: 6, to: 6 }]);
    expect(laneMarks(ed.state)).toEqual([
      { from: 6, to: 6, kind: "agent" },
      { from: 1, to: 1, kind: "mine" },
    ]);
  });

  it("forgets your lines once the clean copy matches them (a save)", () => {
    const ed = editor(doc(4));
    ed.apply({ changes: { from: 0, insert: "mine\n" } });
    expect(laneMarks(ed.state).filter((m) => m.kind === "mine")).toHaveLength(1);
    ed.apply({ effects: setCleanDoc.of(ed.state.doc) });
    expect(laneMarks(ed.state)).toEqual([]);
  });

  it("marks no line of yours when an edit is undone by hand", () => {
    const ed = editor(doc(4));
    ed.apply({ changes: { from: 0, insert: "x" } });
    ed.apply({ changes: { from: 0, to: 1 } });
    expect(laneMarks(ed.state)).toEqual([]);
  });

  it("marks the whole of a new file, with no edits to jump between", () => {
    const ed = editor(doc(5));
    ed.apply({ effects: setAgentMarks.of({ kind: "added", ranges: [{ from: 1, to: 5 }] }) });
    expect(agentEdits(ed.state)).toEqual([]);
    expect(laneMarks(ed.state)).toEqual([{ from: 1, to: 5, kind: "added" }]);
  });

  it("clears the agent's marks when the file is no longer changed", () => {
    const ed = editor(doc(5));
    ed.apply({ effects: setAgentMarks.of({ kind: "changed", ranges: [{ from: 1, to: 1 }] }) });
    ed.apply({ effects: setAgentMarks.of(null) });
    expect(laneMarks(ed.state)).toEqual([]);
  });
});
