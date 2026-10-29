import { describe, expect, it } from "vitest";
import { EditorState, Text, type TransactionSpec } from "@codemirror/state";
import { agentEdits, changeMarks, laneMarks, setAgentMarks, setCleanDoc } from "./change-marks";

const doc = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

const text = (s: string) => Text.of(s.split("\n"));

/** An editor showing `shown`, whose clean copy (on disk) is `clean`. */
function editor(clean: string, shown = clean) {
  let state = EditorState.create({ doc: shown, extensions: changeMarks(text(clean)) });
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

  it("places new marks through your unsaved edits, read against the clean copy", () => {
    const ed = editor(doc(10));
    ed.apply({ changes: { from: 0, insert: "mine\n" } });
    // Line 5 on disk is line 6 in the editor now.
    ed.apply({ effects: setAgentMarks.of({ kind: "changed", ranges: [{ from: 5, to: 5 }] }) });
    expect(agentEdits(ed.state)).toEqual([{ from: 6, to: 6 }]);
    expect(ed.state.doc.line(6).text).toBe("line 5");
  });

  it("places marks through a draft the editor opened with", () => {
    const ed = editor(doc(10), `mine\n${doc(10).replace("line 3\n", "")}`);
    ed.apply({
      effects: setAgentMarks.of({
        kind: "changed",
        ranges: [
          { from: 2, to: 2 },
          { from: 8, to: 8 },
        ],
      }),
    });
    expect(agentEdits(ed.state).map((r) => ed.state.doc.line(r.from).text)).toEqual([
      "line 2",
      "line 8",
    ]);
  });

  it("keeps the marks where your edits moved them when the same marks come again", () => {
    const ed = editor(doc(10));
    const marks = { kind: "changed" as const, ranges: [{ from: 5, to: 5 }] };
    ed.apply({ effects: setAgentMarks.of(marks) });
    ed.apply({ changes: { from: 0, insert: "mine\n" } });
    ed.apply({ effects: setAgentMarks.of({ ...marks, ranges: [{ from: 5, to: 5 }] }) });
    expect(agentEdits(ed.state)).toEqual([{ from: 6, to: 6 }]);
  });

  it("puts the marks back on a reloaded file (Reload theirs)", () => {
    const ed = editor(doc(10));
    ed.apply({ effects: setAgentMarks.of({ kind: "changed", ranges: [{ from: 5, to: 6 }] }) });
    ed.apply({ changes: { from: 0, insert: "mine\n" } });
    const theirs = text(doc(12));
    ed.apply({
      changes: { from: 0, to: ed.state.doc.length, insert: theirs },
      effects: setCleanDoc.of(theirs),
    });
    expect(agentEdits(ed.state)).toEqual([{ from: 5, to: 6 }]);
    expect(laneMarks(ed.state)).toEqual([{ from: 5, to: 6, kind: "agent" }]);
  });

  it("keeps the marks where they are on a save", () => {
    const ed = editor(doc(10));
    ed.apply({ effects: setAgentMarks.of({ kind: "changed", ranges: [{ from: 5, to: 5 }] }) });
    ed.apply({ changes: { from: 0, insert: "mine\n" } });
    ed.apply({ effects: setCleanDoc.of(ed.state.doc) });
    expect(agentEdits(ed.state)).toEqual([{ from: 6, to: 6 }]);
  });

  it("marks a new file's lines on disk, not the ones you added since", () => {
    const ed = editor(doc(3), `${doc(3)}\nmine`);
    ed.apply({ effects: setAgentMarks.of({ kind: "added", ranges: [{ from: 1, to: 3 }] }) });
    expect(laneMarks(ed.state).filter((m) => m.kind === "added")).toEqual([
      { from: 1, to: 3, kind: "added" },
    ]);
  });
});
