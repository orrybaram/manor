import type { ReactNode } from "react";
import styles from "./FallbackScreen.module.css";

type FallbackScreenProps = {
  title: string;
  message?: ReactNode;
  /** Buttons, left to right. */
  actions?: ReactNode;
  /** Fill the whole window (a root failure) rather than its container. */
  fullWindow?: boolean;
  "data-testid"?: string;
};

/**
 * A failure that replaces a whole surface: a crashed pane, a window that
 * could not load. A stopgap until #327's `<InlineError>` lands.
 */
export function FallbackScreen(props: FallbackScreenProps) {
  const { title, message, actions, fullWindow } = props;
  return (
    <div
      className={`${styles.screen} ${fullWindow ? styles.fullWindow : ""}`}
      role="alert"
      data-testid={props["data-testid"]}
    >
      {fullWindow && <div className="drag-region" />}
      <div className={styles.title}>{title}</div>
      {message && <div className={styles.message}>{message}</div>}
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
