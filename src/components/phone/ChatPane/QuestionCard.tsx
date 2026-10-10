import { useState } from "react";
import type { ChatEntry, PickerAnswer } from "../../../electron.d";
import { Button } from "../../ui/Button/Button";
import { EmojiInput } from "../../ui/EmojiAutocomplete";
import {
  answerSummary,
  EMPTY_SELECTION,
  answersOnTap,
  buildAnswers,
  chooseOther,
  tapOption,
  type QuestionSelection,
} from "./question-answers";
import { AnswerInTerminal } from "./AnswerInTerminal";
import { useSendAnswer } from "./useSendAnswer";
import styles from "./ChatPane.module.css";

type QuestionEntry = Extract<ChatEntry, { kind: "question" }>;

type QuestionCardProps = {
  paneId: string;
  entry: QuestionEntry;
  /** Only the newest open picker can be answered (ADR-215 D5). */
  answerable: boolean;
  onShowTerminal: () => void;
};

/**
 * An AskUserQuestion Claude is waiting on: a block per question, a button
 * per option, and one `chat.answer` once every question has its answer.
 */
export function QuestionCard(props: QuestionCardProps) {
  const { paneId, entry, answerable, onShowTerminal } = props;

  const { questions } = entry;
  const [selections, setSelections] = useState<QuestionSelection[]>(() =>
    questions.map(() => EMPTY_SELECTION),
  );
  const { phase, send } = useSendAnswer(paneId, entry.id);

  const toTerminal = !answerable || entry.needsTerminal === true || phase === "terminal";
  const disabled = toTerminal || phase === "sending" || phase === "sent";
  const onTap = answersOnTap(questions);
  const answers = buildAnswers(questions, selections);

  const submit = (next: PickerAnswer[] | null) => {
    if (!next || disabled) return;
    send({ kind: "question", answers: next });
  };

  const select = (index: number, selection: QuestionSelection) => {
    setSelections((prev) => prev.map((s, i) => (i === index ? selection : s)));
  };

  return (
    <div className={styles.card} data-testid="chat-question" data-entry-id={entry.id}>
      {questions.map((q, qi) => {
        const selection = selections[qi] ?? EMPTY_SELECTION;
        return (
          <div key={qi} className={styles.question}>
            {q.header && <div className={styles.cardHeader}>{q.header}</div>}
            <div className={styles.questionText}>{q.question}</div>
            <div className={styles.options} role="group" aria-label={q.header || q.question}>
              {q.options.map((opt, oi) => {
                const chosen = selection.indexes.includes(oi);
                return (
                  <Button
                    key={oi}
                    variant={chosen ? "primary" : "secondary"}
                    className={styles.option}
                    disabled={disabled}
                    aria-pressed={onTap ? undefined : chosen}
                    data-testid="chat-question-option"
                    onClick={() => {
                      const next = tapOption(q, selection, oi);
                      select(qi, next);
                      if (onTap) submit(buildAnswers(questions, [next]));
                    }}
                  >
                    <span className={styles.optionLabel}>{opt.label}</span>
                    {opt.description && (
                      <span className={styles.optionDescription}>{opt.description}</span>
                    )}
                  </Button>
                );
              })}
              {!q.multiSelect && (
                <Button
                  variant={selection.other !== null ? "primary" : "secondary"}
                  className={styles.option}
                  disabled={disabled}
                  aria-pressed={selection.other !== null}
                  data-testid="chat-question-other"
                  onClick={() => select(qi, chooseOther(selection))}
                >
                  <span className={styles.optionLabel}>Other…</span>
                </Button>
              )}
              {selection.other !== null && (
                <EmojiInput
                  className={styles.otherInput}
                  value={selection.other}
                  disabled={disabled}
                  placeholder="Your answer"
                  aria-label="Your answer"
                  data-testid="chat-question-other-input"
                  autoFocus
                  onChange={(e) => select(qi, { indexes: [], other: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submit(answers);
                    }
                  }}
                />
              )}
            </div>
          </div>
        );
      })}
      {toTerminal ? (
        <AnswerInTerminal onShowTerminal={onShowTerminal} />
      ) : phase === "sending" || phase === "sent" ? (
        <div className={styles.cardNote}>Answer sent, waiting for Claude…</div>
      ) : (
        !onTap || selections.some((s) => s.other !== null) ? (
          <Button
            variant="primary"
            className={styles.submit}
            disabled={disabled || answers === null}
            data-testid="chat-question-submit"
            onClick={() => submit(answers)}
          >
            Submit
          </Button>
        ) : null
      )}
    </div>
  );
}

type AnsweredQuestionProps = {
  entry: QuestionEntry;
};

/** A question Claude has its answer to, as one compact line. */
export function AnsweredQuestion(props: AnsweredQuestionProps) {
  const { entry } = props;

  const title = entry.questions.map((q) => q.header || q.question).join(" · ");
  return (
    <div className={styles.answered} data-testid="chat-question-answered">
      <span className={styles.answeredTitle}>{title || "Question"}</span>
      <span className={styles.answeredValue}>{answerSummary(entry.answer ?? "")}</span>
    </div>
  );
}
