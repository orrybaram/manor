import { useState } from "react";
import type { ChatEntry } from "../../../electron.d";
import { Button } from "../../ui/Button/Button";
import { ChatMarkdown } from "./ChatMarkdown";
import { PlanCard } from "./PlanCard";
import { AnsweredQuestion, QuestionCard } from "./QuestionCard";
import styles from "./ChatPane.module.css";

type ChatEntryViewProps = {
  paneId: string;
  entry: ChatEntry;
  /** The id of the one picker the chat may answer, if any. */
  answerableId: string | null;
  onShowTerminal: () => void;
};

/** One transcript entry, drawn for its kind (ADR-215 D3, D7). */
export function ChatEntryView(props: ChatEntryViewProps) {
  const { paneId, entry, answerableId, onShowTerminal } = props;

  switch (entry.kind) {
    case "user":
      return (
        <div className={styles.userRow}>
          <div className={styles.userBubble} data-testid="chat-user">
            {entry.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className={styles.assistant} data-testid="chat-assistant">
          <ChatMarkdown source={entry.text} />
        </div>
      );
    case "tool":
      return <ToolEntry entry={entry} />;
    case "question":
      return entry.answer === null ? (
        <QuestionCard
          paneId={paneId}
          entry={entry}
          answerable={answerableId === entry.id}
          onShowTerminal={onShowTerminal}
        />
      ) : (
        <AnsweredQuestion entry={entry} />
      );
    case "plan":
      return (
        <PlanCard
          paneId={paneId}
          entry={entry}
          answerable={answerableId === entry.id}
          onShowTerminal={onShowTerminal}
        />
      );
    default:
      return null;
  }
}

type ToolEntryProps = {
  entry: Extract<ChatEntry, { kind: "tool" }>;
};

const STATUS_LABEL = { pending: "running", ok: "done", error: "failed" } as const;

/** A tool call as one line, expanding to its detail on tap. */
function ToolEntry(props: ToolEntryProps) {
  const { entry } = props;

  const [open, setOpen] = useState(false);
  const expandable = Boolean(entry.detail);

  return (
    <div className={styles.tool} data-testid="chat-tool" data-status={entry.status}>
      <Button
        variant="ghost"
        size="sm"
        className={styles.toolLine}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={styles.statusDot}
          data-status={entry.status}
          role="img"
          aria-label={STATUS_LABEL[entry.status]}
        />
        <span className={styles.toolName}>{entry.name}</span>
        <span className={styles.toolSummary}>{entry.summary}</span>
      </Button>
      {open && entry.detail && <pre className={styles.toolDetail}>{entry.detail}</pre>}
    </div>
  );
}
