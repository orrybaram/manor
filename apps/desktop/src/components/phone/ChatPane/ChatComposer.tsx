import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import Square from "lucide-react/dist/esm/icons/square";
import { useRef, useState } from "react";
import { agentChat } from "../../../lib/agent-chat";
import { uploadPastedImage } from "../../../lib/paste-image-upload";
import { Button } from "../../ui/Button/Button";
import { EmojiTextarea } from "../../ui/EmojiAutocomplete";
import { ImageAttachments } from "../../ui/ImageAttachments/ImageAttachments";
import { useImageAttachments } from "../../ui/ImageAttachments/useImageAttachments";
import styles from "./ChatPane.module.css";
import { ChatStatusLine } from "./ChatStatusLine";
import { CommandChoiceSheet } from "./CommandChoiceSheet";
import { commandEffect, slashOptionId, splitCommand } from "./slash-commands";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { markChatStarting, noteSentPrompt, startMenuHandoff } from "./usePaneChatView";
import { useSlashCommands } from "./useSlashCommands";

type ChatComposerProps = {
  paneId: string;
  /** The pane's **Agent kind**: what the composer calls the agent and which
   *  `/` menu it offers (`agentChat`). */
  agentKind: string | null;
  /** The agent is mid-turn: offer Stop. */
  busy: boolean;
  /** The transcript the chat shows, which a `/clear` leaves behind. Absent
   *  while the chat is already fresh. */
  transcript?: string;
  /** The session's context size, for the status line. */
  contextTokens?: number | null;
  /** Tasks running in the chat, for the status line's chip. */
  runningTasks?: number;
};

/**
 * The chat's input: typed text goes to the pane's PTY as a
 * prompt (`chat.send`), and Stop is the agent's interrupt keys
 * (`chat.interrupt`; Esc for Claude).
 *
 * One round button inside the field sends, and turns into Stop while the
 * agent works. Typing mid-turn turns it back into Send, which Claude Code
 * queues; Esc still stops.
 *
 * Typing `/` at the start opens the command menu, for an agent that has one. Sending a
 * command that opens a TUI menu (`commandEffect`) hands the pane to the
 * terminal, where that menu is, until it closes. Sending `/clear` leaves the old
 * conversation behind for a fresh chat.
 *
 * `data-keyboard-lift` is what `KeyboardLift` looks for: while this has
 * focus, the phone shell is lifted until the composer clears the soft
 * keyboard.
 */
export function ChatComposer(props: ChatComposerProps) {
  const { paneId, agentKind, busy, transcript, contextTokens, runningTasks } = props;
  const chatOf = agentChat(agentKind);

  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Called back from a row of the `/` menu or choice sheet, after this render.
  const slash = useSlashCommands(paneId, text, caret, {
    fill: (nextText, nextCaret) => fill(nextText, nextCaret),
    send: (sent) => sendText(sent),
  }, chatOf.commands);
  const level = slash.level;

  const images = useImageAttachments({
    upload: (file) => uploadPastedImage(paneId, file),
    setError,
    buttonClassName: styles.composerAttach,
  });

  const canSend =
    (text.trim().length > 0 || images.hasImages) && !sending && !images.uploading;

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

  const sendText = (sent: string, afterSent?: () => void) => {
    setSending(true);
    setError(null);
    window.electronAPI.chat.send(paneId, sent).then(
      () => {
        update("", 0);
        afterSent?.();
        setSending(false);
        const command = splitCommand(sent);
        const effect = commandEffect(command, slash.lookup, chatOf.clearCommands);
        noteSentPrompt(paneId, sent, busy && effect === null);
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
    sendText(images.withPaths(text), images.clear);
  };

  const stop = () => {
    void window.electronAPI.chat.interrupt(paneId).catch(() => {
      setError(`Couldn't stop ${chatOf.name}. Try the terminal.`);
    });
  };

  const mode = busy && !text.trim() && !images.hasImages ? "stop" : "send";

  return (
    <div className={styles.composer} data-keyboard-lift data-testid="chat-composer">
      {level?.kind === "choices" && <CommandChoiceSheet level={level} />}
      {level?.kind === "commands" && (
        <SlashCommandMenu level={level} skillsKnown={slash.skillsKnown} />
      )}
      {error && <div className={styles.composerError}>{error}</div>}
      <div className={styles.composerField} {...images.dropProps}>
        <ImageAttachments
          attachments={images.attachments}
          onRemove={images.remove}
          className={styles.composerImages}
        />
        {images.attachButton}
        <EmojiTextarea
          ref={inputRef}
          className={styles.composerInput}
          value={text}
          rows={1}
          placeholder={chatOf.commands === "claude" ? "Type / for commands" : `Message ${chatOf.name}`}
          aria-label={`Message ${chatOf.name}`}
          data-testid="chat-composer-input"
          aria-expanded={level !== null}
          aria-controls={level?.listboxId}
          aria-activedescendant={
            level ? slashOptionId(level.listboxId, level.selectedIndex) : undefined
          }
          onChange={(e) => {
            update(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onPaste={images.pasteImage}
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
            // Mid-turn, Esc stops the agent, which the button doesn't
            // offer while there's text to send.
            if (e.key === "Escape" && busy) {
              e.preventDefault();
              stop();
              return;
            }
            // Enter sends and Shift+Enter is a new line. On a touch screen,
            // whose keyboard has no Shift+Enter, Enter is a new line and
            // ⌘/Ctrl+Enter or the button sends.
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            const touch = window.matchMedia?.("(pointer: coarse)").matches ?? false;
            if (e.metaKey || e.ctrlKey || (!touch && !e.shiftKey && !e.altKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
        {mode === "stop" ? (
          <Button
            variant="primary"
            className={`${styles.composerButton} ${styles.composerButtonStop}`}
            aria-label={`Stop ${chatOf.name}`}
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
      <ChatStatusLine contextTokens={contextTokens} runningTasks={runningTasks} />
    </div>
  );
}
