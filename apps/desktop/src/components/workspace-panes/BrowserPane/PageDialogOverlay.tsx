import { useRef, useState } from "react";
import type { PageDialog } from "../../../../electron/webview-dialogs";
import { Button } from "../../ui/Button/Button";
import styles from "./BrowserPane.module.css";

type PageDialogOverlayProps = {
  dialog: PageDialog;
  /** The site the card names: "<site> says". */
  site: string;
  onAnswer: (ok: boolean, text?: string) => void;
};

/**
 * A page's alert/confirm/prompt, over its own pane only: the page waits on
 * it, the rest of Manor doesn't. Enter accepts, Escape cancels.
 */
export function PageDialogOverlay(props: PageDialogOverlayProps) {
  const { dialog, site, onAnswer } = props;
  const [text, setText] = useState(dialog.defaultText);
  const textRef = useRef(text);
  textRef.current = text;

  const accept = () => onAnswer(true, dialog.type === "prompt" ? textRef.current : undefined);
  const cancel = () => onAnswer(false);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Enter on a focused Cancel is that button's own click.
    const onCancel = (e.target as HTMLElement).closest("[data-page-dialog-cancel]");
    if (e.key === "Enter" && !onCancel) {
      e.preventDefault();
      e.stopPropagation();
      accept();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  return (
    <div className={styles.dialogScrim} data-testid="page-dialog" onKeyDown={onKeyDown}>
      <div
        className={styles.dialogCard}
        role={dialog.type === "alert" ? "alertdialog" : "dialog"}
        aria-modal="false"
        aria-label={`${site} says`}
      >
        <span className={styles.dialogSite}>{site} says</span>
        {dialog.message && <p className={styles.dialogMessage}>{dialog.message}</p>}
        {dialog.type === "prompt" && (
          <input
            className={styles.dialogInput}
            data-testid="page-dialog-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
        <div className={styles.dialogActions}>
          {dialog.type !== "alert" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={cancel}
              data-page-dialog-cancel
              data-testid="page-dialog-cancel"
            >
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={accept}
            autoFocus={dialog.type !== "prompt"}
            data-testid="page-dialog-ok"
          >
            OK
          </Button>
        </div>
      </div>
    </div>
  );
}
