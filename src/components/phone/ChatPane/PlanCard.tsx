import { useState } from "react";
import type { ChatEntry } from "../../../electron.d";
import { Button } from "../../ui/Button/Button";
import { ChatMarkdown } from "./ChatMarkdown";
import { AnswerInTerminal } from "./AnswerInTerminal";
import { useSendAnswer } from "./useSendAnswer";
import styles from "./ChatPane.module.css";

type PlanEntry = Extract<ChatEntry, { kind: "plan" }>;

/** Longer plans are cut here until expanded. */
const COLLAPSED_LINES = 12;

type PlanCardProps = {
  paneId: string;
  entry: PlanEntry;
  /** Only the newest open picker can be answered (ADR-215 D5). */
  answerable: boolean;
  onShowTerminal: () => void;
};

/**
 * An ExitPlanMode plan. The chat can only approve it: rejecting has no fixed
 * key in Claude Code's dialog (ADR-215 spike findings), so changing the plan
 * happens in the terminal.
 */
export function PlanCard(props: PlanCardProps) {
  const { paneId, entry, answerable, onShowTerminal } = props;

  const [expanded, setExpanded] = useState(false);
  const { phase, send } = useSendAnswer(paneId, entry.id);

  const lines = entry.plan.split("\n");
  const long = lines.length > COLLAPSED_LINES;
  const shown = long && !expanded ? lines.slice(0, COLLAPSED_LINES).join("\n") : entry.plan;
  const open = entry.outcome === null;
  const toTerminal = !answerable || entry.needsTerminal === true || phase === "terminal";

  return (
    <div className={styles.card} data-testid="chat-plan" data-entry-id={entry.id}>
      <div className={styles.cardHeader}>Plan</div>
      <ChatMarkdown source={shown} />
      {long && (
        <Button
          variant="link"
          className={styles.more}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show the whole plan"}
        </Button>
      )}
      {!open ? (
        <div className={styles.answered}>
          <span className={styles.answeredValue}>{entry.outcome}</span>
        </div>
      ) : toTerminal ? (
        <AnswerInTerminal onShowTerminal={onShowTerminal} />
      ) : phase === "sending" || phase === "sent" ? (
        <div className={styles.cardNote}>Approved, waiting for Claude…</div>
      ) : (
        <div className={styles.planActions}>
          <Button
            variant="primary"
            data-testid="chat-plan-approve"
            onClick={() => send({ kind: "plan-approve" })}
          >
            Approve
          </Button>
          <Button onClick={onShowTerminal} data-testid="chat-plan-change">
            Change plan in terminal
          </Button>
        </div>
      )}
    </div>
  );
}
