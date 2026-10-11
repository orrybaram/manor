import { ChatComposer } from "./ChatComposer";
import styles from "./ChatPane.module.css";

type ChatStartingProps = {
  paneId: string;
  /** The terminal is showing instead. */
  hidden: boolean;
};

/**
 * Holds a new Claude pane's chat on a phone until its transcript is known.
 * The session's Agent, and with it the transcript, only exists once the
 * first prompt is sent, so this offers the composer: that prompt goes to the
 * pty like any other, and the real `ChatPane` takes over from there.
 */
export function ChatStarting(props: ChatStartingProps) {
  const { paneId, hidden } = props;
  return (
    <div
      className={`${styles.chatPane} ${hidden ? styles.hidden : ""}`}
      data-chat-pane
      data-testid="chat-starting"
      aria-hidden={hidden || undefined}
    >
      <div className={styles.scroller}>
        <div className={styles.entries}>
          <p className={styles.empty}>New conversation. Send a message to start.</p>
        </div>
      </div>
      <ChatComposer paneId={paneId} busy={false} />
    </div>
  );
}
