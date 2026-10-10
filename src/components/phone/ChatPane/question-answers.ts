/**
 * What a question card has chosen, and the `PickerAnswer`s it sends
 * (ADR-215 D5). Pure, so the card's rules are pinned by tests.
 *
 * - A single-select question has one option or "Other" with its text.
 * - A multi-select question has any non-empty set of options. It has no
 *   "Other": the encoder refuses free text on a multi-select question.
 */

import type { PickerAnswer, PickerQuestion } from "../../../electron.d";

export type QuestionSelection = {
  /** Chosen option indexes, ascending. */
  indexes: number[];
  /** The "Other…" text, or null when Other isn't chosen. Single-select only. */
  other: string | null;
};

export const EMPTY_SELECTION: QuestionSelection = { indexes: [], other: null };

/** Tap an option: pick it (single-select) or toggle it (multi-select). */
export function tapOption(
  question: PickerQuestion,
  selection: QuestionSelection,
  index: number,
): QuestionSelection {
  if (!question.multiSelect) return { indexes: [index], other: null };
  const indexes = selection.indexes.includes(index)
    ? selection.indexes.filter((i) => i !== index)
    : [...selection.indexes, index].sort((a, b) => a - b);
  return { indexes, other: null };
}

/** Tap "Other…" on a single-select question: it replaces any option. */
export function chooseOther(selection: QuestionSelection): QuestionSelection {
  return { indexes: [], other: selection.other ?? "" };
}

/** The answer one question's selection makes, or null while it is incomplete. */
export function answerFor(
  question: PickerQuestion,
  selection: QuestionSelection,
): PickerAnswer | null {
  if (selection.other !== null) {
    if (question.multiSelect) return null;
    const text = selection.other.trim();
    return text ? { kind: "other", text } : null;
  }
  if (selection.indexes.length === 0) return null;
  if (!question.multiSelect && selection.indexes.length > 1) return null;
  return { kind: "option", indexes: [...selection.indexes] };
}

/** Every question's answer, in order, or null until all of them are complete. */
export function buildAnswers(
  questions: readonly PickerQuestion[],
  selections: readonly QuestionSelection[],
): PickerAnswer[] | null {
  if (questions.length === 0) return null;
  const answers: PickerAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const answer = answerFor(questions[i], selections[i] ?? EMPTY_SELECTION);
    if (!answer) return null;
    answers.push(answer);
  }
  return answers;
}

/**
 * A lone single-select question is answered by the tap itself: there is
 * nothing else to collect, so it needs no Submit. Anything else (several
 * questions, multi-select, Other's text) is collected first.
 */
export function answersOnTap(questions: readonly PickerQuestion[]): boolean {
  return questions.length === 1 && !questions[0].multiSelect;
}

/**
 * The chosen answers out of Claude's tool_result text, which reads
 * `… "question"="answer", "question"="answer". …`. Falls back to the whole
 * text when it doesn't match, since the wording is Claude Code's, not ours.
 */
export function answerSummary(result: string): string {
  const answers = [...result.matchAll(/"(?:[^"\\]|\\.)*"="((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  return answers.length > 0 ? answers.join(" · ") : result;
}
