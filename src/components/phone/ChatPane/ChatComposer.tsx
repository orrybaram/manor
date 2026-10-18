import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import ImagePlus from "lucide-react/dist/esm/icons/image-plus";
import Square from "lucide-react/dist/esm/icons/square";
import { useRef, useState, type ClipboardEvent } from "react";
import { uploadPastedImage } from "../../../lib/paste-image-upload";
import { isWebApp } from "../../../lib/platform";
import { Button } from "../../ui/Button/Button";
import { EmojiTextarea } from "../../ui/EmojiAutocomplete";
import styles from "./ChatPane.module.css";
import { ChatStatusLine } from "./ChatStatusLine";
import { CommandChoiceSheet } from "./CommandChoiceSheet";
import { commandEffect, slashOptionId, splitCommand } from "./slash-commands";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { markChatStarting, startMenuHandoff } from "./usePaneChatView";
import { useSlashCommands } from "./useSlashCommands";

// Naming the types (not `image/*`) also has iOS hand over a HEIC photo as JPEG.
const PICKABLE_IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

type ChatComposerProps = {
  paneId: string;
  /** Claude is mid-turn: offer Stop. */
  busy: boolean;
  /** The transcript the chat shows, which a `/clear` leaves behind. Absent
   *  while the chat is already fresh. */
  transcript?: string;
  /** The session's context size, for the status line (ADR-223 D4). */
  contextTokens?: number | null;
  /** Tasks running in the chat, for the status line's chip (ADR-224 D4). */
  runningTasks?: number;
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
  const { paneId, busy, transcript, contextTokens, runningTasks } = props;

  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  // Pastes still uploading; a count, so the first to finish doesn't end the
  // hint for another.
  const [uploads, setUploads] = useState(0);
  const uploading = uploads > 0;
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The latest text and caret, for an upload that finishes after more typing.
  const latest = useRef({ text: "", caret: 0 });

  // Called back from a row of the `/` menu or choice sheet, after this render.
  const slash = useSlashCommands(paneId, text, caret, {
    fill: (nextText, nextCaret) => fill(nextText, nextCaret),
    send: (sent) => sendText(sent),
  });
  const level = slash.level;

  const canSend = text.trim().length > 0 && !sending && !uploading;

  const update = (nextText: string, nextCaret: number) => {
    latest.current = { text: nextText, caret: nextCaret };
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

  // Uploads an image to the pane's host and types its path at `at`, the
  // caret when the image was pasted or picked (ADR-239 D4).
  const attachImage = (file: File, before: string, at: number): Promise<void> => {
    setUploads((n) => n + 1);
    setError(null);
    return uploadPastedImage(paneId, file)
      .then(
        (path) => {
          // The text may have changed during the upload. Insert where the
          // paste was if everything before it is as it was, else at the end;
          // the caret stays where the user left it.
          const now = latest.current;
          const insert = path + " ";
          const anchor =
            now.text.slice(0, at) === before.slice(0, at) ? at : now.text.length;
          const caretAfter =
            now.caret >= anchor ? now.caret + insert.length : now.caret;
          fill(now.text.slice(0, anchor) + insert + now.text.slice(anchor), caretAfter);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : "Couldn't paste image"),
      )
      .finally(() => setUploads((n) => n - 1));
  };

  // In the browser a pasted image is uploaded rather than pasted. Pasted
  // text is left to the textarea.
  const pasteImage = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!isWebApp()) return;
    const data = e.clipboardData;
    if (Array.from(data.types).includes("text/plain")) return;
    const file = Array.from(data.items)
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile();
    if (!file) return;
    e.preventDefault();
    void attachImage(file, text, e.currentTarget.selectionStart ?? text.length);
  };

  // Images picked with the attach button, for phones that can't copy an
  // image (Android). One at a time, so their paths land in the order picked.
  const pickImages = async (files: File[]) => {
    // The textarea keeps its selection after losing focus to the button, and
    // a plain caret move doesn't fire `select`, so `latest` may be behind.
    const el = inputRef.current;
    if (el) latest.current = { text: el.value, caret: el.selectionStart };
    for (const file of files) {
      const now = latest.current;
      await attachImage(file, now.text, now.caret);
    }
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
      {uploading && (
        <div className={styles.composerHint} data-testid="chat-composer-uploading">
          Uploading image…
        </div>
      )}
      {error && <div className={styles.composerError}>{error}</div>}
      <div className={styles.composerField}>
        {isWebApp() && (
          <>
            <Button
              variant="ghost"
              className={styles.composerAttach}
              aria-label="Attach image"
              onClick={() => fileInputRef.current?.click()}
              data-testid="chat-attach"
            >
              <ImagePlus size={18} />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept={PICKABLE_IMAGE_TYPES}
              multiple
              hidden
              data-testid="chat-attach-input"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                void pickImages(files);
              }}
            />
          </>
        )}
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
          onPaste={pasteImage}
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
      <ChatStatusLine contextTokens={contextTokens} runningTasks={runningTasks} />
    </div>
  );
}
