import { splitPrompt } from "./chat-entries";
import styles from "./ChatPane.module.css";

/**
 * A prompt as the chat draws it. One the transcript doesn't hold yet draws the
 * same as one it does, so it doesn't move when its line lands.
 */
export function UserBubble({ text }: { text: string }) {
  return (
    <div className={styles.userRow}>
      <div className={styles.userBubble} data-testid="chat-user">
        <UserPrompt text={text} />
      </div>
    </div>
  );
}

/** The prompt's text, with each paste folded to a "Pasted N lines" row. */
function UserPrompt({ text }: { text: string }) {
  const parts = splitPrompt(text);
  if (parts.length === 1 && parts[0].kind === "typed") return <>{text}</>;
  return (
    <div className={styles.userParts}>
      {parts.map((part, i) =>
        part.kind === "typed" ? (
          <div key={i}>{part.text}</div>
        ) : (
          <details key={i} className={styles.pasted} data-testid="chat-pasted">
            <summary className={styles.pastedSummary}>
              Pasted {lineCount(part.text)}
            </summary>
            <div className={styles.pastedText}>{part.text}</div>
          </details>
        ),
      )}
    </div>
  );
}

function lineCount(text: string): string {
  const lines = text.split("\n").length;
  return lines === 1 ? "1 line" : `${lines} lines`;
}
