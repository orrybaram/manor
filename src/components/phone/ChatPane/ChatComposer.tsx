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

  return (
    <div className={styles.composer} data-keyboard-lift data-testid="chat-composer">
      {error && <div className={styles.composerError}>{error}</div>}
      <div className={styles.composerRow}>
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
        {busy && (
          <Button variant="danger" onClick={stop} data-testid="chat-stop">
            Stop
          </Button>
        )}
        <Button
          variant="primary"
          disabled={!canSend}
          onClick={send}
          data-testid="chat-send"
        >
          Send
        </Button>
      </div>
    </div>
  );
}
