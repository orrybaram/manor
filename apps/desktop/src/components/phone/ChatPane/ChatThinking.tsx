import { useState } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import styles from "./ChatPane.module.css";

/** Quiet gaps shorter than this between entries don't show the indicator. */
const SHOW_AFTER_MS = 600;

/**
 * "Thinking" under the conversation while Claude works with nothing to show:
 * the transcript drops thinking blocks, so a busy agent can otherwise leave
 * the chat silent. Not an entry; `ChatPane` keys it by the newest entry, so
 * it remounts when one arrives and the time counts the current silence.
 */
export function ChatThinking() {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useMountEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(tick);
  });

  const elapsed = now - since;
  if (elapsed < SHOW_AFTER_MS) return null;

  return (
    <div className={styles.thinking} data-testid="chat-thinking" role="status">
      <span className={styles.thinkingLabel}>Thinking</span>
      <span className={styles.toolElapsed}>{Math.floor(elapsed / 1000)}s</span>
    </div>
  );
}
