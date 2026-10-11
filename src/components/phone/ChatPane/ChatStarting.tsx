import { Button } from "../../ui/Button/Button";
import styles from "./ChatPane.module.css";

type ChatStartingProps = {
  /** The terminal is showing instead. */
  hidden: boolean;
  onShowTerminal: () => void;
};

/**
 * Holds a new Claude pane's chat on a phone until its transcript is known:
 * the session's first hook names it a moment after Claude boots, and the
 * real `ChatPane` takes over from there. Until then the pane opens here
 * rather than on the terminal Claude is booting in.
 */
export function ChatStarting(props: ChatStartingProps) {
  const { hidden, onShowTerminal } = props;
  return (
    <div
      className={`${styles.chatPane} ${hidden ? styles.hidden : ""}`}
      data-testid="chat-starting"
      aria-hidden={hidden || undefined}
    >
      <div className={styles.unavailable}>
        <p>Starting Claude…</p>
        <Button onClick={onShowTerminal}>Show terminal</Button>
      </div>
    </div>
  );
}
