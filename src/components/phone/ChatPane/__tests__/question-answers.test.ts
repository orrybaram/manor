/**
 * ADR-215: the question card's selection rules and the `PickerAnswer`s they
 * build, plus the entry list's upsert/merge and "which picker is answerable".
 */
import { describe, expect, it } from "vitest";
import type { ChatEntry, PickerQuestion } from "../../../../electron.d";
import {
  EMPTY_SELECTION,
  answerFor,
  answerSummary,
  answersOnTap,
  buildAnswers,
  chooseOther,
  tapOption,
} from "../question-answers";
import { answerablePickerId, mergeHistory, upsertEntry } from "../chat-entries";

function question(multiSelect: boolean, n = 3): PickerQuestion {
  return {
    question: "Which?",
    header: "Pick",
    multiSelect,
    options: Array.from({ length: n }, (_, i) => ({ label: `o${i}`, description: "" })),
  };
}

describe("question answers", () => {
  it("single-select: a tap picks one option and replaces the last", () => {
    const q = question(false);
    let s = tapOption(q, EMPTY_SELECTION, 1);
    s = tapOption(q, s, 2);
    expect(answerFor(q, s)).toEqual({ kind: "option", indexes: [2] });
    expect(answersOnTap([q])).toBe(true);
  });

  it("multi-select: taps toggle, sorted, and an empty set is incomplete", () => {
    const q = question(true);
    let s = tapOption(q, EMPTY_SELECTION, 2);
    s = tapOption(q, s, 0);
    expect(answerFor(q, s)).toEqual({ kind: "option", indexes: [0, 2] });
    s = tapOption(q, s, 0);
    s = tapOption(q, s, 2);
    expect(answerFor(q, s)).toBeNull();
    expect(answersOnTap([q])).toBe(false);
  });

  it("other: needs non-empty text, trimmed, and replaces any option", () => {
    const q = question(false);
    let s = tapOption(q, EMPTY_SELECTION, 0);
    s = chooseOther(s);
    expect(s.indexes).toEqual([]);
    expect(answerFor(q, s)).toBeNull();
    s = { ...s, other: "  my own  " };
    expect(answerFor(q, s)).toEqual({ kind: "other", text: "my own" });
    // Tapping an option again leaves Other.
    expect(tapOption(q, s, 1)).toEqual({ indexes: [1], other: null });
  });

  it("other is never an answer on a multi-select question", () => {
    expect(answerFor(question(true), { indexes: [], other: "x" })).toBeNull();
  });

  it("two questions: one answer each, in order, only once both are complete", () => {
    const qs = [question(false), question(true)];
    expect(answersOnTap(qs)).toBe(false);
    const first = tapOption(qs[0], EMPTY_SELECTION, 1);
    expect(buildAnswers(qs, [first, EMPTY_SELECTION])).toBeNull();
    const second = tapOption(qs[1], tapOption(qs[1], EMPTY_SELECTION, 0), 2);
    expect(buildAnswers(qs, [first, second])).toEqual([
      { kind: "option", indexes: [1] },
      { kind: "option", indexes: [0, 2] },
    ]);
  });
});

const user = (id: string, text = id): ChatEntry => ({ kind: "user", id, ts: "", text });
const ask = (id: string, answer: string | null): ChatEntry => ({
  kind: "question",
  id,
  ts: "",
  questions: [question(false)],
  answer,
});
const plan = (id: string, outcome: string | null): ChatEntry => ({
  kind: "plan",
  id,
  ts: "",
  plan: "do it",
  outcome,
});

describe("chat entries", () => {
  it("upserts by id in place", () => {
    const list = [user("a"), user("b")];
    expect(upsertEntry(list, user("c")).map((e) => e.id)).toEqual(["a", "b", "c"]);
    const updated = upsertEntry(list, user("a", "edited"));
    expect(updated.map((e) => e.id)).toEqual(["a", "b"]);
    expect(updated[0]).toEqual(user("a", "edited"));
  });

  it("lays history under live entries, appending only the ones it lacks", () => {
    const merged = mergeHistory([user("a"), user("b")], [user("b", "live"), user("c")]);
    expect(merged.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(merged[1]).toEqual(user("b"));
  });

  it("only the newest picker is answerable, and only while open", () => {
    expect(answerablePickerId([ask("q1", null), user("u"), plan("p1", null), user("v")])).toBe("p1");
    expect(answerablePickerId([ask("q1", null), plan("p1", "approved")])).toBeNull();
    expect(answerablePickerId([user("u")])).toBeNull();
  });
});

describe("answerSummary", () => {
  it("pulls the answers out of Claude's result text", () => {
    expect(
      answerSummary('User has answered your questions: "Which?"="Option 3". You can now continue.'),
    ).toBe("Option 3");
    expect(answerSummary('Answered: "Fruit?"="Banana", "Colour?"="Red". Go on.')).toBe("Banana · Red");
  });

  it("falls back to the whole text when the wording changes", () => {
    expect(answerSummary("Picked the third one")).toBe("Picked the third one");
  });
});
