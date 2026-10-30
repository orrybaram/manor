import type { LayoutMode } from "../../../hooks/useLayoutMode";
import { ChatComposer } from "./ChatComposer";
import { ChatThinking } from "./ChatThinking";
import styles from "./ChatPane.module.css";
import { useStartingPrompt } from "./usePaneChatView";

type ChatStartingProps = {
  paneId: string;
  /** The pane's **Agent kind**, if known yet. A chat starts only for a kind
   *  in `CHAT_KINDS`, so one not known yet is Claude's, the only such kind. */
  agentKind: string | null;
  /** The terminal is showing instead. */
  hidden: boolean;
  layout?: LayoutMode;
};

/**
 * Holds a new agent pane's chat until its transcript is known.
 * The session's Agent, and with it the transcript, only exists once the
 * first prompt is sent, so this offers the composer: that prompt goes to the
 * pty like any other, and the real `ChatPane` takes over from there. An
 * agent launched with a prompt shows that prompt while it starts.
 */
export function ChatStarting(props: ChatStartingProps) {
  const { paneId, agentKind, hidden, layout = "phone" } = props;
  const prompt = useStartingPrompt(paneId);
  return (
    <div
      className={`${styles.chatPane} ${hidden ? styles.hidden : ""}`}
      data-chat-pane
      data-layout={layout}
      data-testid="chat-starting"
      aria-hidden={hidden || undefined}
    >
      <div className={styles.scroller}>
        <div className={styles.entries}>
          {prompt === null ? (
            <p className={styles.empty}>New conversation. Send a message to start.</p>
          ) : (
            <>
              <div className={styles.userRow}>
                <div className={styles.userBubble} data-testid="chat-user">
                  {prompt}
                </div>
              </div>
              <ChatThinking />
            </>
          )}
        </div>
      </div>
      <ChatComposer paneId={paneId} agentKind={agentKind ?? "claude"} busy={false} />
    </div>
  );
}
