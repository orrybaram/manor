import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import Square from "lucide-react/dist/esm/icons/square";
import { useId, useRef, useState } from "react";
import { Button } from "../../ui/Button/Button";
import { EmojiTextarea } from "../../ui/EmojiAutocomplete";
import styles from "./ChatPane.module.css";
import { firstWordCommand, slashOptionId } from "./slash-commands";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { setPaneChatView } from "./usePaneChatView";
import { useSlashCommands } from "./useSlashCommands";

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
 * Typing `/` at the start opens the command menu (ADR-217 D5). Sending a
 * command that opens a TUI menu (`interactive`) switches the pane to the
 * terminal, where that menu is.
 *
 * `data-keyboard-lift` is what `KeyboardLift` looks for: while this has
 * focus, the phone shell is lifted until the composer clears the soft
 * keyboard.
 */
export function ChatComposer(props: ChatComposerProps) {
  const { paneId, busy } = props;

  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listboxId = `${useId()}-slash-listbox`;

  const slash = useSlashCommands(paneId, text, caret);

  const canSend = text.trim().length > 0 && !sending;

  const update = (nextText: string, nextCaret: number) => {
    setText(nextText);
    setCaret(nextCaret);
    slash.sync(nextText, nextCaret);
  };

  const pick = (index: number) => {
    const next = slash.pick(index);
    if (!next) return;
    update(next.text, next.caret);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const send = () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const sent = text.trimEnd();
    window.electronAPI.chat.send(paneId, sent).then(
      () => {
        update("", 0);
        setSending(false);
        const command = firstWordCommand(sent);
        if (command && slash.isInteractive(command)) setPaneChatView(paneId, "terminal");
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
      {slash.open && (
        <SlashCommandMenu
          listboxId={listboxId}
          items={slash.items}
          selectedIndex={slash.selectedIndex}
          skillsKnown={slash.skillsKnown}
          onPick={pick}
        />
      )}
      {error && <div className={styles.composerError}>{error}</div>}
      <div className={styles.composerField}>
        <EmojiTextarea
          ref={inputRef}
          className={styles.composerInput}
          value={text}
          rows={1}
          placeholder="Type / for commands"
          aria-label="Message Claude"
          data-testid="chat-composer-input"
          aria-expanded={slash.open}
          aria-controls={slash.open ? listboxId : undefined}
          aria-activedescendant={
            slash.open ? slashOptionId(listboxId, slash.selectedIndex) : undefined
          }
          onChange={(e) => update(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onSelect={(e) => {
            const el = e.currentTarget;
            if (el.selectionStart !== caret) update(el.value, el.selectionStart);
          }}
          onKeyDown={(e) => {
            if (slash.open && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey) {
              let handled = true;
              switch (e.key) {
                case "ArrowDown":
                  slash.move(1);
                  break;
                case "ArrowUp":
                  slash.move(-1);
                  break;
                case "Enter":
                case "Tab":
                  pick(slash.selectedIndex);
                  break;
                case "Escape":
                  slash.close();
                  break;
                default:
                  handled = false;
              }
              if (handled) {
                e.preventDefault();
                e.stopPropagation();
                return;
              }
            }
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
