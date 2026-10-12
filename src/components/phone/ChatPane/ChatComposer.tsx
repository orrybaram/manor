import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import Square from "lucide-react/dist/esm/icons/square";
import { useRef, useState } from "react";
import { Button } from "../../ui/Button/Button";
import { EmojiTextarea } from "../../ui/EmojiAutocomplete";
import styles from "./ChatPane.module.css";
import { ChatStatusLine } from "./ChatStatusLine";
import { CommandChoiceSheet } from "./CommandChoiceSheet";
import { commandEffect, slashOptionId, splitCommand } from "./slash-commands";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { markChatStarting, startMenuHandoff } from "./usePaneChatView";
import { useSlashCommands } from "./useSlashCommands";

type ChatComposerProps = {
  paneId: string;
  /** Claude is mid-turn: offer Stop. */
  busy: boolean;
  /** The transcript the chat shows, which a `/clear` leaves behind. Absent
   *  while the chat is already fresh. */
  transcript?: string;
  /** The session's context size, for the status line (ADR-223 D4). */
  contextTokens?: number | null;
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
 * command that opens a TUI menu (`commandEffect`) hands the pane to the
 * terminal, where that menu is, until it closes (ADR-218 D3). Sending `/clear` leaves the old
 * conversation behind for a fresh chat.
 *
 * `data-keyboard-lift` is what `KeyboardLift` looks for: while this has
 * focus, the phone shell is lifted until the composer clears the soft
 * keyboard.
 */
export function ChatComposer(props: ChatComposerProps) {
  const { paneId, busy, transcript, contextTokens } = props;

  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Called back from a row of the `/` menu or choice sheet, after this render.
  const slash = useSlashCommands(paneId, text, caret, {
    fill: (nextText, nextCaret) => fill(nextText, nextCaret),
    send: (sent) => sendText(sent),
  });
  const level = slash.level;

  const canSend = text.trim().length > 0 && !sending;

  const update = (nextText: string, nextCaret: number) => {
    setText(nextText);
    setCaret(nextCaret);
    slash.sync(nextText, nextCaret);
  };

  const focusAt = (position: number) => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(position, position);
    });
  };

  const fill = (nextText: string, nextCaret: number) => {
    update(nextText, nextCaret);
    focusAt(nextCaret);
  };

  const sendText = (sent: string) => {
    setSending(true);
    setError(null);
    window.electronAPI.chat.send(paneId, sent).then(
      () => {
        update("", 0);
        setSending(false);
        const command = splitCommand(sent);
        const effect = commandEffect(command, slash.lookup);
        if (effect === "menu" && command) {
          startMenuHandoff(paneId, command.name, transcript ?? null);
        } else if (effect === "clear" && transcript) {
          markChatStarting(paneId, transcript);
        }
      },
      () => {
        setError("Couldn't send. Try again, or use the terminal.");
        setSending(false);
      },
    );
  };

  const send = () => {
    if (!canSend) return;
    sendText(text.trimEnd());
  };

  const stop = () => {
    void window.electronAPI.chat.interrupt(paneId).catch(() => {
      setError("Couldn't stop Claude. Try the terminal.");
    });
  };

  const mode = busy && !text.trim() ? "stop" : "send";

  return (
    <div className={styles.composer} data-keyboard-lift data-testid="chat-composer">
      {level?.kind === "choices" && <CommandChoiceSheet level={level} />}
      {level?.kind === "commands" && (
        <SlashCommandMenu level={level} skillsKnown={slash.skillsKnown} />
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
          aria-expanded={level !== null}
          aria-controls={level?.listboxId}
          aria-activedescendant={
            level ? slashOptionId(level.listboxId, level.selectedIndex) : undefined
          }
          onChange={(e) => {
            update(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => {
            const el = e.currentTarget;
            if (el.selectionStart !== caret) update(el.value, el.selectionStart);
          }}
          onKeyDown={(e) => {
            if (level && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey) {
              let handled = true;
              switch (e.key) {
                case "ArrowDown":
                  level.move(1);
                  break;
                case "ArrowUp":
                  level.move(-1);
                  break;
                case "Tab":
                  // Tab completes a command; on the sheet it only keeps focus.
                  if (level.kind === "commands") level.activateSelected();
                  break;
                case "Enter":
                  level.activateSelected();
                  break;
                case "Escape":
                  level.dismiss();
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
      <ChatStatusLine contextTokens={contextTokens} />
    </div>
  );
}
