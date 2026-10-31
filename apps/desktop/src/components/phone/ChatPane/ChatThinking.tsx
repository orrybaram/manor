import { useState } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { formatElapsed } from "./chat-entries";
import { GableMark } from "./GableMark";
import { presentVerb } from "./manor-verbs";
import styles from "./ChatPane.module.css";

/** Quiet gaps shorter than this between entries don't show the indicator. */
const SHOW_AFTER_MS = 600;

/** How long each verb stays before the next. */
const VERB_MS = 2_600;

/**
 * The live line under the conversation while Claude works with nothing to
 * show: Manor's mark breathing, a present-tense Manor verb that changes every
 * few seconds ("Tending…", "Polishing…"), and the time so far. The transcript
 * drops thinking text, so a busy agent can otherwise leave the chat silent.
 * Not an entry; `ChatPane` keys it by the newest entry, so it remounts when
 * one arrives and the time counts the current silence. The only part of the
 * chat that ticks.
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

  // Starts where the clock says, so it isn't always the first verb.
  const verb = presentVerb(Math.floor(since / VERB_MS) + Math.floor(elapsed / VERB_MS));
  return (
    <div className={styles.thinking} data-testid="chat-thinking" role="status">
      <GableMark breathing />
      <span className={styles.thinkingVerb} key={verb}>
        {verb}…
      </span>
      <span className={styles.toolElapsed}>{formatElapsed(elapsed / 1000)}</span>
    </div>
  );
}
