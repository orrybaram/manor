import { Button } from "../../ui/Button/Button";
import { formatDateEyebrow } from "./format";
import styles from "./DashboardHeader.module.css";

type DashboardHeaderProps = {
  now: number;
  /** `headline()`'s two halves; `lead` is the clause about Needs you. */
  headline: { lead: string; rest: string };
  /** Whether anything needs the user — the lead turns red only then. */
  urgent: boolean;
  onNewAgent: () => void;
  onOpenTerminal: () => void;
  onOpenPalette: () => void;
};

/**
 * The dashboard header (ADR-198 §1.1): date eyebrow, the headline sentence,
 * and the New agent / Open terminal / Command palette buttons that replace
 * ADR-194's launcher rows.
 */
export function DashboardHeader(props: DashboardHeaderProps) {
  const { now, headline, urgent, onNewAgent, onOpenTerminal, onOpenPalette } = props;

  return (
    <header className={styles.header}>
      <div className={styles.text}>
        <div className={styles.date}>{formatDateEyebrow(now)}</div>
        <h1 className={styles.headline}>
          <span className={urgent ? styles.lead : undefined}>{headline.lead}</span>{" "}
          {headline.rest}
        </h1>
      </div>
      <div className={styles.actions}>
        <Button variant="secondary" className={styles.button} onClick={onOpenPalette}>
          Command palette <kbd className={styles.kbd}>⌘K</kbd>
        </Button>
        <Button variant="secondary" className={styles.button} onClick={onOpenTerminal}>
          Open terminal <kbd className={styles.kbd}>⌘T</kbd>
        </Button>
        <Button variant="primary" className={styles.button} onClick={onNewAgent}>
          New agent <kbd className={styles.kbd}>⌘N</kbd>
        </Button>
      </div>
    </header>
  );
}
