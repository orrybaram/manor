/**
 * Keystrokes that answer Claude Code's pickers from outside its TUI
 * (ADR-215 D5). The chat view writes these into the agent's PTY.
 *
 * Established by `scripts/spike-picker-keys.mjs` against Claude Code 2.1.296
 * (2026-10-10). Rerun it when Claude Code's picker changes, and re-pin here.
 *
 * AskUserQuestion, as observed:
 * - Options are a list with the cursor on the first. After the options come
 *   "Type something." (free text) and "Chat about this".
 * - Single-select: Down×i then Enter selects option i. With one question,
 *   that alone answers it.
 * - "Other": Down×options.length lands on "Type something.". Typing goes
 *   straight into it, and Enter answers.
 * - Multi-select: Enter toggles the option under the cursor. Tab moves to
 *   the next tab (the "Submit" tab after the last question).
 * - Several questions: the picker shows a tab per question plus a "Submit"
 *   tab. Enter on a single-select question answers it and advances. On the
 *   Submit tab, Enter submits.
 *
 * ExitPlanMode, as observed: option 1 approves, so Enter approves. The
 * dialog has two shapes: "Ready to code?" with three options when there is a
 * plan, and "Exit plan mode?" (Yes / No) without one. Its options also depend
 * on the session's permission mode. So rejecting has no fixed index, and the
 * chat sends rejections to the terminal rather than guess.
 *
 * Not verified, so refused: free text on a multi-select question.
 */

export interface PickerQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export type PickerAnswer =
  | { kind: "option"; indexes: number[] }
  | { kind: "other"; text: string };

const DOWN = "\x1b[B";
const ENTER = "\r";
const TAB = "\t";

/** Free text as the picker's text field should receive it: one line, no control bytes. */
function sanitizeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();
}

function encodeOne(q: PickerQuestion, a: PickerAnswer, n: number): string {
  if (a.kind === "other") {
    if (q.multiSelect) {
      throw new Error(`question ${n}: free text on a multi-select question is not supported`);
    }
    const text = sanitizeText(a.text);
    if (!text) throw new Error(`question ${n}: empty free-text answer`);
    return DOWN.repeat(q.options.length) + text + ENTER;
  }

  const indexes = [...new Set(a.indexes)].sort((x, y) => x - y);
  if (indexes.length === 0) throw new Error(`question ${n}: no option chosen`);
  for (const i of indexes) {
    if (!Number.isInteger(i) || i < 0 || i >= q.options.length) {
      throw new Error(`question ${n}: option index ${i} out of range`);
    }
  }

  if (!q.multiSelect) {
    if (indexes.length > 1) throw new Error(`question ${n}: single-select question given ${indexes.length} options`);
    return DOWN.repeat(indexes[0]) + ENTER;
  }

  // Toggle each choice walking down from the top, then Tab to the next tab.
  let out = "";
  let cursor = 0;
  for (const i of indexes) {
    out += DOWN.repeat(i - cursor) + ENTER;
    cursor = i;
  }
  return out + TAB;
}

/** The bytes that answer an AskUserQuestion picker. Throws on an answer the picker can't take. */
export function encodePickerAnswer(questions: PickerQuestion[], answers: PickerAnswer[]): string {
  if (questions.length === 0) throw new Error("no questions");
  if (answers.length !== questions.length) {
    throw new Error(`expected ${questions.length} answers, got ${answers.length}`);
  }
  const body = questions.map((q, i) => encodeOne(q, answers[i], i + 1)).join("");
  // A lone single-select question is answered by its Enter; anything else
  // ends on the Submit tab, which takes one more Enter.
  const needsSubmit = questions.length > 1 || questions[0].multiSelect;
  return needsSubmit ? body + ENTER : body;
}

/** The bytes that approve an ExitPlanMode dialog (option 1 in every shape seen). */
export function encodePlanApproval(): string {
  return ENTER;
}
