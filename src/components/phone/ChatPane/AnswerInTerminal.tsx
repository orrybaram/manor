import { Button } from "../../ui/Button/Button";
import styles from "./ChatPane.module.css";

type AnswerInTerminalProps = {
  onShowTerminal: () => void;
};

/** What a picker card shows when the chat can't answer it (ADR-215 D6). */
export function AnswerInTerminal(props: AnswerInTerminalProps) {
  const { onShowTerminal } = props;

  return (
    <div className={styles.cardFallback} data-testid="chat-answer-in-terminal">
      <span>Answer in terminal</span>
      <Button size="sm" onClick={onShowTerminal}>
        Open terminal
      </Button>
    </div>
  );
}
