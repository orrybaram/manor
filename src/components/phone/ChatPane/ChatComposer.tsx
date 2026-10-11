import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import Square from "lucide-react/dist/esm/icons/square";
import { useState } from "react";
import { Button } from "../../ui/Button/Button";
import { EmojiTextarea } from "../../ui/EmojiAutocomplete";
import styles from "./ChatPane.module.css";

type ChatComposerProps = {
  paneId: string;
  /** Claude is mid-turn: offer Stop. */
  busy: boolean;
};

/**
 * The chat's input (ADR-215 D7): typed text goes to the pane's PTY as a
 * prompt (`chat.send`), and Stop is Esc (`chat.interrupt`).
 *
 * One round button inside the field sends, and turns into Stop while Claude
 * works. Typing mid-turn turns it back into Send, which Claude Code queues,
 * with a smaller Stop beside it.
 *
 * `data-keyboard-lift` is what `KeyboardLift` looks for: while this has
 * focus, the phone shell is lifted until the composer clears the soft
 * keyboard.
 */
export function ChatComposer(props: ChatComposerProps) {
  const { paneId, busy } = props;

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSend = text.trim().length > 0 && !sending;

  const send = () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    window.electronAPI.chat.send(paneId, text).then(
      () => {
        setText("");
        setSending(false);
      },
      () => {
        setError("Couldn't send. Try again, or use the terminal.");
        setSending(false);
      },
    );
  };

  const stop = () => {
    void window.electronAPI.chat.interrupt(paneId).catch(() => {
      setError("Couldn't stop Claude. Try the terminal.");
    });
  };

  const mode = busy && !text.trim() ? "stop" : "send";

  return (
    <div className={styles.composer} data-keyboard-lift data-testid="chat-composer">
      {error && <div className={styles.composerError}>{error}</div>}
      <div className={styles.composerField}>
        <EmojiTextarea
          className={styles.composerInput}
          value={text}
          rows={1}
          placeholder="Message Claude"
          aria-label="Message Claude"
          data-testid="chat-composer-input"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // A hardware keyboard's ⌘/Ctrl+Enter sends; a plain Enter is a
            // new line, as on a phone's own keyboard.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        {busy && mode === "send" && (
          <Button
            variant="ghost"
            className={styles.composerStopSmall}
            aria-label="Stop Claude"
            onClick={stop}
            data-testid="chat-stop"
          >
            <Square size={10} fill="currentColor" />
          </Button>
        )}
        {mode === "stop" ? (
          <Button
            variant="primary"
            className={`${styles.composerButton} ${styles.composerButtonStop}`}
            aria-label="Stop Claude"
            onClick={stop}
            data-testid="chat-stop"
          >
            <Square size={12} fill="currentColor" />
          </Button>
        ) : (
          <Button
            variant="primary"
            className={styles.composerButton}
            aria-label={busy ? "Queue message" : "Send message"}
            disabled={!canSend}
            onClick={send}
            data-testid="chat-send"
          >
            <ArrowUp size={16} strokeWidth={2.5} />
          </Button>
        )}
      </div>
    </div>
  );
}
