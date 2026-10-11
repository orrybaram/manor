import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import Square from "lucide-react/dist/esm/icons/square";
import { useId, useRef, useState } from "react";
import type { ChatCommand } from "../../../../electron/chat-mirror/builtin-commands";
import { Button } from "../../ui/Button/Button";
import { EmojiTextarea } from "../../ui/EmojiAutocomplete";
import styles from "./ChatPane.module.css";
import { CommandChoiceSheet } from "./CommandChoiceSheet";
import { slashOptionId, splitCommand } from "./slash-commands";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { markChatStarting, startMenuHandoff } from "./usePaneChatView";
import { useSlashCommands } from "./useSlashCommands";

/** Claude Code's `/clear` and its aliases: each starts a new session. */
const CLEAR_COMMANDS = new Set(["clear", "reset", "new"]);

type ChatComposerProps = {
  paneId: string;
  /** Claude is mid-turn: offer Stop. */
  busy: boolean;
  /** The transcript the chat shows, which a `/clear` leaves behind. Absent
   *  while the chat is already fresh. */
  transcript?: string;
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
 * command that opens a TUI menu (`opensMenu`) hands the pane to the
 * terminal, where that menu is, until it closes (ADR-218 D3). Sending `/clear` leaves the old
 * conversation behind for a fresh chat.
 *
 * `data-keyboard-lift` is what `KeyboardLift` looks for: while this has
 * focus, the phone shell is lifted until the composer clears the soft
 * keyboard.
 */
export function ChatComposer(props: ChatComposerProps) {
  const { paneId, busy, transcript } = props;

  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listboxId = `${useId()}-slash-listbox`;

  // The command whose choice sheet is open (ADR-218 D2), and its selected row.
  const [choiceFor, setChoiceFor] = useState<ChatCommand | null>(null);
  const [choiceIndex, setChoiceIndex] = useState(0);
  const choiceListboxId = `${listboxId}-choices`;

  const slash = useSlashCommands(paneId, text, caret);

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

  const pick = (index: number) => {
    const next = slash.pick(index);
    if (!next) return;
    if (next.kind === "choices") {
      setChoiceFor(next.command);
      setChoiceIndex(0);
      return;
    }
    update(next.text, next.caret);
    focusAt(next.caret);
  };

  const sendText = (sent: string) => {
    setSending(true);
    setError(null);
    window.electronAPI.chat.send(paneId, sent).then(
      () => {
        update("", 0);
        setSending(false);
        const command = splitCommand(sent);
        if (command && slash.opensMenu(command.name, command.args)) {
          startMenuHandoff(paneId, command.name, transcript ?? null);
        }
        if (transcript && command && CLEAR_COMMANDS.has(command.name)) {
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

  const chooseValue = (value: string) => {
    if (!choiceFor) return;
    setChoiceFor(null);
    sendText(`/${choiceFor.name} ${value}`);
  };

  const chooseOther = () => {
    if (!choiceFor) return;
    const head = `/${choiceFor.name} `;
    setChoiceFor(null);
    update(head, head.length);
    focusAt(head.length);
  };

  const chooseTerminal = () => {
    if (!choiceFor) return;
    setChoiceFor(null);
    sendText(`/${choiceFor.name}`);
  };

  /** Esc or a tap outside: close the sheet, and keep the `/` menu shut
   *  until the text changes. */
  const dismissChoice = () => {
    setChoiceFor(null);
    slash.close();
  };

  /** Enter on the sheet: the selected choice, "Other…" or the terminal row. */
  const chooseSelected = () => {
    const choices = choiceFor?.choices ?? [];
    if (choiceIndex < choices.length) chooseValue(choices[choiceIndex].value);
    else if (choiceIndex === choices.length) chooseOther();
    else chooseTerminal();
  };

  const stop = () => {
    void window.electronAPI.chat.interrupt(paneId).catch(() => {
      setError("Couldn't stop Claude. Try the terminal.");
    });
  };

  const mode = busy && !text.trim() ? "stop" : "send";

  return (
    <div className={styles.composer} data-keyboard-lift data-testid="chat-composer">
      {choiceFor && (
        <CommandChoiceSheet
          command={choiceFor}
          selectedIndex={choiceIndex}
          listboxId={choiceListboxId}
          onChoose={chooseValue}
          onOther={chooseOther}
          onOpenInTerminal={chooseTerminal}
          onDismiss={dismissChoice}
        />
      )}
      {slash.open && !choiceFor && (
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
          aria-expanded={slash.open || choiceFor !== null}
          aria-controls={choiceFor ? choiceListboxId : slash.open ? listboxId : undefined}
          aria-activedescendant={
            choiceFor
              ? slashOptionId(choiceListboxId, choiceIndex)
              : slash.open
                ? slashOptionId(listboxId, slash.selectedIndex)
                : undefined
          }
          onChange={(e) => {
            // Typing past the sheet drops it.
            setChoiceFor(null);
            update(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => {
            const el = e.currentTarget;
            if (el.selectionStart !== caret) update(el.value, el.selectionStart);
          }}
          onKeyDown={(e) => {
            if (choiceFor && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey && !e.altKey) {
              const rows = (choiceFor.choices?.length ?? 0) + 2;
              let handled = true;
              switch (e.key) {
                case "ArrowDown":
                  setChoiceIndex((choiceIndex + 1) % rows);
                  break;
                case "ArrowUp":
                  setChoiceIndex((choiceIndex + rows - 1) % rows);
                  break;
                case "Enter":
                  chooseSelected();
                  break;
                case "Escape":
                  dismissChoice();
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
